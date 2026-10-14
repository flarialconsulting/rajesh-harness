import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store,type Task } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { Progress } from '../src/progress.js';
import { WhatsAppAdapter } from '../src/whatsapp.js';
import { rememberFinalReply,sendDiscordFinal } from '../src/final-replies.js';
import type { Config } from '../src/config.js';

function setup(t:any,platform='discord') {
  const dir=mkdtempSync(join(tmpdir(),'final-replies-')),store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const task:Task={key:'task',workspace:'default',platform,account:'default',channel:platform==='discord'?'thread':'group@g.us',parent:'parent',model:'sol',effort:'high',thread:null,cwd:dir,status:'running'};
  store.saveTask(task);
  const config={dataDir:dir,concurrency:1} as Config;
  return {store,task,config};
}

test('only final agent items bind to the original job, even with queued or steering inputs',async t=>{
  const {store,task,config}=setup(t),engine=new Engine(config,store);
  for(const [n,message] of ['original','steering','queued'].entries()) {
    store.record({id:`discord:default:${message}`,platform:'discord',workspace:'default',channel:'parent',author:'Human (111111111111111111)',text:'prompt',time:n,bot:false});
    store.enqueue(task.key,`discord:default:${message}`,'prompt');
  }
  const active:any={task,jobs:[1,2],turnStarted:performance.now(),tools:new Map(),lastEvent:0};
  await engine.notification(active,{method:'item/completed',params:{item:{type:'agentMessage',phase:'commentary',id:'update',text:'Working'}}});
  assert.equal(store.meta('finalReply:codex:task:update'),undefined);
  await engine.notification(active,{method:'item/completed',params:{item:{type:'agentMessage',phase:'final_answer',id:'answer',text:'Done'}}});
  assert.deepEqual(store.meta('finalReply:codex:task:answer'),{channel:'parent',message:'original',user:'111111111111111111'});
  store.meta(`scheduleRun:${task.key}`,{origin:'task'});
  rememberFinalReply(store,task,'scheduled',1);
  assert.equal(store.meta('finalReply:scheduled'),undefined);
});

test('Discord sends a new notifying reply in the task thread, retires tools and preserves retry identity',async t=>{
  const {store,task}=setup(t),progress=new Progress(store),messages=new Map<string,any>(),channels:string[]=[],deleted:string[]=[];
  let sends=0;
  const channel={isSendable:()=>true,isThread:()=>false,
    send:async(p:any)=>{const id=String(++sends);messages.set(id,p);return{id};},
    messages:{edit:async(id:string,p:any)=>messages.set(id,p),delete:async(id:string)=>{deleted.push(id);messages.delete(id);}}};
  const client={isReady:()=>true,channels:{fetch:async(id:string)=>{channels.push(id);return channel;}}};
  progress.clients.set(task.account,client);
  progress.event(task,'started',{id:'turn'});
  progress.event(task,'tool',{id:'inspect',type:'commandExecution',command:'inspect'});
  await progress.flush();
  const id='codex:task:answer';store.meta(`finalReply:${id}`,{channel:task.channel,message:'prompt'});
  progress.captureFinal(task,'Done <@123456789012345678>',id);
  progress.event(task,'completed');
  assert.equal(await progress.final(task,'Done <@123456789012345678>',id),'2');
  assert.ok(channels.every(id=>id===task.channel));assert.deepEqual(deleted,['1']);
  assert.deepEqual(messages.get('2').reply,{messageReference:'prompt',failIfNotExists:false});
  assert.deepEqual(messages.get('2').allowedMentions,{parse:[],repliedUser:true});
  assert.equal(messages.get('2').enforceNonce,true);
  const restored=new Progress(store);restored.clients.set(task.account,client);
  assert.equal(await restored.final(task,'Done',id),'2');assert.equal(sends,2);
  const long='Long answer '.repeat(400);store.meta('finalReply:codex:long',{channel:task.channel,message:'prompt'});
  assert.equal(await restored.final(task,long,'codex:long'),'3');
  assert.equal(messages.get('3').files[0].attachment.toString(),long);
  assert.ok(messages.get('3').content.length<=2000);
});

