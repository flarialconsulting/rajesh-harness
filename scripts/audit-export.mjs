import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',maxBuffer:32*1024*1024});
const files=git('ls-files','-z').split('\0').filter(Boolean);
const privatePath=/(^|\/)(?:config\.json|credentials\.json|auth\.json|\.env(?:\..*)?|\.secrets|\.local|data|storage|node_modules|workspace|workspaces|memory|memories|skills|runtime)(\/|$)|\.(?:sqlite(?:-wal|-shm)?|pem|key|log)$/;
const patterns=[
 ['private key',/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
 ['GitHub token',/\b(?:gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{40,})\b/],
 ['API key',/\bsk-[a-zA-Z0-9_-]{24,}\b/],
 ['AWS access key',/\bAKIA[A-Z0-9]{16}\b/],
 ['Discord webhook',/https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/\d+\/[\w-]+/],
 ['private network hostname',/\b[\w.-]+\.ts\.net\b/],
 ['automatic root identity',/\broot@[^\s>]+/],
 ['home directory',/\/(?:root|home\/[^/\s]+|Users\/[^/\s]+)\//],
];
const findings=[];
for(const file of files){
 if(privatePath.test(file))findings.push([file,'private path']);
 if(lstatSync(file).isSymbolicLink()){findings.push([file,'symlink']);continue;}
 const text=readFileSync(file,'utf8');
 for(const [rule,pattern] of patterns)if(pattern.test(text))findings.push([file,rule]);
}
// Inspect every reachable commit. Working-tree checks alone miss deleted secrets.
for(const commit of git('rev-list','--all').trim().split('\n').filter(Boolean)){
 const metadata=git('show','--no-patch','--format=fuller',commit);
 for(const [rule,pattern] of patterns)if(pattern.test(metadata))findings.push([commit,`${rule} in commit metadata`]);
 for(const file of git('ls-tree','-r','--name-only',commit).trim().split('\n').filter(Boolean)){
  if(privatePath.test(file))findings.push([file,'private path in history']);
  const text=git('show',`${commit}:${file}`);
  for(const [rule,pattern] of patterns)if(pattern.test(text))findings.push([file,`${rule} in history`]);
 }
}
if(findings.length){for(const [file,rule] of findings)console.error(`${file}: ${rule}`);process.exit(1);}
console.log(`Export audit passed: ${files.length} tracked files and all reachable commits. Run a dedicated secret scanner before publication too.`);
