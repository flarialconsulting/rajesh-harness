import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Store,type Task } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { Progress,renderTools } from '../src/progress.js';
import { WhatsAppAdapter } from '../src/whatsapp.js';
import { timing,latencyReport } from '../src/latency.js';

function fixture(t:any) {
  const dir=mkdtempSync(join(tmpdir(),'latency-test-')),store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const task:Task={key:'task',workspace:'default',platform:'discord',account:'default',channel:'thread',parent:'parent',model:'model',effort:'high',thread:null,cwd:dir,status:'queued'};
  store.saveTask(task);return {dir,store,task};
}
test('archive flush uses the pending-row index and preserves unexported payloads',t=>{
  const {store}=fixture(t);
  store.event('default','thread','old',{type:'test'},1);store.flushArchive();
  store.event('default','thread','new',{type:'test'});
  const plan=store.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM archive WHERE exported=0 ORDER BY time LIMIT 5000').all();
  assert.match(JSON.stringify(plan),/archive_unexported_time/);
  assert.equal(store.flushArchive(),1);assert.equal(store.flushArchive(),0);
  assert.equal(store.db.prepare('SELECT count(*) n FROM archive').get()!.n,2);
});
test('latency reports separate queue, startup, response and tools, deduplicate deltas and isolate workspaces',async t=>{
  const {store,task,dir}=fixture(t);
  const config:any={dataDir:dir,codex:process.execPath,codexHome:dir,workspaces:{default:dir},routes:[],concurrency:1};
  class Fake extends EventEmitter {
    async initialize(){}
    async request(method:string){return method.startsWith('thread/')?{thread:{id:'thread'}}:{turn:{id:'turn'}};}
    close(){}respond(){}reject(){}
  }
  const rpc=new Fake(),engine=new Engine(config,store,()=>rpc as any);engine.sender=async()=> 'sent';
  t.after(()=>engine.shutdown());
  engine.canStart=()=>false;await engine.submit(task,'message','private prompt');
  store.db.prepare('UPDATE jobs SET created=created-2000').run();
  engine.canStart=()=>true;await engine.drain();await new Promise(r=>setTimeout(r,15));
  const notify=(method:string,item?:any)=>rpc.emit('notification',{method,params:{threadId:'thread',item,turn:{id:'turn',status:'completed'}}});
  notify('item/started',{id:'input',type:'userMessage'});notify('item/completed',{id:'input',type:'userMessage'});
  notify('item/started',{id:'tool',type:'commandExecution',command:'private command'});
  notify('item/completed',{id:'tool',type:'commandExecution'});
  notify('item/agentMessage/delta');notify('item/agentMessage/delta');
  rpc.emit('diagnostic','connection_retry');notify('turn/completed');await new Promise(r=>setTimeout(r,15));
  const other={...task,key:'other',workspace:'secondary' as const};store.saveTask(other);timing(store,other,2,'queue_wait',999);
  const report=latencyReport(store,'default');
  for(const stage of ['queue_wait','initialize','thread_start','turn_start','first_event','first_response','tool','turn_total','rpc_diagnostic'])assert.ok(report.events.some(r=>r.stage===stage),stage);
  assert.ok(report.events.find(r=>r.stage==='queue_wait')!.ms>=2000);
  assert.equal(report.events.filter(r=>r.stage==='first_response').length,1);
  assert.equal(report.events.filter(r=>r.stage==='tool').length,1);
  assert.ok(report.events.every(r=>r.task==='task'));
  assert.ok(!JSON.stringify(report).includes('private'));
});
test('uncertain old panels back off while new answers are still delivered',async t=>{
  const {store,task}=fixture(t),progress=new Progress(store);let fetches=0,sends=0;
  const channel={isSendable:()=>true,isThread:()=>false,send:async()=>({id:String(++sends)}),messages:{fetch:async()=>{fetches++;return new Map();},edit:async()=>{}}};
  progress.clients.set('default',{user:{id:'bot'},isReady:()=>true,channels:{fetch:async()=>channel}});
  progress.event(task,'started',{id:'old'});const old=progress.panel(task);
  store.db.prepare('UPDATE progress_panels SET creating=1,dirty=1 WHERE task=?').run(old);
  await progress.flush();await progress.flush();assert.equal(fetches,1);
  progress.event(task,'started',{id:'new'});await progress.final(task,'Done','codex:final');
  assert.equal(sends,1);assert.equal(fetches,1);
  assert.match(renderTools([],0,'queued'),/Waiting for an available task slot/);
});

test('transport timing preserves unsent failures without retaining error text',async t=>{
  const {store,task}=fixture(t);const adapter=new WhatsAppAdapter({} as any,store,{} as any);
  await assert.rejects(adapter.send(task,'private message','test'),(e:any)=>e.notSent===true);
  const events=latencyReport(store,'default').events;
  assert.equal(events.length,1);assert.equal(events[0].stage,'whatsapp_delivery');
  assert.deepEqual(events[0].details,{status:'failed',notSent:true});
  assert.ok(!JSON.stringify(events).includes('private message'));
});

test('diagnostic write failures cannot interrupt task or delivery execution',t=>{
  const {task}=fixture(t);t.mock.method(console,'error',()=>{});
  const broken:any={db:{prepare:()=>{throw Error('unavailable');}}};
  assert.doesNotThrow(()=>timing(broken,task,null,'delivery',1));
  assert.doesNotThrow(()=>timing(broken,{} as Task,null,'delivery',1));
});
