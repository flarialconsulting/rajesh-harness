import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import { Store, eventId, type Task } from './store.js';
import { redact } from './redact.js';
import {taskDetails} from './task-swarm.js';

export interface DispatchArgs {action:'start'|'status';request_id:string;title?:string;prompt?:string;model?:string;effort?:string;placement?:'current-channel'|'configured-channel';report_back?:boolean;source_message_id?:string;user_requested?:boolean}
export async function dispatchDiscord(config:Config,store:Store,source:Task,args:DispatchArgs,api?: (path:string,body?:unknown)=>Promise<any>) {
  const id=`discordDispatch:${source.key}:${args.request_id}`;
  let saved=store.meta(id);
  if(args.action==='status')return saved?{...saved,status:saved.task?store.task(saved.task)?.status:saved.status,result:saved.task?store.meta(`taskSpawn:${saved.task}`)?.result:undefined}:{status:'not_found'};
  if(!saved?.task&&args.user_requested!==true&&saved?.userRequested!==true)throw new Error('Only dispatch a new task when the user explicitly requests delegation; set user_requested:true for that request');
  const placement=args.placement??(source.platform==='discord'?'current-channel':'configured-channel');
  const sourceMessage=saved?.sourceMessage??args.source_message_id;
  if(args.source_message_id&&saved?.sourceMessage&&args.source_message_id!==saved.sourceMessage)throw new Error('Dispatch ID belongs to another source request');
  if(placement==='current-channel'&&source.platform!=='discord')throw new Error('Current-channel dispatch requires a Discord source');
  if(placement==='configured-channel'&&!config.taskDispatch)throw new Error('Configure taskDispatch before dispatching to a separate channel');
  const destination=placement==='current-channel'?source.parent:config.taskDispatch!.channel;
  const account=placement==='current-channel'?source.account:config.taskDispatch!.account;
  const route=config.routes.find(r=>r.workspace===source.workspace&&r.channel===destination&&r.account===account);
  if(!route)throw new Error('Destination channel route is not configured');
  if(!args.prompt?.trim()||!args.title?.trim())throw new Error('A title and prompt are required');
  const prompt=redact(args.prompt),title=redact(args.title).slice(0,90);
  const model=args.model??source.model,effort=args.effort??source.effort;
  const reportBack=args.report_back!==false;
  const legacyFingerprint=createHash('sha256').update(JSON.stringify({title,prompt,model,effort})).digest('hex');
  const fingerprint=createHash('sha256').update(JSON.stringify({title,prompt,model,effort,destination,account:route.account,reportBack})).digest('hex');
  if(saved&&saved.fingerprint!==(saved.version===2?fingerprint:legacyFingerprint))throw new Error('Request ID was already used for different task contents');
  if(saved?.status==='uncertain')throw new Error('Discord send outcome is uncertain; reconcile the starter message before retrying');
  if(saved?.task)return {...saved,status:store.task(saved.task)?.status};
  // Claim before external writes so simultaneous callers cannot create duplicate threads.
  store.transaction(()=>{
    const prior=store.meta(id);
    if(prior?.status==='creating'&&Date.now()-prior.updated<60000)throw new Error('Dispatch is already in progress; check status');
    if(prior?.status==='creating'&&!prior.message)throw new Error('Discord send outcome is uncertain; reconcile the starter message before retrying');
    saved={...prior,version:2,fingerprint,channel:destination,sourceMessage,userRequested:args.user_requested??prior?.userRequested,promptOffset:prior?.promptOffset??(prior?.message?1800:1500),status:'creating',updated:Date.now()};store.meta(id,saved);
  });
  let starterPending=false;
  try {
    if(!api){
      const credentials=JSON.parse(readFileSync(join(config.secretsDir,'credentials.json'),'utf8'));
      const token=credentials.discord[route.account];if(!token)throw new Error('Discord account is not configured');
      api=async(path,body)=>{
        const response=await fetch(`https://discord.com/api/v10${path}`,{method:body===undefined?'GET':'POST',headers:{Authorization:`Bot ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
        if(!response.ok)throw Object.assign(new Error(`Discord dispatch failed (HTTP ${response.status})`),{notSent:true});
        return response.json();
      };
    }
    const guild=route.guild!=='*'?route.guild:store.meta(`taskDetails:${source.key}`)?.guild??(await api(`/channels/${destination}`)).guild_id;
    if(!guild)throw new Error('Could not determine the destination guild');
    const sourceUrl=taskDetails(store,source,config).url;
    const label=source.platform==='discord'?'Discord':'WhatsApp';
    if(!saved.message){
      starterPending=true;
      const message=await api(`/channels/${destination}/messages`,{content:`Task dispatched from ${label}: ${title}${sourceUrl?`\nOrigin: ${sourceUrl}`:''}\n\n${prompt.slice(0,1500)}`,allowed_mentions:{parse:[]},nonce:BigInt('0x'+eventId(id).slice(0,15)).toString(),enforce_nonce:true});
      starterPending=false;saved.message=message.id;saved.updated=Date.now();store.meta(id,saved);
    }
    let thread;
    try{thread=await api(`/channels/${saved.message}`);}catch{}
    if(!thread?.id)thread=await api(`/channels/${destination}/messages/${saved.message}/threads`,{name:title,auto_archive_duration:1440});
    // Continue long descriptions in the thread without truncating the prompt.
    for(let offset=saved.promptOffset??(saved.version===2?1500:1800);offset<prompt.length;offset+=1800){
      await api(`/channels/${thread.id}/messages`,{content:prompt.slice(offset,offset+1800),allowed_mentions:{parse:[]},nonce:BigInt('0x'+eventId(`${id}:prompt:${offset}`).slice(0,15)).toString(),enforce_nonce:true});
      saved.promptOffset=offset+1800;store.meta(id,saved);
      saved.updated=Date.now();store.meta(id,saved);
    }
    const key=`discord:${route.account}:${thread.id}`;
    const url=`https://discord.com/channels/${guild}/${thread.id}`;
    const target:Task={key,workspace:source.workspace,platform:'discord',account:route.account,channel:thread.id,parent:destination,model,effort,thread:null,cwd:join(config.dataDir,'tasks',eventId(key).slice(0,24)),status:'queued'};
    store.transaction(()=>{
      if(!store.task(key))store.saveTask(target);
      store.meta(`taskDetails:${key}`,{title,summary:prompt.slice(0,2000),guild,url});
      store.meta(`taskSpawn:${key}`,{source:source.key,message:id,sourceMessage,title,url,reportBack,created:Date.now()});
      store.db.prepare("INSERT OR IGNORE INTO origins VALUES (?,?,'created')").run(`${route.account}:${saved.message}`,thread.id);
      store.enqueue(key,id,`Authorized task dispatched from ${label}. Report progress and the final result in this Discord thread. Originating task: ${source.key}${sourceUrl?` (${sourceUrl})`:''}. The initial terminal result is returned to the origin automatically; coordinate_tasks can send useful questions or evidence. Stay within the assigned scope.\n\n${prompt}`);
      saved={...saved,task:key,thread:thread.id,url,status:'queued',updated:Date.now()};store.meta(id,saved);
    });
    return saved;
  }catch(error){store.meta(id,{...saved,status:starterPending&&!(error as any).notSent?'uncertain':'failed',updated:Date.now()});throw error;}
}
