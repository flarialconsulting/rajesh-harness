import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { ModelCommands } from '../src/models.js';
import type { Config } from '../src/config.js';
function setup(t:any){
 const dir=mkdtempSync(join(tmpdir(),'models-test-')),store=new Store(dir);
 store.db.exec('CREATE TABLE runtime_bindings(task TEXT PRIMARY KEY,revision TEXT,configPath TEXT)');
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const config={codex:process.execPath,codexHome:dir,routes:[{account:'default',channel:'parent',guild:'guild',model:'luna',effort:'low'}]} as Config;
 const task:any={key:'task',workspace:'default',platform:'discord',account:'default',channel:'thread',parent:'parent',model:'luna',effort:'low',thread:'existing-conversation',cwd:dir,status:'done'};store.saveTask(task);
 const commands=new ModelCommands(config,store,()=>({initialize:async()=>{},request:async()=>({data:[{id:'luna',model:'luna',defaultReasoningEffort:'low',supportedReasoningEfforts:[{reasoningEffort:'low'}]},{id:'sol',model:'sol',defaultReasoningEffort:'high',supportedReasoningEfforts:[{reasoningEffort:'high'},{reasoningEffort:'xhigh'}]}],nextCursor:null}),close:()=>{}} as any));
 return {store,task,commands};
}
test('model commands validate exact models/reasoning and preserve the existing conversation',async t=>{
 const {store,commands}=setup(t);
 assert.match((await commands.run('/models','task'))!,/sol.*high/);
 assert.match((await commands.run('/model missing','task'))!,/Unavailable/);
 assert.match((await commands.run('/model sol low','task'))!,/Unsupported/);
 assert.equal(store.task('task')!.model,'luna');
 assert.match((await commands.run('/model sol xhigh','task'))!,/Model set/);
 assert.equal(store.task('task')!.model,'sol');assert.equal(store.task('task')!.effort,'xhigh');assert.equal(store.task('task')!.thread,'existing-conversation');
});
test('busy turns cannot change models, and channel defaults leave existing tasks unchanged',async t=>{
 const {store,commands}=setup(t);store.db.prepare("UPDATE tasks SET status='running'").run();
 assert.match((await commands.run('/model sol','task'))!,/Wait/);assert.equal(store.task('task')!.model,'luna');
 await commands.run('/model sol high',undefined,'modelDefault:discord:default:parent',{model:'luna',effort:'low'});
 assert.equal(store.meta('modelDefault:discord:default:parent').model,'sol');assert.equal(store.task('task')!.model,'luna');
});
test('status counts running and queued tasks and reports this chat model',async t=>{
 const {store,commands}=setup(t);store.db.prepare("UPDATE tasks SET status='running'").run();store.enqueue('task','pending','go');
 const status=await commands.run('/status','task');assert.match(status!,/Running tasks: 1/);assert.match(status!,/Queued tasks: 1/);assert.match(status!,/Model: luna \/ low/);
 assert.doesNotMatch(status!,/System:|CPU:|RAM:|Disk:|Uptime:/);
});
test('Discord slash commands reject unconfigured channels and defer configured requests',async t=>{
 const {commands}=setup(t);const replies:any[]=[];
 const i:any={isChatInputCommand:()=>true,commandName:'models',channelId:'other',guildId:'guild',channel:{isThread:()=>false},reply:async(v:any)=>replies.push(v),deferReply:async(v:any)=>replies.push(v),editReply:async(v:any)=>replies.push(v),options:{getString:()=>null}};
 await commands.interaction('default',i);assert.match(replies[0].content,/not enabled/);
 replies.length=0;i.channelId='parent';await commands.interaction('default',i);assert.equal(replies[0].flags,64);assert.match(replies[1],/Available models/);
});


test('Discord /stop is registered and targets only the current task thread',async t=>{
 const {commands,store,task}=setup(t);const registered:string[]=[];await commands.register({guilds:{fetch:async()=>({commands:{create:async(v:any)=>registered.push(v.name)}})}});assert.ok(registered.includes('stop'));
 task.key='discord:default:thread';store.saveTask(task);const stopped:string[]=[],replies:any[]=[];
 const i:any={isChatInputCommand:()=>true,commandName:'stop',channelId:'thread',guildId:'guild',channel:{isThread:()=>true,parentId:'parent'},deferReply:async()=>{},editReply:async(v:any)=>replies.push(v)};
 await commands.interaction('default',i,async key=>{stopped.push(key);return 'Stopped';});assert.deepEqual(stopped,[task.key]);assert.equal(replies[0],'Stopped');
});

test('model discovery follows current execution snapshots rather than the original chat binding',async t=>{
 const {store,task,commands}=setup(t);
 const original=join(task.cwd,'original.json'),current=join(task.cwd,'current.json');
 writeFileSync(original,JSON.stringify({codex:'original-binary'}));writeFileSync(current,JSON.stringify({codex:'current-binary'}));
 store.db.prepare('INSERT INTO runtime_bindings VALUES (?,?,?)').run(task.key,'original',original);
 store.db.exec('CREATE TABLE runtime_executions(task TEXT PRIMARY KEY,revision TEXT,configPath TEXT)');
 store.db.prepare('INSERT INTO runtime_executions VALUES (?,?,?)').run(task.key,'current',current);
 let selected='';commands.factory=binary=>{selected=binary;return {initialize:async()=>{},request:async()=>({data:[],nextCursor:null}),close:()=>{}} as any;};
 await commands.list(task.key);assert.equal(selected,'current-binary');
});