test('parent-channel prompts get a final in the same task thread with only the author mentioned',async t=>{
  const {store,task}=setup(t),channels:string[]=[],payloads:any[]=[];
  const author='111111111111111111';let unarchived=0;
  const channel={guildId:'guild',archived:true,isSendable:()=>true,isThread:()=>true,
    setArchived:async(value:boolean)=>{assert.equal(value,false);unarchived++;channel.archived=false;},
    send:async(payload:any)=>{payloads.push(payload);return{id:String(payloads.length)};}};
  const clients=new Map([[task.account,{isReady:()=>true,channels:{fetch:async(id:string)=>{channels.push(id);assert.equal(id,task.channel);return channel;}}}]]);
  store.meta('finalReply:short',{channel:'parent',message:'prompt',user:author});
  await sendDiscordFinal(store,task,'Done <@123456789012345678>','short',clients);
  assert.equal(unarchived,1);assert.deepEqual(channels,[task.channel]);
  assert.equal(payloads[0].reply,undefined);
  assert.deepEqual(payloads[0].allowedMentions,{parse:[],users:[author]});
  assert.equal(payloads[0].content,`<@${author}> [Original prompt](https://discord.com/channels/guild/parent/prompt)\n\nDone <@123456789012345678>`);
  const long='x'.repeat(1950);store.meta('finalReply:long',{channel:'parent',message:'prompt',user:author});
  await sendDiscordFinal(store,task,long,'long',clients);
  assert.ok(payloads[1].content.length<=2000);assert.equal(payloads[1].files[0].attachment.toString(),long);
  await sendDiscordFinal(store,task,long,'long',clients);assert.equal(payloads.length,2);
});

test('unavailable task threads never redirect final answers to the parent channel',async t=>{
  const {store,task}=setup(t),channels:string[]=[];
  store.meta('finalReply:blocked',{channel:'parent',message:'prompt',user:'111111111111111111'});
  const clients=new Map([[task.account,{isReady:()=>true,channels:{fetch:async(id:string)=>{channels.push(id);return{isSendable:()=>false};}}}]]);
  await assert.rejects(sendDiscordFinal(store,task,'Done','blocked',clients),(error:any)=>error.notSent===true);
  assert.deepEqual(channels,[task.channel]);assert.equal(store.meta('finalReplySent:blocked'),undefined);
});

test('published progress handles an older running engine and waits for an in-flight tool edit',async t=>{
  const {store,task}=setup(t),progress=new Progress(store),payloads:any[]=[],deleted:string[]=[];
  const receipt='discord:default:original';
  store.record({id:receipt,platform:'discord',workspace:'default',channel:task.channel,author:'Human (111111111111111111)',text:'prompt',time:1,bot:false});
  store.enqueue(task.key,receipt,'prompt');store.jobState(1,'running');
  let block=false,release!:()=>void;
  const channel={isSendable:()=>true,isThread:()=>false,
    send:async(p:any)=>{payloads.push(p);return{id:String(payloads.length)};},
    messages:{edit:async()=>{if(block)await new Promise<void>(r=>release=r);},delete:async(id:string)=>{deleted.push(id);}}};
  progress.clients.set(task.account,{isReady:()=>true,channels:{fetch:async()=>channel}});
  progress.event(task,'started',{id:'old-engine-turn'});
  progress.event(task,'tool',{id:'inspect',type:'commandExecution',command:'inspect'});await progress.flush();
  block=true;progress.event(task,'working');const pending=progress.flush();
  while(!release)await new Promise(r=>setTimeout(r,1));
  const final=progress.final(task,'Published','codex:task:old-engine-answer');
  assert.equal(payloads.length,1);release();await pending;await final;
  assert.deepEqual(payloads[1].reply,{messageReference:'original',failIfNotExists:false});
  assert.deepEqual(deleted,['1']);
  progress.event(task,'completed');await progress.flush();assert.equal(payloads.length,2);
});

for(const participant of ['123:4@s.whatsapp.net','456@lid'])test(`WhatsApp final quotes the original prompt and mentions ${participant} once`,async t=>{
  const {store,task,config}=setup(t,'whatsapp'),engine=new Engine(config,store),sends:any[]=[];
  const raw={key:{id:'original',remoteJid:task.channel,participant,fromMe:false},message:{conversation:'Please fix it'}};
  store.record({id:`whatsapp:${task.channel}:original`,platform:'whatsapp',workspace:'default',channel:task.channel,author:'Human',text:'Please fix it',time:1,bot:false,raw});
  store.enqueue(task.key,`whatsapp:${task.channel}:original`,'prompt');
  const id='codex:task:answer';rememberFinalReply(store,task,id,1);
  const adapter=new WhatsAppAdapter(config,store,engine);store.meta('whatsapp',{ready:true});
  adapter.socket={sendMessage:async(channel:string,payload:any,options:any)=>{sends.push({channel,payload,options});return{key:{id:options.messageId}};}} as any;
  await adapter.send(task,'Done '.repeat(900),id);
  assert.equal(sends.length,2);
  const user=participant.replace(':4','');
  assert.deepEqual(sends[0].options.quoted,raw);
  assert.deepEqual(sends[0].payload.mentions,[user]);
  assert.ok(sends[0].payload.text.startsWith(`@${user.split('@')[0]} `));
  assert.equal(sends[1].options.quoted,undefined);assert.deepEqual(sends[1].payload.mentions,[]);
  const messageId=sends[0].options.messageId;
  await adapter.send(task,'Done '.repeat(900),id);assert.equal(sends[2].options.messageId,messageId);
  await adapter.send(task,'Still working','update');
  assert.equal(sends.at(-1).options.quoted,undefined);assert.deepEqual(sends.at(-1).payload.mentions,[]);
});
