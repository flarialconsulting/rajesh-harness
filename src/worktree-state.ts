import type {Store,Task} from './store.js';

export const WORKTREE_IDLE_MS=24*60*60*1000;
export function ensureWorktreeStorage(store:Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS task_activity (task TEXT PRIMARY KEY,at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS managed_worktrees (
      path TEXT PRIMARY KEY,workspace TEXT NOT NULL,task TEXT NOT NULL,repository TEXT NOT NULL,branch TEXT,
      created INTEGER NOT NULL,files_at INTEGER NOT NULL,fingerprint TEXT,last_scan INTEGER,
      state TEXT NOT NULL DEFAULT 'active',removed INTEGER,recovery TEXT,error TEXT);
    CREATE INDEX IF NOT EXISTS managed_worktrees_task ON managed_worktrees(task);`);
}
export function touchTask(store:Store,key:string,at=Date.now()) {
  store.db.prepare(`INSERT INTO task_activity VALUES (?,?) ON CONFLICT(task) DO UPDATE SET at=max(at,excluded.at)`).run(key,at);
}
export function taskActivity(store:Store,task:Task):number {
  const origin=store.meta(`scheduleRun:${task.key}`)?.origin;
  const parent=origin?store.task(origin):undefined;
  const activity=(owner:Task)=>Math.max(Number(store.db.prepare('SELECT at FROM task_activity WHERE task=?').get(owner.key)?.at??0),
    Number(store.db.prepare('SELECT max(created) AS at FROM jobs WHERE task=?').get(owner.key)?.at??0),
    Number(store.db.prepare('SELECT max(time) AS at FROM messages WHERE workspace=? AND platform=? AND channel=?').get(owner.workspace,owner.platform,owner.channel)?.at??0));
  return Math.max(activity(task),parent?activity(parent):0);
}
export function taskBusy(store:Store,task:Task):boolean {
  const origin=store.meta(`scheduleRun:${task.key}`)?.origin;
  return ['running','queued'].includes(task.status)||!!store.db.prepare("SELECT 1 FROM jobs WHERE task=? AND state IN ('queued','running','steering') LIMIT 1").get(task.key)||
    !!(origin&&origin!==task.key&&store.task(origin)&&['running','queued'].includes(store.task(origin)!.status));
}
export function registerWorktree(store:Store,task:string,workspace:string,path:string,repository:string,branch:string,now=Date.now()) {
  ensureWorktreeStorage(store);
  const previous=store.db.prepare('SELECT * FROM managed_worktrees WHERE path=?').get(path);
  if(previous?.state==='deleting')throw new Error('Worktree cleanup is in progress; retry shortly');
  store.db.prepare(`INSERT INTO managed_worktrees(path,workspace,task,repository,branch,created,files_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET task=excluded.task,repository=excluded.repository,branch=excluded.branch,
    created=CASE WHEN state='removed' THEN excluded.created ELSE created END,
    files_at=CASE WHEN state='removed' THEN excluded.files_at ELSE files_at END,
    fingerprint=CASE WHEN state='removed' THEN NULL ELSE fingerprint END,state='active',removed=NULL,error=NULL`).run(path,workspace,task,repository,branch,now,now);
  touchTask(store,task,now);
  return previous?.recovery?String(previous.recovery):undefined;
}
