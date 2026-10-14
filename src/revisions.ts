import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, copyFileSync, realpathSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig, type Config } from './config.js';
import { commitRevision } from './version-control.js';

const exec=promisify(execFile);
const roots=['src','test'];
const files=['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','config.json'];
const optionalRoots=['scripts','examples','docs','.github'];
const optionalFiles=['README.md','.gitignore','AGENTS.md','LICENSE','SECURITY.md','CONTRIBUTING.md','tsconfig.tools.json'];
export function sourceFiles(root:string):string[] {
  const walk=(dir:string):string[]=>readdirSync(join(root,dir),{withFileTypes:true}).flatMap(e=>{
    if(e.name==='__pycache__'||e.name.endsWith('.pyc')||e.name.endsWith('.log'))return [];
    if(e.isSymbolicLink())throw new Error('Runtime source cannot contain symlinks');
    const path=join(dir,e.name);return e.isDirectory()?walk(path):[path];
  });
  return [...files,...optionalFiles.filter(file=>existsSync(join(root,file))),...[...roots,...optionalRoots.filter(dir=>existsSync(join(root,dir)))].flatMap(walk)].sort();
}
export function fingerprint(root:string) {
  const hash=createHash('sha256');
  for(const file of sourceFiles(root))hash.update(file.replaceAll('\\','/')).update('\0').update(readFileSync(join(root,file))).update('\0');
  return hash.digest('hex');
}
export function copySource(from:string,to:string) {
  mkdirSync(to,{recursive:true,mode:0o700});
  for(const dir of roots)mkdirSync(join(to,dir),{recursive:true,mode:0o700});
  for(const file of sourceFiles(from)) {const target=join(to,file);mkdirSync(join(target,'..'),{recursive:true,mode:0o700});copyFileSync(join(from,file),target);}
}
export function atomicJson(path:string,value:unknown) {
  mkdirSync(join(path,'..'),{recursive:true,mode:0o700});
  const temp=`${path}.${randomUUID()}.tmp`;writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(temp,path);
}
export interface Revision {id:string;path:string;published:number;gitCommit?:string}
export class Revisions {
  current?:Revision;
  pending?:Promise<Revision>;
  lastAttempt='';
  constructor(public source:string,public config:Config,public report:(value:unknown)=>void) {
    const pointer=join(this.base,'current.json');
    if(existsSync(pointer))this.current=JSON.parse(readFileSync(pointer,'utf8'));
  }
  get base(){return join(this.config.dataDir,'runtime');}
  async validate(path:string) {
    const options={cwd:path,timeout:240000,maxBuffer:2*1024*1024,env:{...process.env,NODE_ENV:'development',CI:'true',RAJESH_VALIDATING:'1'}};
    // Each revision has its own dependency tree and lockfile. No symlink to the editable project's node_modules.
    await exec('pnpm',['--ignore-workspace','install','--frozen-lockfile','--package-import-method=copy'],options);
    await exec('pnpm',['check'],options);
    await exec('pnpm',['test'],options);
    await exec(process.execPath,['--import','tsx','--input-type=module','-e',`for (const [name, exported] of [['engine','Engine'],['discord','DiscordAdapter'],['whatsapp','WhatsAppAdapter'],['models','ModelCommands'],['store','Store'],['redact','loadRedactions']]) { const module=await import('./src/'+name+'.ts'); if(typeof module[exported]!=='function')throw new Error('Missing runtime export: '+exported); }`],options);
    const candidate=loadConfig(join(path,'config.json'));
    for(const key of ['dataDir','secretsDir','codexHome'] as const)if(candidate[key]!==this.config[key])throw new Error(`${key} cannot change during live publication`);
    if(['whatsappGroup','whatsappWorkspace','whatsappAccount'].some(key=>candidate[key as keyof Config]!==this.config[key as keyof Config]))throw new Error('Changing WhatsApp account/group requires a planned migration');
    if(JSON.stringify(candidate.workspaces)!==JSON.stringify(this.config.workspaces))throw new Error('Changing workspaces requires a restart');
    if(candidate.timezone!==this.config.timezone)throw new Error('Changing the schedule timezone requires a restart');
    const accounts=new Set(this.config.routes.map(r=>r.account));
    if(candidate.routes.some(r=>!accounts.has(r.account)))throw new Error('Adding a bot account requires a planned connection migration');
    if(!Number.isInteger(candidate.concurrency)||candidate.concurrency<1||candidate.concurrency>32)throw new Error('Invalid concurrency');
    const {probe}=await import('./update.js');
    await probe(candidate.codex,candidate,false);
  }
  async refresh(force=false):Promise<Revision> {
    if(this.pending)return this.pending;
    let id:string;
    try{id=fingerprint(this.source);}catch(e:any){this.report({state:'rejected',current:this.current?.id,error:e.message,time:Date.now()});throw e;}
    if((this.current?.id===id&&this.current.gitCommit)||(!force&&this.lastAttempt===id&&this.current))return this.current;
    this.lastAttempt=id;
    this.pending=this.stage(this.source,id).finally(()=>{this.pending=undefined;});
    return this.pending;
  }
  async stage(source:string,id:string,expected?:string):Promise<Revision> {
    this.report({state:'validating',candidate:id,current:this.current?.id,time:Date.now()});
    try {
      const stage=join(this.base,'staging',randomUUID());copySource(source,stage);
      if(fingerprint(stage)!==id)throw new Error('Source changed during snapshot; retry publication');
      await this.validate(stage);
      if(fingerprint(stage)!==id||fingerprint(source)!==id)throw new Error('Source changed during validation; retry publication');
      if(expected!==undefined&&fingerprint(this.source)!==expected)throw new Error('Canonical source changed while draft was being validated; rebase the draft');
      const path=join(this.base,'revisions',id);mkdirSync(join(path,'..'),{recursive:true,mode:0o700});
      if(!existsSync(path))renameSync(stage,path);
      if(source!==this.source) {
        const previousFiles=sourceFiles(this.source),nextFiles=new Set(sourceFiles(source));
        // Serialized with the watcher. Existing tasks never import from the mutable canonical directory.
        for(const file of sourceFiles(source)) {
          const target=join(this.source,file);mkdirSync(join(target,'..'),{recursive:true});
          const temp=target+'.publish';copyFileSync(join(source,file),temp);renameSync(temp,target);
        }
        for(const file of previousFiles)if(!nextFiles.has(file))unlinkSync(join(this.source,file));
        if(fingerprint(this.source)!==id)throw new Error('Canonical source changed during publication');
      }
      const gitCommit=commitRevision(this.source,path,id,sourceFiles(path),[join(this.config.secretsDir,'credentials.json'),join(this.config.codexHome,'auth.json')]);
      const revision={id,path,published:Date.now(),gitCommit};
      atomicJson(join(this.base,'current.json'),revision);this.current=revision;this.lastAttempt=id;
      this.report({state:'ready',current:id,gitCommit,time:Date.now()});return revision;
    } catch(e:any) {
      this.report({state:'rejected',current:this.current?.id,candidate:id,error:String(e.message).slice(0,2000),time:Date.now()});
      if(this.current)return this.current;throw e;
    }
  }
  prepare(task:string) {
    if(!this.current)throw new Error('No validated runtime');
    const path=join(this.base,'drafts',randomUUID());copySource(this.current.path,path);
    atomicJson(join(path,'draft.json'),{task,base:this.current.id,sourceHash:fingerprint(this.source)});
    return {path,base:this.current.id,baseCommit:this.current.gitCommit,instructions:'Edit this draft. Use pnpm add for dependencies. publish_self_edit validates, commits the changes to Git, and publishes them for persistent conversations between turns. Active turns keep their current code.'};
  }
  async publish(task:string,path:string) {
    if(this.pending)await this.pending;
    const resolved=realpathSync(path),base=realpathSync(join(this.base,'drafts'));
    if(relative(base,resolved).startsWith('..')||resolved===base)throw new Error('Expected a prepared runtime draft');
    const draft=JSON.parse(readFileSync(join(resolved,'draft.json'),'utf8'));
    if(draft.task!==task||draft.base!==this.current?.id||draft.sourceHash!==fingerprint(this.source))throw new Error('Stale or foreign draft; prepare a fresh draft and reapply your changes');
    const id=fingerprint(resolved);
    this.pending=this.stage(resolved,id,draft.sourceHash).finally(()=>{this.pending=undefined;});
    const revision=await this.pending;
    if(revision.id!==id)throw new Error('Draft rejected. Inspect runtime_status for validation details.');
    return revision;
  }
}
