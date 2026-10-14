import { readFileSync, writeFileSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { Revisions } from './revisions.js';
import { Runtime } from './runtime.js';
import { Skills } from './skills.js';
import { Schedules } from './schedules.js';
import { Progress } from './progress.js';
import { normalizeMessageContent,jidNormalizedUser } from 'baileys';
import { discordReplyToBot,whatsappReplyToBot,markWhatsappReplyInvoked } from './reply-triggers.js';
import { taskDirectory } from './engine.js';
import { loadRedactions, redact, redactValue } from './redact.js';

process.umask(0o077);
const config=loadConfig();
loadRedactions(join(config.secretsDir,'credentials.json'));loadRedactions(join(config.codexHome,'auth.json'));
const store=new Store(config.dataDir);store.recover();
const source=resolve(process.env.RAJESH_SOURCE??'.');
if(process.env.RAJESH_CONFIG&&resolve(process.env.RAJESH_CONFIG)!==join(source,'config.json'))throw new Error('The supervisor must use config.json in its source directory');
const bootstrap=['main.ts','runtime.ts','revisions.ts'].map(name=>[name,readFileSync(join(source,'src',name),'utf8')] as const);
const restartRequired=()=>bootstrap.filter(([name,text])=>!existsSync(join(source,'src',name))||readFileSync(join(source,'src',name),'utf8')!==text).map(([name])=>name);
const revisions=new Revisions(source,config,value=>store.meta('runtime',redactValue(value)));
const runtime=new Runtime(revisions,store);
const skills=Object.fromEntries(Object.keys(config.workspaces).map(name=>[name,new Skills(join(config.dataDir,'skills',name))]));
const schedules=new Schedules(store,config.timezone);
const progress=new Progress(store);runtime.progress=progress;
const first=await runtime.latest();
for(const row of store.db.prepare('SELECT * FROM tasks').all())runtime.bind(row as any,first);
const initial=await runtime.load(first);runtime.currentConfig=initial.config;
const discord=new initial.discord.DiscordAdapter(initial.config,store,runtime.facade(first));
const whatsapp=new initial.whatsapp.WhatsAppAdapter(initial.config,store,runtime.facade(first));
progress.clients=discord.clients;progress.socket=()=>whatsapp.socket;
const adapters=new Map<string,Promise<{discord:any;whatsapp:any}>>();
async function adaptersFor(revision:typeof first) {
  let promise=adapters.get(revision.id);
  if(!promise){promise=(async()=>{
    const modules=await runtime.load(revision);
    const d=new modules.discord.DiscordAdapter(modules.config,modules.store,runtime.facade(revision));d.clients=discord.clients;
    const w=new modules.whatsapp.WhatsAppAdapter(modules.config,modules.store,runtime.facade(revision));
    return {discord:d,whatsapp:w};
  })();adapters.set(revision.id,promise);}
  const pair=await promise;pair.whatsapp.socket=whatsapp.socket;return pair;
}
// Bootstrap owns connections; adapters update immediately and engines update between turns.
discord.receive=async(account:string,m:any)=>{
  const client=discord.clients.get(account);
  if(client?.user&&await discordReplyToBot(m,client.user.id))m.mentions.users.set(client.user.id,client.user);
  const revision=await runtime.forTask(`discord:${account}:${m.channel.isThread()?m.channelId:m.id}`);
  await(await adaptersFor(revision)).discord.receive(account,m);
};
discord.record=async(account:string,m:any)=>{
  const revision=await runtime.forTask(`discord:${account}:${m.channelId}`);
  return(await adaptersFor(revision)).discord.record(account,m);
};
whatsapp.receive=async(m:any,live:boolean)=>{
  const group=m.key.remoteJid;
  const key=store.meta(`waConversation:${group}`)??`whatsapp:${group}`;
  const content=normalizeMessageContent(m.message);
  const command=(content?.conversation??content?.extendedTextMessage?.text??'').replace(/@\d+/g,'').trim();
  const reset=live&&!m.key.fromMe&&group===config.whatsappGroup&&command==='/new';
  const pair=await adaptersFor(reset?await runtime.latest():await runtime.forTask(key));
  const self=[whatsapp.socket?.user?.id,whatsapp.socket?.user?.lid].filter(Boolean).map((id:string)=>jidNormalizedUser(id));
  if(live&&!m.key.fromMe&&group===config.whatsappGroup&&self.length&&whatsappReplyToBot(m,self,store)) {
    await pair.whatsapp.receive(m,false); // Archive the original message before adapting the invocation signal.
    markWhatsappReplyInvoked(m,self[0]);
  }
  if(live&&!m.key.fromMe&&group===config.whatsappGroup&&m.key.id&&/^\/(?:models?|status|stop)(?:\s|$)/.test(command)) {
    await pair.whatsapp.receive(m,false);
    const receipt=`wa-model:${m.key.id}`;
    if(store.meta(receipt))return;
    const task=store.task(key)??{key,workspace:config.whatsappWorkspace!,platform:'whatsapp' as const,account:config.whatsappAccount!,channel:group,parent:group,model:config.whatsappModel!,effort:config.whatsappEffort!,thread:null,cwd:taskDirectory(config,key),status:'queued'};
    if(!store.task(key))store.saveTask(task);
    await runtime.facade(await runtime.forTask(key)).command(task,command,m.key.id);
    store.meta(receipt,true);return;
  }
  pair.whatsapp.newConversation=async(task:any,message:string)=>{
    const latest=await runtime.latest();runtime.bind(task,latest);
    await runtime.facade(latest).tell(task,'Started a new conversation using the latest validated runtime.',`new:${message}`);
  };
  await pair.whatsapp.receive(m,live);
};
const outgoing=new Engine(config,store);
outgoing.sender=async(task,text,id)=>{
  const send=async(task:any,text:string,id:string)=>{const pair=await adaptersFor(await runtime.forTask(task.key));return task.platform==='discord'?pair.discord.send(task,text,id):pair.whatsapp.send(task,text,id);};
  if(store.meta(`scheduleRun:${task.key}`))return schedules.deliver(task,text,id,send);
  if(task.platform==='discord'&&id.startsWith('codex:'))return progress.final(task,text,id);
  return send(task,text,id);
};
const socketPath=join(revisions.base,'control.sock');
if(existsSync(socketPath))unlinkSync(socketPath);
const control=createServer(async(req,res)=>{
  try {
    let body='';for await(const chunk of req){body+=chunk;if(body.length>100000)throw new Error('Request too large');}
    const input=JSON.parse(body);if(!store.task(input.task))throw new Error('Unknown task');
    let result:unknown;
    if(input.action==='skills') {
      const library=skills[store.task(input.task)!.workspace],args=input.input;
      if(args.action==='list')result=library.list(args.query);
      else if(args.action==='read')result=library.read(args.name);
      else if(args.action==='write')result=library.write(args.name,args.description,args.instructions,args.revision);
      else throw new Error('Unknown skills action');
    }
    else if(input.action==='schedule')result=schedules.command(store.task(input.task)!,input.input);
    else if(input.action==='status')result={...store.meta('runtime'),binding:runtime.binding(input.task),execution:runtime.execution(input.task),policy:'latest-between-turns',sharedRuntime:store.meta('sharedRuntime'),source,active:runtime.active,restartRequired:restartRequired()};
    else if(input.action==='prepare')result=revisions.prepare(input.task);
    else if(input.action==='publish')result=await revisions.publish(input.task,input.path);
    else throw new Error('Unknown runtime action');
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
  }catch(e:any){res.statusCode=400;res.end(JSON.stringify({error:redact(e.message)}));}
});
await new Promise<void>(resolve=>control.listen(socketPath,()=>{chmodSync(socketPath,0o600);resolve();}));
const secrets=existsSync(join(config.secretsDir,'credentials.json'))?JSON.parse(readFileSync(join(config.secretsDir,'credentials.json'),'utf8')):{discord:{}};
await discord.start(secrets.discord ?? {});if(config.whatsappGroup)whatsapp.start();
async function registerModels(revision:typeof first) {
  const modules=await runtime.load(revision);
  for(const [account,client] of discord.clients as Map<string,any>) {
    if(client.isReady())await new modules.models.ModelCommands({...modules.config,routes:modules.config.routes.filter((r:any)=>r.account===account)},store).register(client);
  }
}
for(const [account,client] of discord.clients as Map<string,any>) {
  client.on('interactionCreate',(i:any)=>{void (async()=>{
    if(!i.isChatInputCommand())return;
    await i.deferReply({flags:64}); // Publication validation may exceed Discord's acknowledgement deadline.
    const modules=await runtime.load(await runtime.latest());
    const taskKey=i.channel?.isThread()?`discord:${account}:${i.channelId}`:undefined;
    const engine=taskKey&&store.task(taskKey)?await runtime.get(store.task(taskKey)!):undefined;
    await new modules.models.ModelCommands({...modules.config,codex:engine?.config.codex??modules.config.codex},store).interaction(account,i,(key:string)=>runtime.stopTask(key));
  })().catch(async e=>{console.error('model_command_failed',redact(e.message));if(i.deferred)await i.editReply('Could not load or change the model. Please retry.').catch(()=>{});});});
  if(!client.isReady())client.once('clientReady',()=>{void runtime.latest().then(registerModels).catch(e=>console.error('model_registration_failed',redact(e.message)));});
}
let registeredRevision='';
let refreshing=false;
const watcher=setInterval(()=>{
  if(refreshing)return;refreshing=true;
  void runtime.latest().then(async revision=>{
    const modules=await runtime.load(revision);runtime.currentConfig=modules.config;discord.config=modules.config;
    if(registeredRevision!==revision.id){await registerModels(revision);registeredRevision=revision.id;}
  }).catch(e=>store.meta('runtimeFailure',{error:redact(e.message),time:Date.now()})).finally(()=>{refreshing=false;});
},2000);
const tick=setInterval(()=>{
  try{schedules.tick();}catch(e:any){store.meta('scheduleFailure',{error:redact(e.message),time:Date.now()});}
  void runtime.drain();void outgoing.flushDeliveries();void progress.flush();store.flushArchive();
  writeFileSync(join(config.dataDir,'health.json'),JSON.stringify({time:new Date().toISOString(),pid:process.pid,active:runtime.active,queued:store.pending().length,runtime:store.meta('runtime'),restartRequired:restartRequired(),sharedRuntime:store.meta('sharedRuntime'),discord:Object.fromEntries([...discord.clients.keys()].map(account=>[account,store.meta(`discord:${account}`)])),whatsapp:store.meta('whatsapp')},null,2));
},2000);
const compression=setInterval(()=>store.compress(),60000);
const inbox=setInterval(()=>{void discord.retryInbox();whatsapp.retryInbox();},15000);
let stopping=false;
async function stop(){if(stopping)return;stopping=true;clearInterval(tick);clearInterval(watcher);clearInterval(compression);clearInterval(inbox);control.close();discord.close();whatsapp.close();await runtime.shutdown();while(store.flushArchive()){}for(const library of Object.values(skills))library.lock.close();store.close();process.exit(0);}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
process.on('unhandledRejection',e=>console.error('unhandled_rejection',redact(String(e))));
console.log('service_started',first.id);
