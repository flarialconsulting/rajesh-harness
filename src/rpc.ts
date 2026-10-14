import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parse } from 'smol-toml';

export class Rpc extends EventEmitter {
  child: ChildProcessWithoutNullStreams;
  sequence=0; pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  constructor(binary: string, args: string[]=[], env=process.env) {
    super();
    // Empty tables merge with the user config. Explicitly disable inherited entries instead.
    const path=join(env.CODEX_HOME??join(homedir(),'.codex'),'config.toml');
    const inherited:any=existsSync(path)?parse(readFileSync(path,'utf8')):{};
    const disabled=(entries:any)=>'{'+Object.keys(entries??{}).map(name=>`${JSON.stringify(name)}={enabled=false}`).join(',')+'}';
    const isolated=['-c',`mcp_servers=${disabled(inherited.mcp_servers)}`,'-c',`plugins=${disabled(inherited.plugins)}`];
    this.child=spawn(binary,['app-server',...isolated,...args],{stdio:'pipe',env,windowsHide:true,detached:process.platform!=='win32'});
    createInterface({input:this.child.stdout}).on('line',line=>{
      let m:any; try {m=JSON.parse(line);} catch {return;}
      if (m.id!==undefined && !m.method) {
        const p=this.pending.get(m.id); if (!p) return;
        clearTimeout(p.timer);this.pending.delete(m.id);
        m.error?p.reject(Object.assign(new Error(m.error.message),{code:m.error.code})):p.resolve(m.result);
      } else if (m.method && m.id!==undefined) this.emit('request',m);
      else this.emit('notification',m);
    });
    // Do not dump harness stderr: it can contain prompts or credentials from tools.
    let stderr='';
    this.child.stderr.on('data',chunk=>{
      stderr=(stderr+chunk.toString()).slice(-8192);
      const lines=stderr.split('\n');stderr=lines.pop()!.slice(-4096);
      for(const line of lines) {
        const kind=/429|rate.?limit/i.test(line)?'rate_limit':/reconnect|retrying|stream disconnected/i.test(line)?'connection_retry':/timed? ?out/i.test(line)?'timeout':undefined;
        if(kind)this.emit('diagnostic',kind);
      }
    });
    this.child.stdin.on('error',e=>this.fail(e));
    this.child.on('error',e=>this.fail(e));
    this.child.on('exit',code=>{this.fail(new Error(`Codex exited (${code})`));this.emit('closed',code);});
  }
  fail(error: Error) { for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear(); }
  request(method:string,params:any={},timeout=method==='thread/resume'?180000:60000):Promise<any> {
    // Rajesh needs the resumed ID, not a copy of every historical turn.
    if(method==='thread/resume')params={excludeTurns:true,...params};
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Codex RPC timeout: ${method}`));},timeout);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({id,method,params})+'\n',e=>{if(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});
    });
  }
  notify(method:string,params?:any) {this.child.stdin.write(JSON.stringify({method,...(params?{params}:{})})+'\n');}
  respond(id:any,result:any) {this.child.stdin.write(JSON.stringify({id,result})+'\n');}
  reject(id:any,message:string) {this.child.stdin.write(JSON.stringify({id,error:{code:-32601,message}})+'\n');}
  async initialize() {
    await this.request('initialize',{clientInfo:{name:'rajesh',title:'Rajesh',version:'1.0.0'},capabilities:{experimentalApi:true}});
    this.notify('initialized');
  }
  close() {
    if(process.platform==='win32'||!this.child.pid){this.child.kill('SIGTERM');return;}
    const group=-this.child.pid;
    try{process.kill(group,'SIGTERM');}catch{}
    const timer=setTimeout(()=>{try{process.kill(group,'SIGKILL');}catch{}},2000);timer.unref();
  }
}
