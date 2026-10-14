import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, existsSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import type { Config, Workspace } from './config.js';
const within=(root:string,path:string)=>{const rel=relative(root,path);return rel===''||(!rel.startsWith('..')&&!isAbsolute(rel));};
export function createWorktree(config:Config,workspace:Workspace,taskKey:string,repository:string) {
  const root=realpathSync(config.workspaces[workspace]);
  const repo=realpathSync(repository);
  if(!within(root,repo)) throw new Error('Repository must be inside the current workspace');
  const git=(...args:string[])=>execFileSync('git',['-c',`safe.directory=${repo}`,'-C',repo,...args],{encoding:'utf8',timeout:60000}).trim();
  if(realpathSync(git('rev-parse','--show-toplevel'))!==repo) throw new Error('Specify the actual repository root');
  const id=createHash('sha256').update(taskKey+'\0'+repo).digest('hex').slice(0,20);
  const base=join(config.dataDir,'worktrees',workspace); mkdirSync(base,{recursive:true});
  const path=join(base,id),branch=`rajesh/${id}`;
  if(existsSync(path)) {
    const all=git('worktree','list','--porcelain');
    if(!all.split('\n').filter(line=>line.startsWith('worktree ')).some(line=>existsSync(line.slice(9))&&realpathSync(line.slice(9))===realpathSync(path))) throw new Error('Existing path is not a registered worktree');
    return {path,branch,reused:true};
  }
  if(git('branch','--list',branch)) git('worktree','add',path,branch);
  else git('worktree','add','-b',branch,path,'HEAD');
  return {path,branch,reused:false};
}
