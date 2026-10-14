import { DatabaseSync } from 'node:sqlite';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import type { Workspace } from './config.js';
import { redactValue } from './redact.js';
import { ensureLatencyStorage } from './latency.js';

export interface Message {
  id: string; platform: string; workspace: Workspace; channel: string; author: string;
  text: string; time: number; bot: boolean; replyTo?: string; raw?: unknown;
}
export interface Task {
  key: string; workspace: Workspace; platform: string; account: string; channel: string;
  parent: string; model: string; effort: string; thread: string | null; cwd: string; status: string;
}
export interface Job { id: number; task: string; message: string; prompt: string; state: string }
const safe = (s: string) => s.replace(/[^a-zA-Z0-9_.@-]/g, '_');
export class Store {
  db: DatabaseSync;
  private transactionDepth=0;
  constructor(public dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, 'state.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, platform TEXT, workspace TEXT, channel TEXT, author TEXT, text TEXT, time INTEGER, bot INTEGER, replyTo TEXT, raw TEXT);
      CREATE INDEX IF NOT EXISTS message_context ON messages(workspace, channel, time);
      CREATE TABLE IF NOT EXISTS tasks (key TEXT PRIMARY KEY, workspace TEXT, platform TEXT, account TEXT, channel TEXT, parent TEXT, model TEXT, effort TEXT, thread TEXT, cwd TEXT, status TEXT);
      CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY, task TEXT REFERENCES tasks(key), message TEXT UNIQUE, prompt TEXT, state TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS deliveries (id TEXT PRIMARY KEY, task TEXT, text TEXT, state TEXT, external TEXT);
      CREATE TABLE IF NOT EXISTS archive (id TEXT PRIMARY KEY, workspace TEXT, channel TEXT, time INTEGER, payload TEXT, exported INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS wa_auth (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS origins (id TEXT PRIMARY KEY, thread TEXT, state TEXT);
      CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, platform TEXT, account TEXT, channel TEXT, message TEXT, payload TEXT, state TEXT);
    `);
    ensureLatencyStorage(this);
  }
  transaction<T>(fn: () => T): T {
    if(this.transactionDepth)return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth++;
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    finally {this.transactionDepth--;}
  }
  record(m: Message) {
    m=redactValue(m);
    return this.transaction(() => {
      const result = this.db.prepare('INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?,?,?,?,?)').run(m.id,m.platform,m.workspace,m.channel,m.author,m.text,m.time,+m.bot,m.replyTo??null,JSON.stringify(m.raw??null));
      if (result.changes) this.event(m.workspace,m.channel,m.id,{type:'message',...m},m.time);
      return !!result.changes;
    });
  }
  event(workspace: string, channel: string, id: string, value: unknown, time=Date.now()) {
    this.db.prepare('INSERT OR IGNORE INTO archive(id,workspace,channel,time,payload) VALUES (?,?,?,?,?)').run(id,workspace,channel,time,JSON.stringify(redactValue({archiveId:id,time,...(value as object)})));
  }
  recent(workspace: string, channel: string, limit=50, before=Number.MAX_SAFE_INTEGER): Message[] {
    return this.db.prepare('SELECT id,platform,workspace,channel,author,text,time,bot,replyTo FROM messages WHERE workspace=? AND channel=? AND time<=? ORDER BY time DESC, id DESC LIMIT ?').all(workspace,channel,before,Math.min(limit,200)).reverse() as unknown as Message[];
  }
  context(workspace: string, channel: string, id: string, limit=20) {
    const target = this.db.prepare('SELECT time FROM messages WHERE id=? AND workspace=? AND channel=?').get(id,workspace,channel) as {time:number}|undefined;
    if (!target) return [];
    const before=this.recent(workspace,channel,limit,target.time);
    const after=this.db.prepare('SELECT id,platform,workspace,channel,author,text,time,bot,replyTo FROM messages WHERE workspace=? AND channel=? AND time>? ORDER BY time LIMIT ?').all(workspace,channel,target.time,limit);
    return [...before,...after];
  }
  task(key: string) { return this.db.prepare('SELECT * FROM tasks WHERE key=?').get(key) as unknown as Task|undefined; }
  saveTask(t: Task) { this.db.prepare('INSERT OR REPLACE INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(t.key,t.workspace,t.platform,t.account,t.channel,t.parent,t.model,t.effort,t.thread,t.cwd,t.status); }
  enqueue(task: string, message: string, prompt: string) { return this.db.prepare("INSERT OR IGNORE INTO jobs(task,message,prompt,state,created) VALUES (?,?,?,'queued',?)").run(task,message,prompt,Date.now()); }
  pending() { return this.db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY id").all() as unknown as Job[]; }
  jobState(id: number, state: string) { this.db.prepare('UPDATE jobs SET state=? WHERE id=?').run(state,id); }
  recover() {
    this.db.exec("UPDATE jobs SET state='interrupted' WHERE state IN ('running','steering'); UPDATE tasks SET status='interrupted' WHERE status='running'; UPDATE deliveries SET state='uncertain' WHERE state='sending'");
  }
  meta(key: string, value?: unknown): any {
    if (value !== undefined) this.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run(key,JSON.stringify(value));
    const row=this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key) as {value:string}|undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  flushArchive() {
    // Flush rows durably, then mark exported. A crash can repeat a line; archiveId makes it identifiable.
    const rows=this.db.prepare('SELECT * FROM archive WHERE exported=0 ORDER BY time LIMIT 5000').all() as any[];
    const grouped=new Map<string,any[]>();
    for (const row of rows) {
      const folder=join(this.dir,'archive',safe(row.workspace),safe(row.channel));
      mkdirSync(folder,{recursive:true,mode:0o700});
      const day=new Date(row.time).toISOString().slice(0,10);
      const path=join(folder,day+'.jsonl');const batch=grouped.get(path)??[];batch.push(row);grouped.set(path,batch);
    }
    for(const [path,batch] of grouped) {
      appendFileSync(path,batch.map(row=>row.payload+'\n').join(''),{mode:0o600,flush:true});
      this.transaction(()=>{const update=this.db.prepare('UPDATE archive SET exported=1,payload=NULL WHERE id=?');for(const row of batch)update.run(row.id);});
    }
    return rows.length;
  }
  compress() {
    const root=join(this.dir,'archive'); if (!existsSync(root)) return;
    const today=new Date().toISOString().slice(0,10);
    for (const workspace of readdirSync(root)) for (const channel of readdirSync(join(root,workspace))) {
      const folder=join(root,workspace,channel);
      for (const name of readdirSync(folder)) {
        if (!name.endsWith('.jsonl') || name.startsWith(today)) continue;
        const path=join(folder,name), zipped=path+'.gz';
        // Late history can create another plaintext shard for an already compressed day.
        const bytes=gzipSync(readFileSync(path));
        const previous=existsSync(zipped)?readFileSync(zipped):Buffer.alloc(0);
        writeFileSync(zipped+'.tmp',Buffer.concat([previous,bytes]),{mode:0o600,flush:true});
        renameSync(zipped+'.tmp',zipped); unlinkSync(path);
      }
    }
  }
  close() { this.db.close(); }
}
export function eventId(...parts: string[]) { return createHash('sha256').update(parts.join('\0')).digest('hex'); }
export function formatContext(messages: Message[]) {
  return messages.map(m=>`[${new Date(m.time).toISOString()}] ${m.author} (${m.id})${m.replyTo?` replying to ${m.replyTo}`:''}: ${m.text}`).join('\n').slice(-16000);
}