test('already acknowledged Discord commands do not defer again during patch loading',async t=>{
 const {commands}=setup(t),replies:string[]=[];
 const i:any={isChatInputCommand:()=>true,deferred:true,commandName:'models',channelId:'parent',guildId:'guild',channel:{isThread:()=>false},deferReply:async()=>{throw new Error('Deferred twice');},editReply:async(v:string)=>replies.push(v),options:{getString:()=>null}};
 await commands.interaction('default',i);assert.match(replies[0],/Available models/);
 i.channelId='disabled';await commands.interaction('default',i);assert.match(replies[1],/not enabled/);
 i.commandName='removed';await commands.interaction('default',i);assert.match(replies[2],/unavailable/);
});


test('ultrafast validates model capabilities, preserves model/reasoning, and saves the next-turn preference',async t=>{
 const {store,task,commands}=setup(t);
 commands.list=async()=>[{id:'luna',model:'luna'},{id:'sol',model:'sol',serviceTiers:[{id:'ultrafast'}],supportedReasoningEfforts:[{reasoningEffort:'high'}],defaultReasoningEffort:'high'}];
 assert.match((await commands.run('/ultrafast',task.key))!,/unavailable.*luna/);
 assert.equal(store.meta(`taskServiceTier:${task.key}`),undefined);
 store.db.prepare("UPDATE tasks SET model='sol',effort='high',status='running' WHERE key=?").run(task.key);
 assert.match((await commands.run('/ultrafast',task.key))!,/enabled.*next turn/);
 assert.equal(store.meta(`taskServiceTier:${task.key}`),'ultrafast');
 assert.equal(store.task(task.key)!.model,'sol');assert.equal(store.task(task.key)!.effort,'high');assert.equal(store.task(task.key)!.thread,task.thread);
 for(const invalid of ['/ultrafast maybe','/ultrafast on extra'])assert.match((await commands.run(invalid,task.key))!,/Use \/ultrafast/);
 assert.equal(store.meta(`taskServiceTier:${task.key}`),'ultrafast');
 store.db.prepare("UPDATE tasks SET status='done' WHERE key=?").run(task.key);
 assert.match((await commands.run('/model luna low',task.key))!,/off before/);
 assert.equal(store.task(task.key)!.model,'sol');
 assert.match((await commands.run('/status',task.key))!,/Service tier preference: ultrafast/);
 commands.list=async()=>{throw new Error('unavailable');};
 assert.match((await commands.run('/ultrafast off',task.key))!,/disabled/);
 assert.equal(store.meta(`taskServiceTier:${task.key}`),'default');
});

test('ultrafast refuses parent defaults and channel conversations',async t=>{
 const {store,commands,task}=setup(t),key='modelDefault:discord:default:parent';
 const current={model:'sol',effort:'high'};store.meta(key,current);
 for(const command of ['/ultrafast','/ultrafast off'])assert.match((await commands.run(command,undefined,key,current))!,/inside the task thread/);
 assert.deepEqual(store.meta(key),current);assert.equal(store.meta(`taskServiceTier:${task.key}`),undefined);
 task.channel=task.parent;store.saveTask(task);
 assert.match((await commands.run('/ultrafast',task.key))!,/inside the task thread/);
 assert.equal(store.meta(`taskServiceTier:${task.key}`),undefined);
});

test('Discord registers ultrafast with an optional boolean and targets threads and rejects parent channels',async t=>{
 const {commands,store,task}=setup(t),registered:any[]=[],replies:string[]=[];
 commands.list=async()=>[{id:'sol',model:'sol',serviceTiers:[{id:'ultrafast'}]}];
 await commands.register({guilds:{fetch:async()=>({commands:{create:async(v:any)=>registered.push(v)}})}});
 const command=registered.find(c=>c.name==='ultrafast');assert.equal(command.options[0].type,5);assert.equal(command.options[0].required,false);
 task.key='discord:default:thread';task.model='sol';store.saveTask(task);
 let enabled:boolean|null=null;
 const i:any={isChatInputCommand:()=>true,deferred:true,commandName:'ultrafast',channelId:'thread',guildId:'guild',channel:{isThread:()=>true,parentId:'parent'},editReply:async(v:string)=>replies.push(v),options:{getBoolean:(name:string)=>{assert.equal(name,'enabled');return enabled;}}};
 await commands.interaction('default',i);assert.equal(store.meta(`taskServiceTier:${task.key}`),'ultrafast');
 enabled=false;await commands.interaction('default',i);assert.equal(store.meta(`taskServiceTier:${task.key}`),'default');
 i.channelId='parent';i.channel={isThread:()=>false};
 store.meta('modelDefault:discord:default:parent',{model:'sol',effort:'high'});enabled=true;
 await commands.interaction('default',i);assert.match(replies.at(-1)!,/inside the task thread/);
 assert.deepEqual(store.meta('modelDefault:discord:default:parent'),{model:'sol',effort:'high'});
 assert.equal(store.meta(`taskServiceTier:${task.key}`),'default');
 i.channelId='disabled';await commands.interaction('default',i);assert.match(replies.at(-1)!,/not enabled/);
 i.channelId='unknown';i.channel={isThread:()=>true,parentId:'parent'};await commands.interaction('default',i);assert.match(replies.at(-1)!,/no bot conversation/);
});


test('ultrafast rechecks the selected model after asynchronous model discovery',async t=>{
 const {commands,store,task}=setup(t);
 store.db.prepare("UPDATE tasks SET model='sol' WHERE key=?").run(task.key);
 commands.list=async()=>{
  store.db.prepare("UPDATE tasks SET model='luna' WHERE key=?").run(task.key);
  return [{id:'sol',model:'sol',serviceTiers:[{id:'ultrafast'}]},{id:'luna',model:'luna'}];
 };
 assert.match((await commands.run('/ultrafast',task.key))!,/unavailable.*luna/);
 assert.equal(store.meta(`taskServiceTier:${task.key}`),undefined);
});
