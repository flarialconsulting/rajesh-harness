import { Store, type Task, eventId } from './store.js';

export interface FinalReply { channel:string; message:string; user?:string; raw?:string }

export function rememberFinalReply(store:Store,task:Task,id:string,jobId:number) {
  if(store.meta(`finalReply:${id}`)||store.meta(`scheduleRun:${task.key}`))return;
  const job=store.db.prepare('SELECT message FROM jobs WHERE id=? AND task=?').get(jobId,task.key);
  if(!job)return;
  const source=task.platform==='discord'?`discord:${task.workspace}:${String(job.message).split(':').at(-1)}`:String(job.message);
  const row=store.db.prepare('SELECT channel,author,raw,bot FROM messages WHERE id=? AND platform=? AND workspace=?').get(source,task.platform,task.workspace);
  if(!row||row.bot)return;
  const target:FinalReply={channel:String(row.channel),message:source.split(':').at(-1)!};
  if(task.platform==='discord')target.user=String(row.author).match(/\((\d{17,20})\)$/)?.[1];
  else if(row.raw)target.raw=String(row.raw);
  store.meta(`finalReply:${id}`,target);
}

export async function sendDiscordFinal(store:Store,task:Task,text:string,id:string,clients:Map<string,any>) {
  const previous=store.meta(`finalReplySent:${id}`);
  if(previous)return previous as string;
  const target=store.meta(`finalReply:${id}`) as FinalReply;
  const client=clients.get(task.account);
  if(!client?.isReady())throw Object.assign(new Error('Discord is disconnected'),{notSent:true});
  const channel=await client.channels.fetch(task.channel);
  if(!channel?.isSendable())throw Object.assign(new Error('Discord channel is not sendable'),{notSent:true});
  if(channel.isThread()&&channel.archived)await channel.setArchived(false);
  const sameChannel=target.channel===task.channel;
  const user=target.user&&/^\d{17,20}$/.test(target.user)?target.user:undefined;
  // A parent-channel prompt cannot be referenced by a native reply in its thread.
  const link=!sameChannel&&channel.guildId?`[Original prompt](https://discord.com/channels/${channel.guildId}/${target.channel}/${target.message})`:'';
  const header=sameChannel?'':[user?`<@${user}>`:'',link].filter(Boolean).join(' ');
  const content=header?`${header}\n\n${text}`:text;
  const payload:any={content:content.length<=2000?content:content.slice(0,1900)+'\n\nFull response attached.',
    ...(sameChannel?{reply:{messageReference:target.message,failIfNotExists:false}}:{}),
    allowedMentions:sameChannel?{parse:[],repliedUser:true}:{parse:[],users:user?[user]:[]},
    nonce:BigInt('0x'+eventId(id,'final-reply').slice(0,15)).toString(),enforceNonce:true};
  if(content.length>2000)payload.files=[{attachment:Buffer.from(text),name:'response.md'}];
  const sent=await channel.send(payload);
  store.meta(`finalReplySent:${id}`,sent.id);
  return sent.id as string;
}
