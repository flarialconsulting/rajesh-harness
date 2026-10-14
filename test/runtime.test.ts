import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { Store, type Task } from '../src/store.js';
import { Revisions, fingerprint } from '../src/revisions.js';
import { Runtime } from '../src/runtime.js';
import type { Config } from '../src/config.js';

function fixture(t:any) {
  const root=mkdtempSync(join(tmpdir(),'runtime-test-')),source=join(root,'source'),data=join(root,'data');
  mkdirSync(join(source,'src'),{recursive:true});mkdirSync(join(source,'test'));
  const config:Config={dataDir:data,secretsDir:root,codex:process.execPath,codexHome:root,workspaces:{default:root,secondary:root},routes:[],whatsappGroup:'group@g.us',whatsappWorkspace:'secondary',whatsappAccount:'secondary',whatsappModel:'test-model',whatsappEffort:'low',concurrency:1};
  writeFileSync(join(source,'config.json'),JSON.stringify(config));
  for(const file of ['pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json'])writeFileSync(join(source,file),'{}');
  writeFileSync(join(source,'package.json'),JSON.stringify({type:'module'}));
  const engineUrl=pathToFileURL(fileURLToPath(new URL('../src/engine.ts',import.meta.url))).href;
  const storeUrl=pathToFileURL(fileURLToPath(new URL('../src/store.ts',import.meta.url))).href;
  const engine=(marker:string)=>`import {Engine as Base} from ${JSON.stringify(engineUrl)}; export class Engine extends Base {marker=${JSON.stringify(marker)}}`;
  writeFileSync(join(source,'src','engine.ts'),engine('A'));
  writeFileSync(join(source,'src','store.ts'),`export {Store} from ${JSON.stringify(storeUrl)}`);
  for(const [name,exported] of [['discord','DiscordAdapter'],['whatsapp','WhatsAppAdapter'],['models','ModelCommands']]) {
    const url=pathToFileURL(fileURLToPath(new URL('../src/'+name+'.ts',import.meta.url))).href;
    writeFileSync(join(source,'src',name+'.ts'),`export {${exported}} from ${JSON.stringify(url)}`);
  }
  writeFileSync(join(source,'src','redact.ts'),'export function loadRedactions(){}');
  const store=new Store(data),reports:any[]=[];
  const revisions=new Revisions(source,config,v=>reports.push(v));
  revisions.validate=async path=>{if(readFileSync(join(path,'src','engine.ts'),'utf8').includes('BROKEN'))throw new Error('invalid candidate');};
  const runtime=new Runtime(revisions,store);
  t.after(async()=>{await runtime.shutdown();for(const modules of runtime.modules.values())(await modules).store.close();store.close();rmSync(root,{recursive:true,force:true});});
  const task=(key:string):Task=>({key,workspace:'default',platform:'discord',account:'default',channel:key,parent:'channel',model:'model',effort:'low',thread:null,cwd:join(root,key),status:'queued'});
  return {root,source,config,store,revisions,runtime,task,engine,reports};
}
class FakeRpc extends EventEmitter {
  async initialize(){}
  async request(method:string){if(method.startsWith('thread/'))return {thread:{id:'conversation'}};return {turn:{id:'turn'}};}
  close(){}respond(){}reject(){}
  complete(){this.emit('notification',{method:'turn/completed',params:{turn:{id:'turn',status:'completed'}}});}
}
const settle=()=>new Promise(r=>setTimeout(r,40));

test('idle persistent chats adopt patches and restart on current code while preserving original bindings',async t=>{
  const f=fixture(t);const a=await f.runtime.latest(),old=f.task('old');
  old.thread='existing-history';old.effort='high';f.store.saveTask(old);
  const before=await f.runtime.get(old,a);assert.equal((before as any).marker,'A');
  const original=f.runtime.binding(old.key)!;const saved=readFileSync(original.configPath,'utf8');
  const newBinary=join(f.root,'new-codex');writeFileSync(newBinary,'placeholder');
  writeFileSync(join(f.source,'config.json'),JSON.stringify({...f.config,codex:newBinary,concurrency:2}));
  writeFileSync(join(f.source,'src','engine.ts'),f.engine('B'));
  const b=await f.runtime.latest();assert.notEqual(a.id,b.id);
  assert.equal((await f.runtime.forTask(old.key)).id,b.id);
  const [after,duplicate]=await Promise.all([f.runtime.get(old,a),f.runtime.get(old)]);
  assert.equal(after,duplicate);assert.notEqual(before,after);assert.equal((after as any).marker,'B');
  assert.equal(after.config.codex,newBinary);assert.equal(before.canStart(),false);
  assert.deepEqual({...f.store.task(old.key)},old);
  assert.deepEqual(f.runtime.binding(old.key),original);assert.equal(readFileSync(original.configPath,'utf8'),saved);
  assert.equal(f.runtime.execution(old.key)!.revision,b.id);
  const reconstructed=new Runtime(new Revisions(f.source,f.config,()=>{}),f.store);
  const resumed=await reconstructed.get(old);assert.equal((resumed as any).marker,'B');
  assert.equal(f.store.task(old.key)!.thread,'existing-history');assert.equal(resumed.config.codex,newBinary);
  await reconstructed.shutdown();for(const modules of reconstructed.modules.values())(await modules).store.close();
});

