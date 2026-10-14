import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Config } from './config.js';
import { Engine } from './engine.js';
import { Store, type Task } from './store.js';
import { Revisions, atomicJson, fingerprint, type Revision } from './revisions.js';
import { redactValue } from './redact.js';
import { forceStop } from './stop.js';

interface Binding {revision:string;configPath:string}
export class Runtime {
  engines=new Map<string,Engine>();
  modules=new Map<string,Promise<any>>();
  creating=new Map<string,Promise<Engine>>();
  draining=false;stopping=false;
  progress?:{seen(task:Task,message:string):void;event(task:Task,kind:string,item?:any):void;flush():Promise<void>;captureFinal?(task:Task,text:string,id:string):void};
  constructor(public revisions:Revisions,public store:Store) {
    store.db.exec('CREATE TABLE IF NOT EXISTS runtime_bindings (task TEXT PRIMARY KEY, revision TEXT NOT NULL, configPath TEXT NOT NULL)');
    store.db.exec('CREATE TABLE IF NOT EXISTS runtime_executions (task TEXT PRIMARY KEY, revision TEXT NOT NULL, configPath TEXT NOT NULL)');
  }
  binding(task:string):Binding|undefined {return this.store.db.prepare('SELECT revision,configPath FROM runtime_bindings WHERE task=?').get(task) as unknown as Binding|undefined;}
  execution(task:string):Binding|undefined {return this.store.db.prepare('SELECT revision,configPath FROM runtime_executions WHERE task=?').get(task) as unknown as Binding|undefined;}
  async latest(){try{return await this.revisions.refresh();}catch(e){if(this.revisions.current)return this.revisions.current;throw e;}}
  revision(id:string):Revision {return {id,path:join(this.revisions.base,'revisions',id),published:0};}
  async load(revision:Revision) {
    let promise=this.modules.get(revision.id);
    if(!promise) {
      promise=(async()=>{
        if(fingerprint(revision.path)!==revision.id)throw new Error('Saved runtime revision was modified; restore it before resuming its conversations');
        const module=(name:string)=>import(pathToFileURL(join(revision.path,'src',name+'.ts')).href);
        const [engine,discord,whatsapp,models,redaction,storage]=await Promise.all([module('engine'),module('discord'),module('whatsapp'),module('models'),module('redact'),module('store')]);
        const config=JSON.parse(readFileSync(join(revision.path,'config.json'),'utf8')) as Config;
        redaction.loadRedactions(join(config.secretsDir,'credentials.json'));redaction.loadRedactions(join(config.codexHome,'auth.json'));
        return {engine,discord,whatsapp,models,config,store:new storage.Store(config.dataDir)};
      })();this.modules.set(revision.id,promise);
    }
    return promise;
  }
  bind(task:Task,revision:Revision) {
    const existing=this.binding(task.key);if(existing)return existing;
    const config=JSON.parse(readFileSync(join(revision.path,'config.json'),'utf8')) as Config;
    config.codex=realpathSync(config.codex);
    const name=Buffer.from(task.key).toString('base64url');
    const configPath=join(this.revisions.base,'bindings',name+'.json');
    config.runtime={source:this.revisions.source,revision:revision.id,configPath,loader:join(revision.path,'node_modules','tsx','dist','loader.mjs')};
    atomicJson(configPath,config);
    this.store.db.prepare('INSERT INTO runtime_bindings VALUES (?,?,?)').run(task.key,revision.id,configPath);
    return {revision:revision.id,configPath};
  }
  async get(task:Task,revision?:Revision):Promise<Engine> {
    const pending=this.creating.get(task.key);if(pending)return pending;
    const create=(async()=>{
      const latest=await this.latest();
      const prior=this.engines.get(task.key);
      // A running turn owns its engine until completion, including steering.
      if(prior?.running.size)return prior;
      if(prior&&prior.config.runtime?.revision===latest.id)return prior;
      const modules=await this.load(latest);
      // Keep the original binding as history; execution snapshots use new paths.
      this.bind(task,latest);
      const name=Buffer.from(task.key).toString('base64url');
      const configPath=join(this.revisions.base,'executions',name,latest.id+'.json');
      let config:Config;
      if(existsSync(configPath))config=JSON.parse(readFileSync(configPath,'utf8')) as Config;
      else {
        config={...modules.config,codex:realpathSync(modules.config.codex)};
        config.runtime={source:this.revisions.source,revision:latest.id,configPath,loader:join(latest.path,'node_modules','tsx','dist','loader.mjs')};
        atomicJson(configPath,config);
      }
      const engine:Engine=new modules.engine.Engine(config,modules.store);
      const tell=engine.tell.bind(engine);
      const commentary=new Set<string>();
      engine.tell=async(task,text,id)=>{if(id.startsWith('ack:')||id.startsWith('progress:')||commentary.delete(id))return;if(task.platform==='discord'&&!this.store.meta(`scheduleRun:${task.key}`)&&id.startsWith('codex:'))this.progress?.captureFinal?.(task,text,id);return tell(task,text,id);};
      const factory=engine.rpcFactory;
      engine.rpcFactory=(binary,args,env)=>{
        const scheduler=join(latest.path,'src','schedule-tools.ts');
        if(existsSync(scheduler))args=[...args,'-c',`mcp_servers.schedules.command=${JSON.stringify(process.execPath)}`,'-c',`mcp_servers.schedules.args=${JSON.stringify(['--import',join(latest.path,'node_modules','tsx','dist','loader.mjs'),scheduler])}`,'-c',`mcp_servers.schedules.env={ RAJESH_TASK = ${JSON.stringify(task.key)}, RAJESH_CONTROL = ${JSON.stringify(join(this.revisions.base,'control.sock'))} }`];
        const rpc=factory(binary,args,env);let ended=false;
        const request=rpc.request.bind(rpc);
        rpc.request=async(...params:Parameters<typeof rpc.request>)=>{if((rpc as any).stopped)throw new Error('Task stopped');const value=await request(...params);if((rpc as any).stopped)throw new Error('Task stopped');return value;};
        rpc.on('notification',(m:any)=>{
          Object.assign(m,redactValue(m));
          if(m.method==='item/completed'&&m.params.item?.type==='agentMessage'&&m.params.item.phase==='commentary')commentary.add(`codex:${task.key}:${m.params.item.id}`);
          if(this.store.meta(`scheduleRun:${task.key}`))return;
          if(m.method==='turn/started')this.progress?.event(task,'started',m.params.turn);
          if(m.method==='item/started'||m.method==='item/completed')this.progress?.event(task,'tool',{...m.params.item,status:m.params.item.status??(m.method==='item/completed'?'completed':'inProgress')});
          if(m.method==='turn/completed'){ended=true;this.progress?.event(task,m.params.turn.status);}
        });
        rpc.on('closed',()=>{if(!ended&&!(rpc as any).stopped&&!this.store.meta(`scheduleRun:${task.key}`))this.progress?.event(task,'failed');});return rpc;
      };
      engine.taskKey=task.key;
      // Retired engines may finish notifications but cannot start another turn.
      engine.canStart=()=>!this.stopping&&this.engines.get(task.key)===engine&&latest.id===this.revisions.current?.id&&this.active<this.concurrency;
      this.store.db.prepare('INSERT OR REPLACE INTO runtime_executions VALUES (?,?,?)').run(task.key,latest.id,configPath);
      this.engines.set(task.key,engine);return engine;
    })();this.creating.set(task.key,create);
    try{return await create;}finally{this.creating.delete(task.key);}
  }
  get active(){return [...this.engines.values()].reduce((n,e)=>n+e.running.size,0);}
  get concurrency(){return this.currentConfig?.concurrency??this.revisions.config.concurrency;}
  currentConfig?:Config;
  facade(revision:Revision):Engine {
    return {
      submit:async(task:Task,message:string,text:string,initial=false)=>{
        const engine=await this.get(task,revision);this.progress?.seen(task,message);await this.progress?.flush();
        await engine.submit(task,message,text,initial);if(engine.running.has(task.key)&&!this.store.meta(`scheduleRun:${task.key}`))this.progress?.event(task,'working');
      },
      command:async(task:Task,text:string,message:string)=>{
        const engine=await this.get(task,revision);
        if(text.trim()==='/stop'){await engine.tell(task,await this.stopTask(task.key),`stop:${message}`);return true;}
        if(/^\/(?:models?|status|ultrafast)(?:\s|$)/.test(text.trim())) {
          const modules=await this.load(await this.latest());
          const output=await new modules.models.ModelCommands(engine.config,this.store).run(text,task.key);
          if(output!==null){await engine.tell(task,output,`model-command:${task.key}:${message}`);return true;}
        }
        const modules=await this.load(await this.latest());
        const commands=new modules.engine.Engine(modules.config,modules.store);
        commands.running=engine.running;commands.canStart=()=>false;
        commands.tell=engine.tell.bind(engine);
        return commands.command(task,text,message);
      },
      tell:async(task:Task,text:string,id:string)=>(await this.get(task,revision)).tell(task,text,id),
    } as Engine;
  }
  async forTask(key:string) {
    // Adapters and commands update immediately, independently of active engines.
    return this.latest();
  }
  async drain() {
    if(this.draining||this.stopping)return;this.draining=true;
    try {for(const job of this.store.pending()){const task=this.store.task(job.task);if(task)await(await this.get(task)).drain();}}
    finally{this.draining=false;}
  }
  async stopTask(key:string) {
    for(const row of this.store.db.prepare("SELECT key FROM metadata WHERE key LIKE 'scheduleRun:%'").all()) {
      const run=this.store.meta(String(row.key));const child=String(row.key).slice('scheduleRun:'.length);
      if(run.origin===key&&this.store.db.prepare("SELECT id FROM jobs WHERE task=? AND state IN ('queued','running','steering')").get(child))await this.stopTask(child);
    }
    const task=this.store.task(key);if(!task)return 'No bot task in this conversation.';
    const engine=this.engines.get(key)??await this.creating.get(key);
    const active=engine?.running.get(key);
    if(active){
      active.closing=true;active.finishing=true;(active.rpc as any).stopped=true;
      active.rpc.fail?.(new Error('Task stopped'));
      active.rpc.removeAllListeners('notification');
      forceStop(active.rpc.child);
      engine!.finish(active);await active.serial.catch(()=>{});
    }
    this.store.db.prepare("UPDATE jobs SET state='cancelled' WHERE task=? AND state IN ('queued','running','steering')").run(key);
    task.status='interrupted';this.store.saveTask(task);if(!this.store.meta(`scheduleRun:${key}`))this.progress?.event(task,'interrupted');
    return 'Stopped this task and cancelled queued input. Send a new prompt here to continue.';
  }
  async shutdown(){this.stopping=true;await Promise.all([...this.engines.values()].map(e=>e.shutdown()));}
}
