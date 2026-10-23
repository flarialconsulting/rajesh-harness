import { timing } from './latency.js';
import { Client, GatewayIntentBits, Partials, ChannelType, type Message as DiscordMessage } from 'discord.js';
import type { Config, Workspace } from './config.js';
import { routeFor } from './config.js';
import { Store, type Task, eventId } from './store.js';
import { Engine, taskDirectory } from './engine.js';
import { decodeUpload } from './uploads.js';
import { discordAttachments } from './attachments.js';
import { redact } from './redact.js';


export {splitMessage} from './message-chunks.js';
import {splitMessage} from './message-chunks.js';

export class DiscordAdapter {
  clients=new Map<string,Client>(); locks=new Map<string,Promise<void>>();
  constructor(public config:Config,public store:Store,public engine:Engine){}
  async start(tokens:Record<string,string>) {
    for(const account of [...new Set(this.config.routes.map(r=>r.account))]) {
      const client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent],partials:[Partials.Channel,Partials.Message]});
      this.clients.set(account,client);
      client.on('error',()=>this.store.meta(`discord:${account}`,{ready:false,time:Date.now()}));
      client.on('shardDisconnect',()=>this.store.meta(`discord:${account}`,{ready:false,time:Date.now()}));
      client.on('messageCreate',m=>{
        const previous=this.locks.get(m.channelId)??Promise.resolve();
        const next=previous.then(()=>this.receive(account,m)).catch(e=>{console.error('discord_receive_failed',redact(e.message));});
        this.locks.set(m.channelId,next);void next.finally(()=>{if(this.locks.get(m.channelId)===next)this.locks.delete(m.channelId);});
      });
      client.on('messageUpdate',(_,m)=>{if(!m.partial)void this.record(account,m).catch(()=>{});});
      client.once('clientReady',()=>{void this.ready(account,client).catch(e=>console.error('discord_ready_failed',redact(e.message)));});
      await client.login(tokens[account]);
    }
  }
  async ready(account:string,client:Client) {
    const channels=[...new Set(this.config.routes.filter(r=>r.account===account).map(r=>r.channel))];
    const status:any[]=[];
    for(const id of channels) {
      try {
        const channel=await client.channels.fetch(id);
        if(!channel?.isTextBased()||!('messages' in channel))throw new Error('Not a readable channel');
        const permissions='permissionsFor' in channel?channel.permissionsFor(client.user!):null;
        const recent=await channel.messages.fetch({limit:50});
        for(const m of recent.values())await this.record(account,m);
        status.push({id,name:'name' in channel?channel.name:id,readable:true,canSend:permissions?.has('SendMessages'),canCreateThreads:permissions?.has('CreatePublicThreads')});
      } catch(e:any){status.push({id,readable:false,error:redact(e.message)});}
    }
    this.store.meta(`discord:${account}`,{ready:true,user:client.user!.id,channels:status,time:Date.now()});
    console.log('discord_ready',account,status.filter(s=>s.readable).length,'/',channels.length);
  }
  async record(account:string,m:DiscordMessage) {
    if(!m.guildId)return false;
    const channel=m.channel.isThread()?m.channel.parentId!:m.channelId;
    const route=routeFor(this.config,account,m.guildId,channel);if(!route)return false;
    const text=redact([m.content,...[...m.attachments.values()].map(a=>`[attachment: ${a.name}] ${a.url}`)].join('\n'));
    const id=`discord:${route.workspace}:${m.id}`;
    const added=this.store.record({id,platform:'discord',workspace:route.workspace,channel:m.channelId,author:`${m.author.displayName} (${m.author.id})`,text,time:m.createdTimestamp,bot:m.author.bot,replyTo:m.reference?.messageId?`discord:${route.workspace}:${m.reference.messageId}`:undefined});
    if(!added&&m.editedTimestamp) {
      this.store.db.prepare('UPDATE messages SET text=? WHERE id=?').run(text,id);
      this.store.event(route.workspace,m.channelId,`${id}:edit:${m.editedTimestamp}`,{type:'edit',id,text});
    }
    return added;
  }
  async receive(account:string,m:DiscordMessage) {
    if(!m.guildId)return;
    const parent=m.channel.isThread()?m.channel.parentId!:m.channelId;
    const route=routeFor(this.config,account,m.guildId,parent);if(!route)return;
    await this.record(account,m);
    if(m.author.bot)return;
    const client=this.clients.get(account)!;
    if(route.requireMention!==false&&!m.channel.isThread()&&!m.mentions.users.has(client.user!.id)) {
      if(!m.reference?.messageId)return;
      try {if((await m.fetchReference()).author.id!==client.user!.id)return;}catch{return;}
    }
    const receipt=`discord:${account}:${m.id}`;
    this.store.db.prepare("INSERT OR IGNORE INTO inbox VALUES (?,'discord',?,?,?,NULL,'pending')").run(receipt,account,m.channelId,m.id);
    if(this.store.db.prepare('SELECT state FROM inbox WHERE id=?').get(receipt)?.state==='done')return;
    let task:Task|undefined;
    if(m.channel.isThread()) {
      task=this.store.task(`discord:${account}:${m.channelId}`);
      if(!task){this.store.db.prepare("UPDATE inbox SET state='done' WHERE id=?").run(receipt);return;}
    } else if(route.conversationMode==='channel') {
      const key=`discord:${account}:${m.channelId}`;
      const preferred=this.store.meta(`modelDefault:discord:${account}:${parent}`)??route;
      task=this.store.task(key)??{key,workspace:route.workspace,platform:'discord',account,channel:m.channelId,parent,model:preferred.model,effort:preferred.effort,thread:null,cwd:taskDirectory(this.config,key),status:'queued'};
    } else {
      this.store.db.prepare("INSERT OR IGNORE INTO origins VALUES (?,NULL,'creating')").run(`${account}:${m.id}`);
      let thread=m.thread;
      if(!thread) {
        try {const fetched=await client.channels.fetch(m.id,{force:true});if(fetched?.isThread())thread=fetched;}catch{}
      }
      if(!thread) {
        try {thread=await m.startThread({name:(m.content.replace(/<@!?\d+>/g,'').trim()||'New task').slice(0,90),autoArchiveDuration:1440});}
        catch(e:any) {
          if(e.code!==160004)throw e;
          const existing=await client.channels.fetch(m.id,{force:true});
          if(!existing?.isThread())throw e;
          thread=existing;
        }
      }
      const key=`discord:${account}:${thread.id}`;
      const preferred=this.store.meta(`modelDefault:discord:${account}:${parent}`)??route;
      task=this.store.task(key)??{key,workspace:route.workspace,platform:'discord',account,channel:thread.id,parent,model:preferred.model,effort:preferred.effort,thread:null,cwd:taskDirectory(this.config,key),status:'queued'};
      this.store.db.prepare("UPDATE origins SET thread=?,state='created' WHERE id=?").run(thread.id,`${account}:${m.id}`);
      // Fetch context at invocation time, including messages missed during a short reconnect.
      if('messages' in m.channel) {
        const recent=await m.channel.messages.fetch({limit:50,before:m.id});
        for(const item of recent.values())await this.record(account,item);
      }
      if(m.reference?.messageId) {try {await this.record(account,await m.fetchReference());}catch{}}
    }
    const text=m.content.replace(new RegExp(`<@!?${client.user!.id}>`,'g'),'').trim();
    const initial=!this.store.task(task.key);
    if(initial)this.store.saveTask(task);
    let quote='';
    if(m.reference?.messageId)try{const referenced=await m.fetchReference();quote=`\nQuoted message from ${referenced.author.displayName} (${referenced.id}): ${referenced.content}\n${await discordAttachments(referenced,task.cwd)}`;}catch{}
    if(!await this.engine.command(task,text,m.id))await this.engine.submit(task,receipt,`${m.author.displayName} (${m.author.id}): ${text}${quote}\n${await discordAttachments(m,task.cwd)}`,initial);
    this.store.db.prepare("UPDATE inbox SET state='done' WHERE id=?").run(receipt);
  }
  retrying=false;
  async retryInbox() {
    if(this.retrying)return;this.retrying=true;
    try {
      const rows=this.store.db.prepare("SELECT * FROM inbox WHERE platform='discord' AND state='pending' LIMIT 20").all() as any[];
      for(const row of rows) {
        if(this.locks.has(row.channel))continue;
        const client=this.clients.get(row.account);if(!client?.isReady())continue;
        const work=(async()=>{try {
          const channel=await client.channels.fetch(row.channel);
          if(channel?.isTextBased()&&'messages' in channel)await this.receive(row.account,await channel.messages.fetch(row.message));
        }catch(e:any){this.store.meta('inboxFailure',{id:row.id,error:redact(e.message),time:Date.now()});}})();
        this.locks.set(row.channel,work);await work;this.locks.delete(row.channel);
      }
    } finally {this.retrying=false;}
  }
  async send(task:Task,text:string,id:string) {
    if(text.trim()==='NO_REPLY')return '';
    const started=performance.now();
    try {
      const result=await this.sendNow(task,text,id);
      timing(this.store,task,null,'discord_delivery',performance.now()-started,{status:'sent'});
      return result;
    }catch(e:any){
      timing(this.store,task,null,'discord_delivery',performance.now()-started,{status:'failed',notSent:e.notSent===true});
      throw e;
    }
  }
  private async sendNow(task:Task,text:string,id:string) {
    const client=this.clients.get(task.account);if(!client?.isReady())throw Object.assign(new Error('Discord is disconnected'),{notSent:true});
    const channel=await client.channels.fetch(task.channel);
    if(!channel?.isSendable())throw new Error('Discord channel is not sendable');
    if(channel.isThread()&&channel.archived)await channel.setArchived(false);
    const run=this.store.meta(`scheduleRun:${task.key}`);
    const mentionIds=this.store.meta(`deliveryMentions:${id}`)?.users??run?.mentionUserIds;
    const users=Array.isArray(mentionIds)?mentionIds.filter((user:any)=>typeof user==='string'&&/^\d{17,20}$/.test(user)):[];
    const allowedMentions=users.length?{parse:[] as ('users'|'roles'|'everyone')[],users}:{parse:[] as ('users'|'roles'|'everyone')[]};
    const upload=decodeUpload(text,id);
    if(upload)return (await channel.send({content:upload.caption||undefined,files:[{attachment:upload.path,name:upload.name}],allowedMentions,nonce:BigInt('0x'+eventId(id,'file').slice(0,15)).toString(),enforceNonce:true})).id;
    const ids:string[]=[];
    for(const [index,content] of splitMessage(text).entries()) {
      // Discord enforces nonce uniqueness for recent sends, covering short retry windows.
      const nonce=BigInt('0x'+eventId(id,String(index)).slice(0,15)).toString();
      ids.push((await channel.send({content,allowedMentions,nonce,enforceNonce:true})).id);
    }
    return ids.join(',');
  }
  close(){for(const c of this.clients.values())c.destroy();}
}