test('invalid edits retain last good revision, valid draft publishes, stale draft cannot overwrite it',async t=>{
  const f=fixture(t);const a=await f.runtime.latest();
  const first=f.revisions.prepare('task'),stale=f.revisions.prepare('task');
  writeFileSync(join(first.path,'src','engine.ts'),f.engine('B'));
  const b=await f.revisions.publish('task',first.path);assert.notEqual(a.id,b.id);assert.equal(fingerprint(f.source),b.id);
  await assert.rejects(f.revisions.publish('task',stale.path),/Stale/);
  writeFileSync(join(f.source,'src','engine.ts'),'BROKEN');
  assert.equal((await f.runtime.latest()).id,b.id);assert.equal(f.reports.at(-1).state,'rejected');
  const recovered=new Revisions(f.source,f.config,()=>{});assert.equal(recovered.current?.id,b.id);
});

test('published revisions get Git commits while private data and rejected source stay out of history',async t=>{
 const f=fixture(t),a=await f.runtime.latest();
 const git=(...args:string[])=>execFileSync('git',['-C',f.source,...args],{encoding:'utf8'}).trim();
 assert.equal(git('rev-parse','HEAD'),a.gitCommit);
 mkdirSync(join(f.source,'.secrets'));writeFileSync(join(f.source,'.secrets','token'),'private');
 mkdirSync(join(f.source,'storage'));writeFileSync(join(f.source,'storage','data'),'private');
 const draft=f.revisions.prepare('task');writeFileSync(join(draft.path,'src','engine.ts'),f.engine('B'));
 const b=await f.revisions.publish('task',draft.path);
 assert.equal(git('rev-parse','HEAD'),b.gitCommit);assert.notEqual(a.gitCommit,b.gitCommit);
 assert.equal(git('rev-parse','HEAD^'),a.gitCommit);
 assert.ok(git('show','HEAD:src/engine.ts').includes('"B"'));assert.ok(!git('ls-files').includes('.secrets'));assert.ok(!git('ls-files').includes('storage'));assert.ok(!git('ls-files').split('\n').includes('config.json'));assert.ok(readFileSync(join(b.path,'config.json'),'utf8').includes(f.config.dataDir));
 writeFileSync(join(f.source,'src','engine.ts'),'BROKEN');assert.equal((await f.runtime.latest()).id,b.id);assert.equal(git('rev-parse','HEAD'),b.gitCommit);
});

test('publication preserves staged human edits and rejects known credentials',async t=>{
 const f=fixture(t),a=await f.runtime.latest();const git=(...args:string[])=>execFileSync('git',['-C',f.source,...args],{encoding:'utf8'}).trim();
 writeFileSync(join(f.source,'src','engine.ts'),f.engine('B'));git('add','src/engine.ts');
 assert.equal((await f.runtime.latest()).id,a.id);assert.equal(git('diff','--cached','--name-only'),'src/engine.ts');assert.equal(git('rev-parse','HEAD'),a.gitCommit);
 git('reset','--','src/engine.ts');
 const credential='private-test-token-12345678901234567890';writeFileSync(join(f.root,'credentials.json'),JSON.stringify({token:credential}));
 writeFileSync(join(f.source,'src','engine.ts'),f.engine(credential));assert.equal((await f.runtime.latest()).id,a.id);assert.equal(git('rev-parse','HEAD'),a.gitCommit);
});

