import test from 'node:test';
import assert from 'node:assert/strict';
import { Rpc } from '../src/rpc.js';
test('resume skips history and gets a longer deadline without changing other RPCs or explicit overrides',async t=>{
  const rpc=Object.create(Rpc.prototype) as Rpc;
  rpc.sequence=0;rpc.pending=new Map();
  const sent:any[]=[],delays:number[]=[];
  const timer=setTimeout;
  t.mock.method(globalThis,'setTimeout',((fn:any,delay:number,...args:any[])=>{
    delays.push(delay);return timer(fn,delay,...args);
  }) as any);
  rpc.child={stdin:{write:(line:string)=>{
    const message=JSON.parse(line);sent.push(message);
    queueMicrotask(()=>{const p=rpc.pending.get(message.id)!;clearTimeout(p.timer);rpc.pending.delete(message.id);p.resolve({thread:{id:'saved'}});});
  }}} as any;
  await rpc.request('thread/resume',{threadId:'saved'});
  await rpc.request('turn/start',{threadId:'saved'});
  await rpc.request('thread/resume',{threadId:'saved',excludeTurns:false},1234);
  assert.deepEqual(delays,[180000,60000,1234]);
  assert.equal(sent[0].params.excludeTurns,true);
  assert.equal(sent[1].params.excludeTurns,undefined);
  assert.equal(sent[2].params.excludeTurns,false);
  assert.equal(rpc.pending.size,0);
});

test('stderr diagnostics classify split retry messages without exposing stderr contents',async t=>{
  const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const root=mkdtempSync(join(tmpdir(),'rpc-diagnostics-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const binary=join(root,'fixture');
  writeFileSync(binary,`#!${process.execPath}\nprocess.stderr.write('secret-value stream dis');setTimeout(()=>{process.stderr.write('connected, reconnecting\\n429 rate limit with private-token\\nrequest timed out\\n');process.exit(0);},20);`,{mode:0o700});
  const rpc=new Rpc(binary,[],{...process.env,CODEX_HOME:root});const diagnostics:string[]=[];
  rpc.on('diagnostic',kind=>diagnostics.push(kind));await new Promise<void>(r=>rpc.once('closed',()=>r()));
  assert.deepEqual(diagnostics,['connection_retry','rate_limit','timeout']);
  assert.ok(!JSON.stringify(diagnostics).includes('secret'));assert.ok(!JSON.stringify(diagnostics).includes('private'));
});

test('a child that closes stdin rejects pending RPCs without an unhandled pipe error',async t=>{
  const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');
  const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const root=mkdtempSync(join(tmpdir(),'rpc-pipe-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const binary=join(root,'closed.cjs');
  writeFileSync(binary,`#!${process.execPath}\nprocess.exit(0);`,{mode:0o700});
  const rpc=new Rpc(binary,[],{...process.env,CODEX_HOME:root});
  const closed=new Promise<void>(resolve=>rpc.once('closed',()=>resolve()));
  await assert.rejects(rpc.request('initialize',{padding:'x'.repeat(1024*1024)}),/EPIPE|exited/);
  await closed;assert.equal(rpc.pending.size,0);
});
