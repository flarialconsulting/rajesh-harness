import {createReadStream,createWriteStream,existsSync,lstatSync,mkdirSync,readdirSync,readFileSync,renameSync,rmSync,statSync,unlinkSync,writeFileSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {join,resolve,dirname,relative,isAbsolute} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createGunzip,createZstdCompress,createZstdDecompress,constants} from 'node:zlib';
import {Readable,Transform,Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createInterface} from 'node:readline';
import {DatabaseSync} from 'node:sqlite';
import type {Config,Workspace} from './config.js';
import type {Store} from './store.js';
import {retainedEvent} from './history-retention.js';

const DAY=86400000;
function syncFile(path:string) {const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
function syncDirectory(path:string) {syncFile(dirname(path));}
function signature(path:string) {const s=lstatSync(path);if(!s.isFile())throw new Error('History source must be a regular file');return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;}
function within(root:string,path:string) {const r=relative(resolve(root),resolve(path));return !!r&&!r.startsWith('..')&&!isAbsolute(r);}
function lock(path:string):(()=>void)|undefined {
  const folder=path+'.history-lock';
  try{mkdirSync(folder,{mode:0o700});}
  catch(e:any) {
    if(e.code!=='EEXIST')throw e;
    const reaper=folder+'.reaper';
    try{mkdirSync(reaper,{mode:0o700});}catch{return;}
    try {
      const owner=JSON.parse(readFileSync(join(folder,'owner.json'),'utf8'));
      if(!Number.isSafeInteger(owner.pid)||owner.pid<=0)return;
      try{process.kill(owner.pid,0);return;}catch(error:any){if(error.code!=='ESRCH')return;}
      rmSync(folder,{recursive:true});
    }catch{return;}finally{rmSync(reaper,{recursive:true});}
    return lock(path);
  }
  writeFileSync(join(folder,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600});
  return ()=>rmSync(folder,{recursive:true});
}
async function waitLock(path:string) {
  const deadline=Date.now()+180000;
  while(Date.now()<deadline) {const release=lock(path);if(release)return release;await new Promise(r=>setTimeout(r,100));}
  throw new Error('History maintenance is busy; retry resume shortly');
}
function decoded(path:string,zstd=false):Readable {
  const input=createReadStream(path);
  if(!zstd&&!path.endsWith('.gz')&&!path.endsWith('.zst'))return input;
  const decoder=!zstd&&path.endsWith('.gz')?createGunzip():createZstdDecompress();
  input.on('error',e=>decoder.destroy(e));decoder.on('close',()=>input.destroy());return input.pipe(decoder);
}
async function digest(input:Readable) {
  const hash=createHash('sha256');let bytes=0;
  await pipeline(input,new Writable({write(chunk,_encoding,callback){hash.update(chunk);bytes+=chunk.length;callback();}}));
  return {sha256:hash.digest('hex'),bytes};
}
// The caller holds the source lock. Both writing and verification stream with bounded memory.
async function pack(input:Readable,target:string) {
  const temp=target+'.'+randomUUID()+'.tmp';const hash=createHash('sha256');let bytes=0;
  const meter=new Transform({transform(chunk,_encoding,callback){hash.update(chunk);bytes+=chunk.length;callback(null,chunk);}});
  try {
    await pipeline(input,meter,createZstdCompress({params:{[constants.ZSTD_c_compressionLevel]:19,[constants.ZSTD_c_checksumFlag]:1}}),createWriteStream(temp,{flags:'wx',mode:0o600}));
    const expected={sha256:hash.digest('hex'),bytes};
    const verified=await digest(decoded(temp,true));
    if(verified.sha256!==expected.sha256||verified.bytes!==bytes)throw new Error('Compressed history failed verification');
    syncFile(temp);return {temp,...expected,compressedBytes:statSync(temp).size};
  }catch(error){rmSync(temp,{force:true});throw error;}
}
function saveJson(path:string,value:unknown) {
  mkdirSync(dirname(path),{recursive:true,mode:0o700});const temp=path+'.'+randomUUID()+'.tmp';
  try{writeFileSync(temp,JSON.stringify(value)+'\n',{mode:0o600,flush:true});renameSync(temp,path);syncDirectory(path);}
  finally{rmSync(temp,{force:true});}
}
function registry(config:Config,id:string) {
  if(!/^[a-zA-Z0-9_-]+$/.test(id))throw new Error('Invalid history thread id');
  return join(config.dataDir,'history-retention','sessions',id+'.json');
}
function sessionPath(config:Config,path:string) {
  if(!['sessions','archived_sessions'].some(root=>within(join(config.codexHome,root),path)))throw new Error('Session path is outside Codex history');
  // Reject symlinks in any component, including a redirected sessions directory.
  for(let p=resolve(path);p!==resolve(config.codexHome);p=dirname(p))if(existsSync(p)&&lstatSync(p).isSymbolicLink())throw new Error('Session path contains a symlink');
  if(!path.endsWith('.jsonl'))throw new Error('Unexpected session extension');
  return path;
}
export async function restoreSession(config:Config,id:string):Promise<string|undefined> {
  const index=registry(config,id);if(!existsSync(index))return;
  const entry=JSON.parse(readFileSync(index,'utf8'));if(entry.thread!==id)throw new Error('History registry thread mismatch');
  const path=sessionPath(config,entry.path),release=await waitLock(path);
  const temp=path+'.'+randomUUID()+'.restore';
  try {
    if(existsSync(path)) {
      // The plaintext rename may have completed before a crash, or newer work replaced it.
      // Keep the older compressed copy until a later verified maintenance pass.
      return path;
    }
    const hash=createHash('sha256');let bytes=0;
    await pipeline(createReadStream(path+'.zst'),createZstdDecompress(),new Transform({transform(chunk,_encoding,callback){hash.update(chunk);bytes+=chunk.length;callback(null,chunk);}}),createWriteStream(temp,{flags:'wx',mode:0o600}));
    if(hash.digest('hex')!==entry.sha256||bytes!==entry.bytes)throw new Error('Archived session integrity check failed');
    syncFile(temp);renameSync(temp,path);syncDirectory(path);
    unlinkSync(path+'.zst');unlinkSync(index);syncDirectory(path);return path;
  }finally{rmSync(temp,{force:true});release();}
}
export async function compressSession(config:Config,id:string,path:string,eligible:()=>boolean=()=>true) {
  sessionPath(config,path);const release=lock(path);if(!release)return false;
  let temp:string|undefined;
  try {
    if(!existsSync(path)||!eligible())return false;
    const before=signature(path);const packed=await pack(createReadStream(path),path+'.zst');temp=packed.temp;
    if(signature(path)!==before||!eligible()||packed.compressedBytes>=packed.bytes)return false;
    renameSync(temp,path+'.zst');temp=undefined;syncDirectory(path);
    // Publish the restore registry before removing the original, including on crashes.
    saveJson(registry(config,id),{thread:id,path,sha256:packed.sha256,bytes:packed.bytes,compressedBytes:packed.compressedBytes});
    if(signature(path)!==before||!eligible())return false;
    unlinkSync(path);syncDirectory(path);return true;
  }finally{if(temp)rmSync(temp,{force:true});release();}
}
export async function compactArchive(path:string) {
  const release=lock(path);if(!release)return {changed:false,kept:0,dropped:0,saved:0};
  let temp:string|undefined;let kept=0,dropped=0;
  try {
    const before=signature(path),original=statSync(path).size;
    async function* records() {
      const input=decoded(path),lines=createInterface({input,crlfDelay:Infinity});
      let inputError:Error|undefined;input.on('error',e=>{inputError=e;lines.close();});
      try {
        for await(const line of lines) {
          if(!line.trim())continue;
          const value=retainedEvent(JSON.parse(line));
          if(value===null){dropped++;continue;}kept++;yield JSON.stringify(value)+'\n';
        }
        if(inputError)throw inputError;
      }finally{lines.close();input.destroy();}
    }
    const packed=await pack(Readable.from(records()),path+'.retained.zst');temp=packed.temp;
    if(signature(path)!==before)return {changed:false,kept,dropped,saved:0};
    const target=path.replace(/\.jsonl(?:\.gz)?$/, '')+`.retained-${packed.sha256.slice(0,24)}.jsonl.zst`;
    renameSync(temp,target);temp=undefined;syncDirectory(target);
    // This only operates on closed-day shards. Current-day append files stay untouched.
    if(signature(path)!==before)return {changed:false,kept,dropped,saved:0};
    unlinkSync(path);syncDirectory(path);
    return {changed:true,kept,dropped,saved:original-packed.compressedBytes};
  }finally{if(temp)rmSync(temp,{force:true});release();}
}
function* walk(root:string):Generator<string> {
  if(!existsSync(root))return;
  for(const entry of readdirSync(root,{withFileTypes:true})) {
    const path=join(root,entry.name);if(entry.isDirectory()&&!entry.name.endsWith('.history-lock'))yield* walk(path);else if(entry.isFile())yield path;
  }
}
function stateDb(config:Config) {
  const file=readdirSync(config.codexHome).filter(n=>/^state_\d+\.sqlite$/.test(n)).sort((a,b)=>Number(b.match(/\d+/)![0])-Number(a.match(/\d+/)![0]))[0];
  return file?new DatabaseSync(join(config.codexHome,file),{readOnly:true}):undefined;
}
export interface RetentionReport {workspace:string;archives:number;sessions:number;kept:number;dropped:number;legacyToolMessages:number;savedBytes:number;errors:number;complete:boolean}
export async function retainHistory(config:Config,store:Store,workspace:Workspace,limit=Infinity):Promise<RetentionReport> {
  const report:RetentionReport={workspace,archives:0,sessions:0,kept:0,dropped:0,legacyToolMessages:0,savedBytes:0,errors:0,complete:true};
  const root=join(config.dataDir,'history-retention');mkdirSync(root,{recursive:true,mode:0o700});
  const release=lock(join(root,workspace));if(!release){report.complete=false;return report;}
  let visited=0;
  try {
    // These are imported tool responses, explicitly distinguished from human messages.
    const removeTools=store.db.prepare("DELETE FROM messages WHERE id IN (SELECT id FROM messages WHERE workspace=? AND platform='legacy' AND author='toolResult' LIMIT 500)");
    for(;;) {const result=removeTools.run(workspace);report.legacyToolMessages+=Number(result.changes);if(!result.changes)break;await new Promise(r=>setImmediate(r));}
    for(const path of walk(join(config.dataDir,'archive',workspace))) {
      if(!/\.jsonl(?:\.gz)?$/.test(path)||statSync(path).mtimeMs>Date.now()-DAY)continue;
      if(visited++>=limit){report.complete=false;break;}
      try{const result=await compactArchive(path);if(result.changed){report.archives++;report.kept+=result.kept;report.dropped+=result.dropped;report.savedBytes+=result.saved;}}
      catch{report.errors++;}
    }
    if(visited>=limit){report.complete=false;return report;}
    const db=stateDb(config);if(!db)return report;
    try {
      const managed=new Map<string,any[]>();
      for(const task of store.db.prepare('SELECT key,cwd,thread,status FROM tasks WHERE workspace=?').all(workspace)) {
        const list=managed.get(String(task.cwd))??[];list.push(task);managed.set(String(task.cwd),list);
      }
      const busy=store.db.prepare("SELECT 1 FROM tasks WHERE cwd=? AND (status IN ('running','queued','compacting') OR EXISTS (SELECT 1 FROM jobs WHERE jobs.task=tasks.key AND jobs.state IN ('queued','running','steering'))) LIMIT 1");
      for(const row of db.prepare('SELECT id,rollout_path,cwd FROM threads').all()) {
        const path=String(row.rollout_path),cwd=String(row.cwd);
        // Native child agents can resume one another without going through Rajesh.
        // Only archive root threads for which this bot owns the resume boundary.
        if(!managed.get(cwd)?.some(task=>task.thread===row.id)||!existsSync(path)||statSync(path).mtimeMs>Date.now()-DAY||busy.get(cwd))continue;
        if(visited++>=limit){report.complete=false;break;}
        try {
          const before=statSync(path).size;
          if(await compressSession(config,String(row.id),path,()=>!busy.get(cwd)&&statSync(path).mtimeMs<Date.now()-DAY)) {report.sessions++;report.savedBytes+=before-statSync(path+'.zst').size;}
        }catch{report.errors++;}
      }
    }finally{db.close();}
    return report;
  }finally{release();}
}
const worker=Symbol.for('rajesh.historyRetention');
export function startHistoryRetention(config:Config,store:Store) {
  if(!config.runtime||process.env.RAJESH_VALIDATING==='1')return;
  const globals=globalThis as any;if(globals[worker])return;
  let pending=false;
  const timer=setInterval(()=>{
    if(pending)return;pending=true;
    void (async()=>{
      for(const workspace of Object.keys(config.workspaces))if(config.historyRetention||store.meta(`historyRetention:${workspace}`)?.enabled) {
        const report=await retainHistory(config,store,workspace,50);
        store.meta(`historyRetentionLast:${workspace}`,{...report,at:Date.now()});
      }
    })().catch(()=>{}).finally(()=>{pending=false;});
  },3600000);timer.unref();globals[worker]=timer;
}