test('isolated engines share the global concurrency limit and active old turns survive publication',async t=>{
  const f=fixture(t);const a=await f.runtime.latest();const one=f.task('one'),two=f.task('two');f.store.saveTask(one);f.store.saveTask(two);
  const e1=await f.runtime.get(one,a),e2=await f.runtime.get(two,a),rpc1=new FakeRpc(),rpc2=new FakeRpc();
  e1.rpcFactory=()=>rpc1 as any;e2.rpcFactory=()=>rpc2 as any;
  await e1.submit(one,'one','go');await settle();await e2.submit(two,'two','go');await settle();
  assert.equal(f.runtime.active,1);assert.equal(e2.running.size,0);assert.equal(f.store.pending().length,1);
  writeFileSync(join(f.source,'src','engine.ts'),f.engine('B'));await f.runtime.latest();
  assert.equal(e1.running.size,1);assert.equal((e1 as any).marker,'A');
  rpc1.complete();await settle();
  const upgraded=await f.runtime.get(two);upgraded.rpcFactory=()=>rpc2 as any;
  await f.runtime.drain();await settle();assert.equal(e2.running.size,0);assert.equal(upgraded.running.size,1);assert.equal((upgraded as any).marker,'B');assert.equal(f.runtime.active,1);
});


test('/stop force-closes only its task, cancels queued input and allows a new prompt',async t=>{
 const f=fixture(t),revision=await f.runtime.latest(),one=f.task('one'),two=f.task('two');f.store.saveTask(one);f.store.saveTask(two);
 const e1=await f.runtime.get(one,revision),e2=await f.runtime.get(two,revision);let closed=0;
 const rpc=new FakeRpc();rpc.close=()=>{closed++;};e1.rpcFactory=()=>rpc as any;e2.rpcFactory=()=>new FakeRpc() as any;
 await e1.submit(one,'first','go');await settle();f.store.enqueue(one.key,'queued','do more');f.store.enqueue(two.key,'other','go');
 assert.match(await f.runtime.stopTask(one.key),/Stopped/);assert.equal(closed,1);assert.equal(e1.running.size,0);assert.equal(f.store.task(one.key)!.status,'interrupted');
 assert.ok(f.store.db.prepare('SELECT state FROM jobs WHERE task=?').all(one.key).every(r=>r.state==='cancelled'));
 assert.equal(f.store.db.prepare('SELECT state FROM jobs WHERE task=?').get(two.key)!.state,'queued');
 rpc.complete();await settle();assert.equal(f.store.task(one.key)!.status,'interrupted');
 e1.rpcFactory=()=>new FakeRpc() as any;await e1.submit(one,'new','try again');await settle();assert.equal(e1.running.size,1);assert.equal(f.store.task(one.key)!.thread,'conversation');
});

test('publication preserves active steering but queued turns resume history on the latest engine exactly once',async t=>{
  const f=fixture(t),a=await f.runtime.latest(),task=f.task('persistent');f.store.saveTask(task);
  const engine=await f.runtime.get(task,a),oldRpc=new FakeRpc();engine.rpcFactory=()=>oldRpc as any;
  await engine.submit(task,'first','go');await settle();
  writeFileSync(join(f.source,'src','engine.ts'),f.engine('B'));const b=await f.runtime.latest();
  assert.equal(await f.runtime.get(task),engine);
  assert.equal((await f.runtime.forTask(task.key)).id,b.id);
  await f.runtime.facade(a).submit(task,'steer','follow up');await settle();
  assert.equal(engine.running.get(task.key)!.jobs.length,2);
  f.store.enqueue(task.key,'queued','next turn');
  oldRpc.complete();await settle();
  assert.equal(engine.running.size,0);assert.equal(f.store.pending().length,1);
  assert.equal(engine.canStart(),false);
  const current=await f.runtime.get(task),calls:string[]=[];
  const rpc=new FakeRpc();rpc.request=async(method:string)=>{calls.push(method);return method.startsWith('thread/')?{thread:{id:'conversation'}}:{turn:{id:'turn'}};};
  current.rpcFactory=()=>rpc as any;
  await Promise.all([f.runtime.drain(),f.runtime.drain()]);await settle();
  assert.equal((current as any).marker,'B');assert.equal(calls[0],'thread/resume');
  assert.equal(calls.filter(c=>c==='turn/start').length,1);
  assert.equal(f.store.task(task.key)!.thread,'conversation');
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM jobs WHERE state='done'").get()!.n,2);
});

test('invalid publications leave existing chats and adapters on the last working revision',async t=>{
  const f=fixture(t),a=await f.runtime.latest(),task=f.task('unchanged');f.store.saveTask(task);
  const engine=await f.runtime.get(task);
  writeFileSync(join(f.source,'src','engine.ts'),'BROKEN');
  assert.equal((await f.runtime.forTask(task.key)).id,a.id);
  assert.equal(await f.runtime.get(task),engine);assert.equal(engine.canStart(),true);
  assert.equal(f.runtime.execution(task.key)!.revision,a.id);
});

