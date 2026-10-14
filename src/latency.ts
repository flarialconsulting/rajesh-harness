import type { Store, Task } from './store.js';

export function ensureLatencyStorage(store:Store) {
  store.db.exec(`CREATE INDEX IF NOT EXISTS archive_unexported_time ON archive(time) WHERE exported=0;
    CREATE INDEX IF NOT EXISTS jobs_queued_id ON jobs(id) WHERE state='queued';
    CREATE TABLE IF NOT EXISTS latency_events (id INTEGER PRIMARY KEY,task TEXT,job INTEGER,stage TEXT,ms REAL,at INTEGER,details TEXT);
    CREATE INDEX IF NOT EXISTS latency_task_time ON latency_events(task,at);`);
}

// Details contain counters and stage names only. Never pass prompts or tool arguments.
export function timing(store:Store,task:Task,job:number|null,stage:string,ms:number,details:Record<string,string|number|boolean>={}) {
  if(!task.key)return;
  const at=Date.now();
  try {store.db.prepare('INSERT INTO latency_events(task,job,stage,ms,at,details) VALUES (?,?,?,?,?,?)')
    .run(task.key,job,stage,Math.max(0,Math.round(ms)),at,JSON.stringify(details));
  }catch{console.error('latency_record_failed',stage);}
}
export function latencyReport(store:Store,workspace:string,taskKey?:string) {
  const cutoff=Date.now()-24*60*60*1000;
  const events=store.db.prepare(`SELECT l.task,l.job,l.stage,l.ms,l.at,l.details FROM latency_events l
    JOIN tasks t ON t.key=l.task WHERE t.workspace=? AND l.at>=? ${taskKey?'AND l.task=?':''}
    ORDER BY l.id DESC LIMIT 200`).all(...(taskKey?[workspace,cutoff,taskKey]:[workspace,cutoff]));
  const queued=store.db.prepare(`SELECT j.id,j.task,j.created FROM jobs j JOIN tasks t ON t.key=j.task
    WHERE j.state='queued' AND t.workspace=? ${taskKey?'AND j.task=?':''} ORDER BY j.id LIMIT 50`)
    .all(...(taskKey?[workspace,taskKey]:[workspace]));
  return {windowHours:24,events:events.map((row:any)=>({...row,details:JSON.parse(row.details)})),
    queued:queued.map((row:any)=>({...row,waitMs:Date.now()-row.created}))};
}
