import { latencyReport } from './latency.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { loadConfig, type Workspace } from './config.js';
import { Store } from './store.js';
import { createWorktree } from './worktree.js';
import { queueUpload } from './uploads.js';
import { Memory } from './memory.js';

const config=loadConfig(),store=new Store(config.dataDir);
const task=store.task(process.env.RAJESH_TASK!);
if(!task) throw new Error('Missing task context');
const workspace=task.workspace as Workspace;
const memory=new Memory(join(config.dataDir,'memory',workspace));
const server=new McpServer({name:'rajesh-context',version:'1.0.0'});
const result=(data:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(data)}]});
function channel(value?:string) {
  const selected=value??task!.parent;
  const allowed=selected===task!.channel || selected===task!.parent || config.routes.some(r=>r.workspace===workspace&&r.channel===selected) || (workspace===config.whatsappWorkspace&&selected===config.whatsappGroup);
  if(!allowed) throw new Error('Channel is outside this workspace');
  return selected;
}
server.registerTool('read_recent_messages',{description:'Read recent ordinary conversation, including unmentioned messages. Defaults to the originating channel.',inputSchema:{channel:z.string().optional(),limit:z.number().int().min(1).max(200).default(50)}},async args=>result(store.recent(workspace,channel(args.channel),args.limit)));
server.registerTool('read_message_context',{description:'Read messages before and after a message ID.',inputSchema:{message_id:z.string(),channel:z.string().optional(),radius:z.number().int().min(1).max(50).default(20)}},async args=>result(store.context(workspace,channel(args.channel),args.message_id,args.radius)));
server.registerTool('search_messages',{description:'Search literal text through full transcripts and compressed archives. Defaults to the current channel; workspace_wide searches all retained workspace history.',inputSchema:{query:z.string().min(1).max(1000),channel:z.string().optional(),workspace_wide:z.boolean().default(false)}},async args=>{
  const base=join(config.dataDir,'archive',workspace);
  const path=args.workspace_wide?base:join(base,channel(args.channel).replace(/[^a-zA-Z0-9_.@-]/g,'_'));
  const recent=store.db.prepare(`SELECT id,channel,author,text,time FROM messages WHERE workspace=? ${args.workspace_wide?'':'AND channel=?'} AND instr(lower(text),lower(?))>0 ORDER BY time DESC LIMIT 100`).all(...(args.workspace_wide?[workspace,args.query]:[workspace,channel(args.channel),args.query]));
  let archive='';
  if(existsSync(path)) {
    try {archive=(await promisify(execFile)('rg',['--search-zip','--no-heading','--max-count','50','-i','-F','--',args.query,path],{timeout:15000,maxBuffer:1024*1024})).stdout;}
    catch(e:any){if(e.code!==1) return result({recent,archive:(e.stdout??'').slice(0,32000),truncated:true});}
  }
  return result({recent,archive:archive.slice(0,32000),truncated:archive.length>32000});
});
server.registerTool('create_worktree',{description:'Before editing an existing Git project, create or reuse this task’s worktree. Work only in the returned path; do not automatically merge or remove it.',inputSchema:{repository:z.string()}},async args=>result(createWorktree(config,workspace,task!.key,args.repository)));
server.registerTool('latency_status',{description:'Read queue, startup, response, tool and delivery timings over the past 24 hours. Defaults to this task; workspace_wide includes other tasks in this workspace.',inputSchema:{workspace_wide:z.boolean().default(false)}},async args=>result(latencyReport(store,workspace,args.workspace_wide?undefined:task!.key)));
server.registerTool('read_memory',{description:'Read this workspace’s explicitly saved memory when useful. Optionally search literal text. Memory is shared by conversations in this workspace.',inputSchema:{query:z.string().optional()}},async args=>result(memory.read(args.query)));
server.registerTool('write_memory',{description:'Save memory ONLY when the user explicitly asks to remember or update something. To update, provide the ID and revision returned by read_memory.',inputSchema:{text:z.string().min(1).max(12000),id:z.string().optional(),revision:z.string().optional()}},async args=>result(memory.write(args.text,args.id,args.revision)));
server.registerTool('delete_memory',{description:'Delete saved memory ONLY when the user explicitly asks to forget it. Read the note first to obtain its current revision.',inputSchema:{id:z.string(),revision:z.string()}},async args=>result(memory.delete(args.id,args.revision)));
function runtimeRequest(action:string,path?:string):Promise<unknown> {
  return new Promise((resolve,reject)=>{
    const req=request({socketPath:join(config.dataDir,'runtime','control.sock'),path:'/',method:'POST',headers:{'Content-Type':'application/json'}},res=>{
      let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>{try{const value=JSON.parse(body);res.statusCode===200?resolve(value):reject(new Error(value.error));}catch(e){reject(e);}});
    });req.setTimeout(600000,()=>req.destroy(new Error('Runtime publication timed out; check status before retrying')));req.on('error',reject);req.end(JSON.stringify({action,path,task:task!.key}));
  });
}
server.registerTool('runtime_status',{description:'Show this conversation’s original binding, current execution snapshot, latest published revision, validation failures and infrastructure changes requiring a restart.',inputSchema:{}},async()=>result(await runtimeRequest('status')));
server.registerTool('prepare_self_edit',{description:'Create an editable draft of the current bot source and configuration. Edit this draft to modify the bot itself. Never edit immutable revision directories. Use pnpm add for dependencies.',inputSchema:{}},async()=>result(await runtimeRequest('prepare')));
server.registerTool('publish_self_edit',{description:'Validate and publish a prepared bot draft for persistent conversations between turns. Stale drafts are rejected. Active turns retain their runtime until completion.',inputSchema:{path:z.string()}},async args=>result(await runtimeRequest('publish',args.path)));
server.registerTool('upload_file',{description:'Send a local file as an attachment to this conversation on Discord or WhatsApp when requested by the user. Use this to deliver generated images too; image generation or displaying a tool image does not send it to chat. PNG/JPEG images display inline on WhatsApp by default. Set presentation=document only when the user wants a downloadable document attachment. Use this instead of posting a local filesystem link. Maximum 10 MiB on Discord, 100 MiB on WhatsApp. request_id identifies this send: reuse it to check status or retry without duplicating. Returns pending, sending, sent or uncertain; only sent confirms delivery. Never retry uncertain with a new ID without checking whether it arrived. Do not upload credentials.',inputSchema:{path:z.string().min(1),request_id:z.string().min(1).max(200),filename:z.string().optional(),caption:z.string().max(1000).optional(),mime_type:z.string().max(150).optional(),presentation:z.enum(['auto','image','document']).default('auto')}},async args=>result(await queueUpload(store,task,args)));
await server.connect(new StdioServerTransport());
