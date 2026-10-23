import {splitMessage} from './message-chunks.js';
import { Store,type Task,eventId } from './store.js';
import { redact } from './redact.js';
import { timing,ensureLatencyStorage } from './latency.js';
import { rememberFinalReply,sendDiscordFinal } from './final-replies.js';
import {cleanupWorktrees} from './worktree-cleanup.js';
const toolTypes=new Set(['commandExecution','fileChange','mcpToolCall','dynamicToolCall','webSearch','imageView','imageGeneration','collabAgentToolCall','computerUse','toolCall']);
export function toolLine(item:any) {
  const detail=item.command??(item.tool?`${item.server??''}/${item.tool} ${JSON.stringify(item.arguments??{})}`:item.query??item.action?.query??item.changes?.map((c:any)=>c.path).join(', ')??item.path??'');
  const text=redact(`${item.type}: ${detail}`).replace(/[\r\n\t]+/g,' ').replace(/`/g,"'");
  return text.length>65?text.slice(0,64)+'…':text;
}
export function renderTools(rows:{line:string;status:string}[],count:number,state:string) {
  if(state==='queued'&&!count)return 'Queued. Waiting for an available task slot.';
  const header=count>25?`${count-25} more tool calls ...\n`:'';
  const icon=state==='completed'?'✅':state==='failed'?'❌':state==='interrupted'?'⏹️':'🛠️';
  return `${header}${icon} Tool activity\n`+rows.slice(-25).map(r=>`${r.status==='completed'?'✓':r.status==='failed'?'✗':'…'} ${r.line}`).join('\n');
}
export class Progress {
  clients=new Map<string,any>();socket:()=>any=()=>undefined;flushing=false;pendingFlush?:Promise<void>;
  nextAttempt=new Map<string,number>();
  lastFlushAt=0;
  nextWorktreeSweep=0;
  worktreeSweepPending=false;
  constructor(public store:Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS tool_activity(task TEXT,item TEXT,line TEXT,status TEXT,PRIMARY KEY(task,item));
      CREATE TABLE IF NOT EXISTS progress_panels(task TEXT PRIMARY KEY,message TEXT,state TEXT,dirty INTEGER,creating INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS progress_reactions(task TEXT,message TEXT PRIMARY KEY,key TEXT,state TEXT,sent TEXT);`);
    ensureLatencyStorage(store);
  }
  panel(task:Task) {
    let key=this.store.meta(`panel:${task.key}`) as string|undefined;
    if(!key){key=task.key;this.store.meta(`panel:${task.key}`,key);}
    this.store.db.prepare("INSERT OR IGNORE INTO progress_panels(task,state,dirty) VALUES (?,'working',0)").run(key);
    this.store.meta(`panelTask:${key}`,task.key);return key;
  }
  captureFinal(task:Task,text:string,id:string) {
    if(!text.trim()||this.store.meta(`finalPanel:${id}`))return;
    // Active turns can still use the engine from before this patch was published.
    if(id.startsWith('codex:')&&!this.store.meta(`finalReply:${id}`)) {
      const job=this.store.db.prepare("SELECT id FROM jobs WHERE task=? AND state='running' ORDER BY id LIMIT 1").get(task.key);
      if(job)rememberFinalReply(this.store,task,id,Number(job.id));
    }
    const key=this.panel(task);
    this.store.meta(`finalPanel:${id}`,key);
    if(this.store.meta(`finalReply:${id}`)) {
      this.store.meta(`panelNativeFinal:${key}`,id);
      this.store.db.prepare("UPDATE progress_panels SET state='retired',dirty=1 WHERE task=?").run(key);
      return;
    }
    this.store.meta(`panelFinal:${key}`,redact(text));
    this.nextAttempt.delete(key);
    this.store.db.prepare('UPDATE progress_panels SET dirty=1 WHERE task=?').run(key);
  }
  async final(task:Task,text:string,id:string):Promise<string> {
    if(text.trim()==='NO_REPLY')return '';
    this.captureFinal(task,text,id);
    if(this.store.meta(`finalReply:${id}`)) {
      await this.pendingFlush;
      const sent=await sendDiscordFinal(this.store,task,redact(text),id,this.clients);
      await this.flush();
      return sent;
    }
    await this.pendingFlush;await this.flush();
    const key=this.store.meta(`finalPanel:${id}`);
    const panel=this.store.db.prepare('SELECT * FROM progress_panels WHERE task=?').get(key) as any;
    if(!panel?.message||panel.dirty)throw Object.assign(new Error('Final panel delivery pending'),{notSent:true});
    return panel.message;
  }
  seen(task:Task,message:string) {
    let key:any;
    if(task.platform==='discord') {
      const id=message.split(':').at(-1)!;
      const row=this.store.db.prepare('SELECT channel FROM messages WHERE id=?').get(`discord:${task.workspace}:${id}`);
      if(!row)return;
      key={platform:'discord',account:task.account,channel:row.channel,id};
    } else {
      const row=this.store.db.prepare('SELECT raw FROM messages WHERE id=?').get(message);
      if(!row?.raw)return;
      key=JSON.parse(String(row.raw)).key;
    }
    this.store.transaction(()=>{
      const added=this.store.db.prepare("INSERT OR IGNORE INTO progress_reactions VALUES (?,?,?,'seen',NULL)").run(task.key,message,JSON.stringify(key));
      if(!added.changes)return;
      if(task.platform==='discord') {
        const previous=this.store.meta(`panel:${task.key}`);
        if(previous&&this.store.meta(`panelFinal:${previous}`)===undefined&&!this.store.meta(`panelNativeFinal:${previous}`)) {
          this.store.db.prepare("UPDATE progress_panels SET state='retired',dirty=1 WHERE task=?").run(previous);
        }
        const next=`${task.key}:input:${message}`;
        this.store.meta(`panel:${task.key}`,next);this.panel(task);
        this.store.db.prepare("UPDATE progress_panels SET state='queued',dirty=1 WHERE task=?").run(next);
      }
      // A new steering message takes ownership of the result. Keep this terminal
      // state even when all jobs in the shared turn later complete together.
      this.store.db.prepare(`UPDATE progress_reactions SET state='superseded'
        WHERE task=? AND message!=? AND state!='superseded'
        AND EXISTS (SELECT 1 FROM jobs WHERE jobs.message=progress_reactions.message AND jobs.task=? AND jobs.state IN ('running','steering'))`).run(task.key,message,task.key);
    });
  }
  event(task:Task,kind:string,item?:any) {
    if(task.platform==='discord'&&kind==='started') {
      const current=this.store.meta(`panel:${task.key}`) as string|undefined;
      if(current?.includes(':input:')&&this.store.meta(`panelFinal:${current}`)===undefined&&!this.store.meta(`panelNativeFinal:${current}`))return;
      this.store.meta(`panel:${task.key}`,`${task.key}:turn:${item.id}`);this.panel(task);return;
    }
    const key=task.platform==='discord'?this.panel(task):task.key;
    if(task.platform==='discord'&&this.store.meta(`panelNativeFinal:${key}`))return;
    if(kind==='tool') {
      if(task.platform==='discord'&&item?.type==='agentMessage'&&item.phase==='commentary'&&item.status==='completed') {
        if(!item.id||!item.text?.trim())return;
        const id=`commentary:${task.key}:${item.id}`;
        if(this.store.meta(`finalPanel:${id}`))return;
        this.store.transaction(()=>{
          this.captureFinal(task,item.text,id);
          this.store.meta(`panel:${task.key}`,`${task.key}:after:${item.id}`);
          this.panel(task);
        });
        return;
      }
      if(task.platform!=='discord'||!toolTypes.has(item?.type)||!item?.id)return;
      this.store.db.prepare('INSERT INTO tool_activity VALUES (?,?,?,?) ON CONFLICT(task,item) DO UPDATE SET line=excluded.line,status=excluded.status').run(key,item.id,toolLine(item),item.status??'inProgress');
      this.store.db.prepare("UPDATE progress_panels SET dirty=1 WHERE task=?").run(key);return;
    }
    const state=kind==='working'?'working':kind;
    if(task.platform==='whatsapp') {
      return; // Job receipts, rather than notification timing, determine WhatsApp reaction state.
    } else this.store.db.prepare('UPDATE progress_panels SET state=?,dirty=1 WHERE task=?').run(state,key);
  }
  flush():Promise<void> {
    if(this.pendingFlush)return this.pendingFlush;
    this.pendingFlush=this.flushNow().finally(()=>{this.pendingFlush=undefined;});return this.pendingFlush;
  }
  private async flushNow() {
    if(!this.worktreeSweepPending&&Date.now()>=this.nextWorktreeSweep) {
      this.nextWorktreeSweep=Date.now()+5*60*1000;this.worktreeSweepPending=true;
      void cleanupWorktrees(this.store).catch(e=>{try{this.store.meta('worktreeCleanupFailure',{at:Date.now(),error:redact(String(e.message))});}catch{}})
        .finally(()=>{this.worktreeSweepPending=false;});
    }
    this.flushing=true;
    const flushStarted=performance.now();
    if(this.lastFlushAt&&flushStarted-this.lastFlushAt>10_000)this.store.meta('progressTickGap',{gapMs:Math.round(flushStarted-this.lastFlushAt),time:Date.now()});
    this.lastFlushAt=flushStarted;
    try {
      this.store.db.exec(`UPDATE progress_reactions SET state=CASE (SELECT state FROM jobs WHERE jobs.message=progress_reactions.message)
        WHEN 'queued' THEN 'seen' WHEN 'running' THEN 'working' WHEN 'steering' THEN 'working' WHEN 'done' THEN 'completed'
        WHEN 'failed' THEN 'failed' WHEN 'interrupted' THEN 'interrupted' WHEN 'cancelled' THEN 'interrupted' ELSE state END WHERE state!='superseded';`);
      const reactions=this.store.db.prepare('SELECT * FROM progress_reactions WHERE sent IS NULL OR sent != state').all() as any[];
      for(const pending of reactions) {
        // Another input may have superseded a message while a previous send awaited the network.
        const row=this.store.db.prepare('SELECT * FROM progress_reactions WHERE message=?').get(pending.message) as any;
        if(!row||row.sent===row.state)continue;
        const text=({seen:'👀',working:'🛠️',superseded:'↩️',completed:'✅',failed:'❌',interrupted:'⏹️'} as any)[row.state];if(!text)continue;
        try {
          const key=JSON.parse(row.key);
          if(key.platform==='discord') {
            const client=this.clients.get(key.account);if(!client?.isReady())continue;
            const channel=await client.channels.fetch(key.channel);if(!channel?.messages)continue;
            const message=await channel.messages.fetch(key.id);
            await message.react(text);
            // Remove only our previous status reactions; leave other users' reactions alone.
            for(const reaction of message.reactions.cache.values()) {
              if(reaction.me&&reaction.emoji.name!==text&&['👀','🛠️','↩️','✅','❌','⏹️'].includes(reaction.emoji.name))await reaction.users.remove(client.user.id);
            }
          } else {
            const socket=this.socket();if(!socket||!this.store.meta('whatsapp')?.ready)continue;
            await socket.sendMessage(key.remoteJid,{react:{text,key}});
          }
          this.store.db.prepare('UPDATE progress_reactions SET sent=? WHERE message=?').run(row.state,row.message);
        }catch{continue;}
      }
      const panels=this.store.db.prepare('SELECT * FROM progress_panels WHERE dirty=1 ORDER BY rowid DESC').all() as any[];
      for(const panel of panels) {
        if((this.nextAttempt.get(panel.task)??0)>Date.now())continue;
        const task=this.store.task(this.store.meta(`panelTask:${panel.task}`)??panel.task);if(!task)continue;
        const client=this.clients.get(task.account);if(!client?.isReady())continue;
        try {
          const panelStarted=performance.now();
          const channel=await client.channels.fetch(task.channel);if(!channel?.isSendable())continue;
          if(channel.isThread()&&channel.archived)await channel.setArchived(false);
          const latest=this.store.db.prepare('SELECT * FROM progress_panels WHERE task=?').get(panel.task) as any;
          if(latest.state==='retired') {
            let message=latest.message;
            if(!message&&latest.creating) {
              const nonce=BigInt('0x'+eventId('tools',panel.task).slice(0,15)).toString();
              const recent=await channel.messages.fetch({limit:100});
              message=recent.find((m:any)=>m.author.id===client.user.id&&m.nonce===nonce)?.id;
              if(!message){this.nextAttempt.set(panel.task,Date.now()+60_000);continue;}
            }
            if(message)try{await channel.messages.delete(message);}catch(e:any){if(e.code!==10008)throw e;}
            this.store.db.prepare("UPDATE progress_panels SET state='deleted',dirty=0 WHERE task=?").run(panel.task);
            this.store.db.prepare('DELETE FROM tool_activity WHERE task=?').run(panel.task);
            continue;
          }
          if(latest.state==='deleted')continue;
          const rows=(this.store.db.prepare('SELECT line,status FROM tool_activity WHERE task=? ORDER BY rowid DESC LIMIT 25').all(panel.task) as any[]).reverse();
          const count=Number(this.store.db.prepare('SELECT count(*) n FROM tool_activity WHERE task=?').get(panel.task)!.n);
          const final=this.store.meta(`panelFinal:${panel.task}`) as string|undefined;
          const content=final===undefined?renderTools(rows,count,panel.state):splitMessage(final)[0];
          const payload:any={content,allowedMentions:{parse:[]}};
          if(final!==undefined)payload.attachments=[];
          this.store.db.prepare('UPDATE progress_panels SET dirty=0 WHERE task=?').run(panel.task);
          if(panel.message)await channel.messages.edit(panel.message,payload);
          else {
            const nonce=BigInt('0x'+eventId('tools',panel.task).slice(0,15)).toString();
            if(panel.creating) {
              const recent=await channel.messages.fetch({limit:100});
              const found=recent.find((m:any)=>m.author.id===client.user.id&&m.nonce===nonce);
              if(found)this.store.db.prepare('UPDATE progress_panels SET message=?,creating=0,dirty=1 WHERE task=?').run(found.id,panel.task);
              else {this.nextAttempt.set(panel.task,Date.now()+60_000);this.store.db.prepare('UPDATE progress_panels SET dirty=1 WHERE task=?').run(panel.task);this.store.meta('progressFailure',{task:task.key,error:'Uncertain initial panel delivery; not duplicating it',time:Date.now()});}
              continue;
            }
            this.store.db.prepare('UPDATE progress_panels SET creating=1 WHERE task=?').run(panel.task);
            const sent=await channel.send({...payload,nonce,enforceNonce:true});
            this.store.db.prepare('UPDATE progress_panels SET message=?,creating=0 WHERE task=?').run(sent.id,panel.task);
          }
          if(final!==undefined){
            const parts=splitMessage(final),sent:string[]=this.store.meta(`panelFinalParts:${panel.task}`)??[];
            for(let index=1;index<parts.length;index++){
              if(sent[index])continue;
              const message=await channel.send({content:parts[index],allowedMentions:{parse:[]},nonce:BigInt('0x'+eventId('panel-final',panel.task,String(index)).slice(0,15)).toString(),enforceNonce:true});
              sent[index]=message.id;this.store.meta(`panelFinalParts:${panel.task}`,sent);
            }
          }
          this.nextAttempt.delete(panel.task);
          if(final!==undefined)timing(this.store,task,null,'panel_delivery',performance.now()-panelStarted);
          // Input can arrive while Discord is sending or editing this panel.
          this.store.db.prepare("UPDATE progress_panels SET dirty=1 WHERE task=? AND state='retired'").run(panel.task);
        }catch(e:any){this.nextAttempt.set(panel.task,Date.now()+15_000);this.store.db.prepare('UPDATE progress_panels SET dirty=1 WHERE task=?').run(panel.task);this.store.meta('progressFailure',{task:task.key,error:redact(e.message),time:Date.now()});}
      }
    }finally{this.flushing=false;}
  }
}
