import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Store, formatContext, type Task } from '../src/store.js';
import { routeFor, type Config } from '../src/config.js';
import { createWorktree } from '../src/worktree.js';
import { sqliteAuth, mentioned } from '../src/whatsapp.js';
import { BufferJSON, initAuthCreds } from 'baileys';
import { Engine } from '../src/engine.js';
import { splitMessage } from '../src/discord.js';
import { redactValue } from '../src/redact.js';

function setup(t:any) {
  const dir=mkdtempSync(join(tmpdir(),'rajesh-test-'));const store=new Store(dir);
  const cleanup:(()=>Promise<void>)[]=[];
  t.after(async()=>{for(const fn of cleanup)await fn();store.close();rmSync(dir,{recursive:true,force:true});});
  const config:Config={dataDir:dir,secretsDir:dir,codex:process.execPath,codexHome:dir,workspaces:{default:join(dir,'default'),secondary:join(dir,'secondary')},routes:[],whatsappGroup:'test@g.us',whatsappWorkspace:'secondary',whatsappAccount:'secondary',whatsappModel:'test-model',whatsappEffort:'low',concurrency:4};
  const task:Task={key:'test',workspace:'default',platform:'discord',account:'default',channel:'thread',parent:'channel',model:'test-model',effort:'low',thread:null,cwd:join(dir,'task'),status:'queued'};
  return {dir,store,config,task,cleanup};
}
test('message deduplication, surrounding context and compressed archive retain unmentioned chat',t=>{
  const {store,dir}=setup(t);
  for(let n=0;n<4;n++)assert.equal(store.record({id:String(n),platform:'discord',workspace:'default',channel:'channel',author:'user',text:n===2?'income rose this month':'ordinary conversation',time:100000+n,bot:false}),true);
  assert.equal(store.record({id:'2',platform:'discord',workspace:'default',channel:'channel',author:'user',text:'duplicate',time:100002,bot:false}),false);
  assert.equal(store.context('default','channel','2',2).length,3);
  assert.match(formatContext(store.recent('default','channel')),/income rose/);
  store.flushArchive();store.compress();
  const folder=join(dir,'archive','default','channel');
  const text=gunzipSync(readFileSync(join(folder,readdirSync(folder)[0]))).toString();
  assert.equal(text.trim().split('\n').length,4);assert.match(text,/income rose/);
});
test('redacting quoted authorization examples never corrupts JSON records',t=>{
  const {store}=setup(t);
  const text='Header "Authorization: Bearer sensitive-value" URL\n{"access_token":"secret-value"}';
  store.record({id:'redact',platform:'discord',workspace:'default',channel:'channel',author:'user',text,time:1,bot:false});
  const saved=store.recent('default','channel')[0];assert.ok(!saved.text.includes('sensitive-value'));assert.ok(!saved.text.includes('secret-value'));
  assert.deepEqual(redactValue({access_token:'abc',other:'fine'}),{access_token:'[REDACTED]',other:'fine'});store.flushArchive();
});
test('recovery never requeues uncertain running work or outgoing messages',t=>{
  const {store,task}=setup(t);store.saveTask(task);store.enqueue(task.key,'msg','prompt');store.jobState(1,'running');
  store.db.prepare("INSERT INTO deliveries VALUES ('delivery','test','hello','sending',NULL)").run();
  store.recover();assert.equal(store.pending().length,0);
  assert.equal(store.db.prepare('SELECT state FROM jobs').get()!.state,'interrupted');
  assert.equal(store.db.prepare('SELECT state FROM deliveries').get()!.state,'uncertain');
});
test('WhatsApp imports and persists binary session keys transactionally',async t=>{
  const {dir,store}=setup(t);const folder=join(dir,'auth');mkdirSync(folder);
  writeFileSync(join(folder,'creds.json'),JSON.stringify(initAuthCreds(),BufferJSON.replacer));
  let auth=sqliteAuth(store,folder);
  await auth.state.keys.set({'pre-key':{'123':{private:Buffer.from('private'),public:Buffer.from('public')}}});
  auth=sqliteAuth(store,folder);const keys=await auth.state.keys.get('pre-key',['123']);
  assert.equal(Buffer.from(keys['123'].private).toString(),'private');
  await auth.state.keys.set({'pre-key':{'123':null}});assert.equal((await auth.state.keys.get('pre-key',['123']))['123'],undefined);
});
test('WhatsApp mentions normalize device IDs and do not trigger on ordinary text',()=>{
  assert.equal(mentioned({message:{extendedTextMessage:{text:'thoughts?',contextInfo:{mentionedJid:['123:4@s.whatsapp.net']}}}} as any,['123@s.whatsapp.net']),true);
  assert.equal(mentioned({message:{conversation:'@rajesh'}} as any,['123@s.whatsapp.net']),false);
});
test('worktrees isolate parallel tasks and reject a project outside its workspace',t=>{
  const {config,dir}=setup(t);const repo=config.workspaces.default;mkdirSync(repo);
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'});
  git('init');git('config','user.email','test@example.com');git('config','user.name','Test');writeFileSync(join(repo,'file.txt'),'base');git('add','.');git('commit','-m','initial');
  const a=createWorktree(config,'default','a',repo),b=createWorktree(config,'default','b',repo);
  writeFileSync(join(a.path,'file.txt'),'changed');assert.equal(readFileSync(join(repo,'file.txt'),'utf8'),'base');assert.equal(readFileSync(join(b.path,'file.txt'),'utf8'),'base');
  assert.equal(createWorktree(config,'default','a',repo).reused,true);
  assert.throws(()=>createWorktree(config,'default','c',dir),/inside/);
});
test('cleaned worktrees reopen their retained branch and ignore missing registrations',t=>{
  const {config}=setup(t);const repo=config.workspaces.default;mkdirSync(repo);
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'});
  git('init');git('config','user.email','test@example.com');git('config','user.name','Test');
  writeFileSync(join(repo,'file.txt'),'base');git('add','.');git('commit','-m','initial');
  const a=createWorktree(config,'default','a',repo);
  writeFileSync(join(a.path,'file.txt'),'task work');
  execFileSync('git',['-C',a.path,'commit','-am','task commit']);
  const taskHead=execFileSync('git',['-C',a.path,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
  git('worktree','remove',a.path);
  writeFileSync(join(repo,'file.txt'),'new base');git('commit','-am','base moved');
  const reopened=createWorktree(config,'default','a',repo);
  assert.equal(readFileSync(join(reopened.path,'file.txt'),'utf8'),'task work');
  assert.equal(execFileSync('git',['-C',reopened.path,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),taskHead);
  const stale=createWorktree(config,'default','stale',repo);rmSync(stale.path,{recursive:true,force:true});
  assert.equal(createWorktree(config,'default','a',repo).reused,true);
});
class FakeRpc extends EventEmitter {
  calls:any[]=[];turn='turn';failSteer=false;
  async initialize(){}
  async request(method:string,params:any){this.calls.push({method,params});
    if(method==='thread/start'||method==='thread/resume')return {thread:{id:'conversation'}};
    if(method==='turn/start')return {turn:{id:this.turn}};
    if(method==='turn/steer'&&this.failSteer)throw new Error('no active turn');
    return {};
  }
  close(){} respond(){} reject(){}
  complete(){this.emit('notification',{method:'turn/completed',params:{threadId:'conversation',turn:{id:this.turn,status:'completed'}}});}
}
const settle=()=>new Promise(r=>setTimeout(r,30));
test('thread replies steer, duplicate input executes once, and idle replies resume',async t=>{
  const {config,store,task,cleanup}=setup(t);const rpcs:FakeRpc[]=[];
  const engine=new Engine(config,store,()=>{const rpc=new FakeRpc();rpcs.push(rpc);return rpc as any;});engine.sender=async()=> 'sent';cleanup.push(()=>engine.shutdown());
  await engine.submit(task,'first','start',true);await settle();
  await engine.submit(task,'second','change direction');await settle();
  await engine.submit(task,'second','duplicate');await settle();
  assert.equal(rpcs[0].calls.filter(c=>c.method==='turn/start').length,1);assert.equal(rpcs[0].calls.find(c=>c.method==='thread/start').params.sandbox,'workspace-write');
  assert.equal(rpcs[0].calls.filter(c=>c.method==='turn/steer').length,1);
  rpcs[0].complete();await settle();await engine.submit(task,'third','follow up');await settle();
  assert.equal(rpcs[1].calls[0].method,'thread/resume');assert.equal(store.task(task.key)!.thread,'conversation');
});
test('completion race queues a follow-up once as a new turn',async t=>{
  const {config,store,task,cleanup}=setup(t);const rpcs:FakeRpc[]=[];
  const engine=new Engine(config,store,()=>{const rpc=new FakeRpc();rpcs.push(rpc);return rpc as any;});engine.sender=async()=> 'sent';cleanup.push(()=>engine.shutdown());
  await engine.submit(task,'first','start');await settle();rpcs[0].failSteer=true;
  await engine.submit(task,'second','follow up');await settle();assert.equal(store.pending().length,1);
  rpcs[0].complete();await settle();assert.equal(rpcs.length,2);assert.equal(rpcs[1].calls.filter(c=>c.method==='turn/start').length,1);
});
test('completion during a slow acknowledgement does not leave a progress timer running',async t=>{
  const {config,store,task,cleanup}=setup(t);const rpc=new FakeRpc();
  const engine=new Engine(config,store,()=>rpc as any);cleanup.push(()=>engine.shutdown());
  let release!:()=>void;
  engine.sender=async()=>{await new Promise<void>(resolve=>{release=resolve;});return 'sent';};
  await engine.submit(task,'first','start');await settle();const active=engine.running.get(task.key)!;
  rpc.complete();await settle();release();await settle();
  assert.equal(active.timer,undefined);assert.equal(engine.running.size,0);
});
test('route selection prefers exact guild and replies respect length limits',()=>{
  const config={routes:[{account:'default',guild:'*',channel:'x',model:'a'},{account:'default',guild:'guild',channel:'x',model:'b'}]} as Config;
  assert.equal(routeFor(config,'default','guild','x')!.model,'b');assert.equal(routeFor(config,'secondary','guild','x'),undefined);
  const text='hello\n'.repeat(1000);assert.ok(splitMessage(text).every(s=>s.length<=1900));
});

test('speed preference applies on the next resumed turn and scheduled tasks inherit it',async t=>{
 const {config,store,task,cleanup}=setup(t),rpcs:FakeRpc[]=[];
 const engine=new Engine(config,store,()=>{const rpc=new FakeRpc();rpcs.push(rpc);return rpc as any;});engine.sender=async()=> 'sent';cleanup.push(()=>engine.shutdown());
 store.meta(`taskServiceTier:${task.key}`,'ultrafast');
 await engine.submit(task,'first','start');await settle();
 assert.equal(rpcs[0].calls.find(c=>c.method==='turn/start').params.serviceTier,'ultrafast');
 store.meta(`taskServiceTier:${task.key}`,'default');
 assert.equal(rpcs[0].calls.find(c=>c.method==='turn/start').params.serviceTier,'ultrafast');
 rpcs[0].complete();await settle();await engine.submit(task,'second','resume');await settle();
 assert.equal(rpcs[1].calls[0].method,'thread/resume');assert.equal(rpcs[1].calls.find(c=>c.method==='turn/start').params.serviceTier,'default');
 rpcs[1].complete();await settle();
 const scheduled={...store.task(task.key)!,key:'scheduled:speed',thread:null};
 store.meta(`scheduleRun:${scheduled.key}`,{origin:task.key});store.meta(`taskServiceTier:${task.key}`,'ultrafast');
 await engine.submit(scheduled,'scheduled','run');await settle();
 assert.equal(rpcs[2].calls.find(c=>c.method==='turn/start').params.serviceTier,'ultrafast');
});
