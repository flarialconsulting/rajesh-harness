import {promises as fs} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {Store} from './store.js';
import {ensureWorktreeStorage,registerWorktree,taskActivity,taskBusy,WORKTREE_IDLE_MS} from './worktree-state.js';
import {redact} from './redact.js';

const exec=promisify(execFile);
const interval=5*60*1000;
interface Tracked {path:string;workspace:string;task:string;repository:string;branch:string;created:number;files_at:number;fingerprint:string|null;state:string}
interface Options {now?:()=>number;inUse?:(path:string)=>Promise<boolean>}
const inside=(root:string,path:string)=>{const rel=relative(root,path);return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel));};
async function git(path:string,...args:string[]) {
  return (await exec('git',['-C',path,...args],{env:{...process.env,GIT_OPTIONAL_LOCKS:'0'},timeout:60_000,maxBuffer:32*1024*1024})).stdout;
}
export async function worktreeSnapshot(path:string) {
  const hash=createHash('sha256');let latest=0;
  async function visit(dir:string) {
    const st=await fs.lstat(dir);latest=Math.max(latest,st.mtimeMs,st.ctimeMs);
    hash.update(`${relative(path,dir)}\0${st.size}\0${st.mtimeMs}\0${st.ctimeMs}\0${st.mode}\n`);
    if(!st.isDirectory()||st.isSymbolicLink())return;
    for(const name of (await fs.readdir(dir)).sort())await visit(join(dir,name));
  }
  await visit(path);
  const gitDir=(await git(path,'rev-parse','--absolute-git-dir')).trim();
  for(const name of ['HEAD','index','logs/HEAD']) {
    try {const st=await fs.stat(join(gitDir,name));latest=Math.max(latest,st.mtimeMs,st.ctimeMs);hash.update(`${name}\0${st.mtimeMs}\0${st.ctimeMs}\n`);}
    catch(e:any){if(e.code!=='ENOENT')throw e;}
  }
  return {fingerprint:hash.digest('hex'),latest};
}
async function processUses(path:string) {
  // Without a process inventory, retain the worktree rather than guess.
  let processes:string[];try{processes=await fs.readdir('/proc');}catch{return true;}
  for(const pid of processes.filter(p=>/^\d+$/.test(p))) {
    const links=[join('/proc',pid,'cwd'),join('/proc',pid,'exe')];
    for(const kind of ['fd','map_files']) {
      try{for(const name of await fs.readdir(join('/proc',pid,kind)))links.push(join('/proc',pid,kind,name));}
      catch(e:any){if(!['ENOENT','ESRCH'].includes(e.code))return true;}
    }
    for(const link of links)try{if(inside(path,await fs.readlink(link)))return true;}catch(e:any){if(!['ENOENT','ESRCH','EINVAL'].includes(e.code))return true;}
  }
  return false;
}
async function validate(store:Store,row:Tracked) {
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(row.workspace)||['__proto__','constructor','prototype'].includes(row.workspace))throw new Error('Invalid worktree workspace');
  const base=join(resolve(store.dir),'worktrees',row.workspace);
  if(resolve(row.path)!==row.path||relative(base,row.path).split(/[\\/]/).length!==1||!inside(base,row.path))throw new Error('Worktree outside managed directory');
  if(await fs.realpath(row.path)!==row.path||(await fs.lstat(join(row.path,'.git'))).isSymbolicLink())throw new Error('Worktree path is a symlink');
  const common=resolve(row.path,(await git(row.path,'rev-parse','--git-common-dir')).trim());
  const expected=resolve(row.repository,(await git(row.repository,'rev-parse','--git-common-dir')).trim());
  if(common!==expected||inside(row.path,common))throw new Error('Worktree repository registration changed');
  const listing=await git(row.repository,'worktree','list','--porcelain');
  if(!listing.split('\n').includes(`worktree ${row.path}`))throw new Error('Worktree is not registered');
  const gitDir=(await git(row.path,'rev-parse','--absolute-git-dir')).trim();
  try{await fs.access(join(gitDir,'locked'));throw new Error('Worktree is locked');}catch(e:any){if(e.code!=='ENOENT')throw e;}
}
async function discover(store:Store,now:number) {
  for(const {workspace} of store.db.prepare('SELECT DISTINCT workspace FROM tasks').all() as unknown as {workspace:string}[]) {
    const base=join(resolve(store.dir),'worktrees',workspace);
    let entries;try{entries=await fs.readdir(base,{withFileTypes:true});}catch(e:any){if(e.code==='ENOENT')continue;throw e;}
    const tasks=store.db.prepare('SELECT key FROM tasks WHERE workspace=?').all(workspace);
    for(const entry of entries) {
      const path=join(base,entry.name);
      if(!entry.isDirectory()||!/^[a-f0-9]{20}$/.test(entry.name)||store.db.prepare('SELECT 1 FROM managed_worktrees WHERE path=?').get(path))continue;
      try {
        const common=resolve(path,(await git(path,'rev-parse','--git-common-dir')).trim());
        const repository=await fs.realpath(join(common,'..'));
        const task=tasks.find(t=>createHash('sha256').update(`${t.key}\0${repository}`).digest('hex').slice(0,20)===entry.name);
        if(!task)continue;
        // Existing worktrees get a full observation window before the first automatic removal.
        registerWorktree(store,String(task.key),workspace,path,repository,(await git(path,'branch','--show-current')).trim(),now);
      }catch{}
    }
  }
}
async function preserve(store:Store,row:Tracked,now:number) {
  const folder=join(store.dir,'worktree-recovery',String(now)+'-'+randomUUID());
  await fs.mkdir(folder,{recursive:true,mode:0o700});
  const head=(await git(row.path,'rev-parse','HEAD')).trim();
  const branch=(await git(row.path,'branch','--show-current')).trim();
  const status=await git(row.path,'status','--porcelain=v1','--untracked-files=all');
  await fs.writeFile(join(folder,'unstaged.patch'),await git(row.path,'diff','--binary'),{mode:0o600});
  await fs.writeFile(join(folder,'staged.patch'),await git(row.path,'diff','--cached','--binary'),{mode:0o600});
  // Preserve ignored local config as well as ordinary untracked source; skip rebuildable caches.
  const caches=new Set(['.git','node_modules','.gradle','.cache','.next','.nuxt','.turbo','.venv','venv','__pycache__']);
  const untracked=(await git(row.path,'ls-files','--others','-z')).split('\0').filter(Boolean).filter(p=>!p.split('/').some(c=>caches.has(c)));
  if(untracked.some(p=>isAbsolute(p)||p.split('/').includes('..')))throw new Error('Invalid untracked path');
  if(untracked.length) {
    const list=join(folder,'untracked.list');await fs.writeFile(list,untracked.join('\0')+'\0',{mode:0o600});
    await exec('tar',['-czf',join(folder,'untracked.tar.gz'),'-C',row.path,'--null','--verbatim-files-from','--no-recursion','-T',list],{timeout:120_000});
    await exec('tar',['-dzf',join(folder,'untracked.tar.gz'),'-C',row.path],{timeout:120_000});
    await fs.unlink(list);
  }
  if(!branch){await git(row.path,'bundle','create',join(folder,'head.bundle'),'HEAD');await git(row.path,'bundle','verify',join(folder,'head.bundle'));}
  await fs.writeFile(join(folder,'metadata.json'),JSON.stringify({task:row.task,path:row.path,repository:row.repository,head,branch,status,at:now},null,2)+'\n',{mode:0o600});
  return folder;
}
export async function cleanupWorktrees(store:Store,options:Options={}) {
  ensureWorktreeStorage(store);
  const now=options.now??Date.now;const token=randomUUID();
  const acquired=store.transaction(()=>{
    const lease=store.meta('worktreeCleanupLease');if(lease?.until>now())return false;
    store.meta('worktreeCleanupLease',{token,until:now()+10*60*1000});return true;
  });
  if(!acquired)return;
  let removed=0,scanned=0;
  try {
    await discover(store,now());
    // A previous process may have stopped after claiming a tree.
    store.db.prepare("UPDATE managed_worktrees SET state='active' WHERE state='deleting'").run();
    const rows=store.db.prepare("SELECT * FROM managed_worktrees WHERE state='active'").all() as unknown as Tracked[];
    for(const row of rows) {
      if(store.meta('worktreeCleanupLease')?.token!==token)return;
      store.meta('worktreeCleanupLease',{token,until:now()+10*60*1000});
      try {
        const task=store.task(row.task);if(!task)continue;
        try{await fs.access(row.path);}catch(e:any){if(e.code!=='ENOENT')throw e;store.db.prepare("UPDATE managed_worktrees SET state='removed',removed=? WHERE path=?").run(now(),row.path);continue;}
        await validate(store,row);
        const snapshot=await worktreeSnapshot(row.path);scanned++;
        const changed=!!row.fingerprint&&row.fingerprint!==snapshot.fingerprint;
        const filesAt=Math.max(row.files_at,snapshot.latest,changed?now():0);
        store.db.prepare('UPDATE managed_worktrees SET files_at=?,fingerprint=?,last_scan=?,error=NULL WHERE path=?').run(filesAt,snapshot.fingerprint,now(),row.path);
        if(taskBusy(store,task)||now()-Math.max(filesAt,taskActivity(store,task))<WORKTREE_IDLE_MS)continue;
        if(await (options.inUse??processUses)(row.path))continue;
        const recovery=await preserve(store,row,now());
        const latest=await worktreeSnapshot(row.path);
        const current=store.task(row.task);
        if(latest.fingerprint!==snapshot.fingerprint||!current||taskBusy(store,current)||now()-taskActivity(store,current)<WORKTREE_IDLE_MS)continue;
        if(await (options.inUse??processUses)(row.path))continue;
        const claimed=store.transaction(()=>{
          if(store.meta('worktreeCleanupLease')?.token!==token)return false;
          const latestTask=store.task(row.task);
          if(!latestTask||taskBusy(store,latestTask)||now()-taskActivity(store,latestTask)<WORKTREE_IDLE_MS)return false;
          store.db.prepare("UPDATE managed_worktrees SET state='deleting',recovery=? WHERE path=?").run(recovery,row.path);return true;
        });
        if(!claimed)continue;
        await git(row.repository,'worktree','remove','--force',row.path);
        store.db.prepare("UPDATE managed_worktrees SET state='removed',removed=?,error=NULL WHERE path=?").run(now(),row.path);
        removed++;
      }catch(e:any){store.db.prepare("UPDATE managed_worktrees SET state='active',error=? WHERE path=?").run(redact(String(e.message)).slice(0,1000),row.path);}
    }
    store.meta('worktreeCleanup',{at:now(),scanned,removed,retentionHours:24});
  }finally{
    if(store.meta('worktreeCleanupLease')?.token===token)store.meta('worktreeCleanupLease',{token:null,until:now()+interval});
  }
}