for(const platform of ['whatsapp','discord'])test(`${platform} existing chats use new adapters and commands without clearing history`,async t=>{
  const f=fixture(t);
  f.config.routes=[{account:'default',workspace:'default',guild:'guild',channel:'channel',model:'model',effort:'low'}];
  writeFileSync(join(f.source,'config.json'),JSON.stringify(f.config));
  const task=f.task(platform==='discord'?'discord:default:persistent':'whatsapp:group@g.us');
  task.platform=platform;task.thread='existing-history';
  if(platform==='whatsapp'){task.channel=f.config.whatsappGroup;task.parent=f.config.whatsappGroup;}
  f.store.saveTask(task);await f.runtime.get(task);
  writeFileSync(join(f.source,'src','engine.ts'),f.engine('B'));const b=await f.runtime.latest();
  const modules=await f.runtime.load(await f.runtime.forTask(task.key));
  const facade=f.runtime.facade(b);
  if(platform==='whatsapp') {
    const adapter=new modules.whatsapp.WhatsAppAdapter(f.config,f.store,facade);
    adapter.socket={user:{id:'999@s.whatsapp.net'}};
    await adapter.receive({key:{id:'status',remoteJid:task.channel},message:{extendedTextMessage:{text:'/status',contextInfo:{mentionedJid:['999@s.whatsapp.net']}}}},true);
    assert.match(String(f.store.db.prepare('SELECT text FROM deliveries WHERE task=?').get(task.key)!.text),/Model: model/);
    assert.equal(f.store.pending().length,0);
  }else {
    const adapter=new modules.discord.DiscordAdapter(f.config,f.store,facade);
    adapter.clients.set('default',{user:{id:'bot'}});
    await adapter.receive('default',{id:'status',guildId:'guild',channelId:'persistent',content:'<@bot> /status',author:{id:'human',displayName:'Human',bot:false},createdTimestamp:1,mentions:{users:{has:()=>true}},attachments:new Map(),channel:{isThread:()=>true,parentId:'channel'}});
    assert.equal(f.store.pending().length,0);
    assert.match(String(f.store.db.prepare('SELECT text FROM deliveries WHERE task=?').get(task.key)!.text),/Model: model/);
  }
  assert.equal((await f.runtime.get(task) as any).marker,'B');
  assert.equal(f.store.task(task.key)!.thread,'existing-history');
  assert.equal(f.runtime.binding(task.key)!.revision===b.id,false);
});

test('new command code is available during an old active turn without replacing its engine',async t=>{
  const f=fixture(t),a=await f.runtime.latest(),task=f.task('active-command');f.store.saveTask(task);
  const engine=await f.runtime.get(task,a),rpc=new FakeRpc();engine.rpcFactory=()=>rpc as any;
  await engine.submit(task,'first','go');await settle();
  const updated=f.engine('B').slice(0,-1)+`; async command(task,text,id){if(text==='/patched'){await this.tell(task,this.running.has(task.key)?'patched while running':'patched',id);return true;}return super.command(task,text,id);} }`;
  writeFileSync(join(f.source,'src','engine.ts'),updated);await f.runtime.latest();
  assert.equal(await f.runtime.facade(a).command(task,'/patched','patched-command'),true);
  assert.equal(await f.runtime.get(task),engine);assert.equal(engine.running.size,1);
  assert.equal(f.store.db.prepare("SELECT text FROM deliveries WHERE id='patched-command'").get()!.text,'patched while running');
  assert.equal(f.store.task(task.key)!.thread,'conversation');
});

test('a validated source rollback applies between turns without rewriting chat state or snapshots',async t=>{
  const f=fixture(t),a=await f.runtime.latest(),task=f.task('rollback');task.thread='history';f.store.saveTask(task);
  await f.runtime.get(task);const original=f.runtime.binding(task.key)!;
  writeFileSync(join(f.source,'src','engine.ts'),f.engine('B'));await f.runtime.latest();
  const next=await f.runtime.get(task);assert.equal((next as any).marker,'B');
  const saved=readFileSync(f.runtime.execution(task.key)!.configPath,'utf8');
  writeFileSync(join(f.source,'src','engine.ts'),f.engine('A'));assert.equal((await f.runtime.latest()).id,a.id);
  assert.equal((await f.runtime.get(task) as any).marker,'A');assert.equal(next.canStart(),false);
  assert.equal(f.store.task(task.key)!.thread,'history');assert.deepEqual(f.runtime.binding(task.key),original);
  assert.equal(readFileSync(next.config.runtime!.configPath,'utf8'),saved);
});
