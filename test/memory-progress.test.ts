import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Memory } from '../src/memory.js';
import { Store } from '../src/store.js';
import { Progress,renderTools,toolLine } from '../src/progress.js';
test('manual memory persists, isolates workspaces and rejects stale updates/deletes',t=>{
 const dir=mkdtempSync(join(tmpdir(),'memory-test-'));const a=new Memory(join(dir,'default')),b=new Memory(join(dir,'secondary')),again=new Memory(join(dir,'default'));
 t.after(()=>{a.lock.close();b.lock.close();again.lock.close();rmSync(dir,{recursive:true,force:true});});
 assert.equal(a.read().notes.length,0);const note=a.write('Use pnpm for projects.');
 assert.equal(again.read('pnpm').notes[0].text,note.text);assert.equal(b.read().notes.length,0);
 const newer=again.write('Use pnpm and exact versions.',note.id,note.revision);
 assert.throws(()=>a.write('stale',note.id,note.revision),/changed/);assert.throws(()=>a.delete(note.id,note.revision),/changed/);
 a.delete(note.id,newer.revision);assert.equal(again.read().notes.length,0);
});
function setup(t:any){const dir=mkdtempSync(join(tmpdir(),'progress-test-')),store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});const task:any={key:'task',workspace:'secondary',platform:'whatsapp',account:'secondary',channel:'group@g.us',parent:'group@g.us',model:'luna',effort:'low',thread:null,cwd:dir,status:'queued'};store.saveTask(task);return{store,task,progress:new Progress(store)};}
test('WhatsApp reactions follow durable job states and do not complete queued replies early',async t=>{
 const {store,task,progress}=setup(t),sent:string[]=[];store.meta('whatsapp',{ready:true});
 progress.socket=()=>({sendMessage:async(_:string,p:any)=>sent.push(p.react.text)});
 const id='whatsapp:group@g.us:one';store.record({id,platform:'whatsapp',workspace:'secondary',channel:task.channel,author:'user',text:'go',time:1,bot:false,raw:{key:{id:'one',remoteJid:task.channel}}});
 progress.seen(task,id);await progress.flush();assert.deepEqual(sent,['👀']);
 store.enqueue(task.key,id,'go');store.jobState(1,'running');await progress.flush();assert.equal(sent.at(-1),'🛠️');
 progress.event(task,'completed');await progress.flush();assert.equal(sent.at(-1),'🛠️');
 store.jobState(1,'done');await progress.flush();assert.equal(sent.at(-1),'✅');await progress.flush();assert.equal(sent.length,3);
});
test('Discord edits one bounded panel, retains last 25 calls and counts earlier calls',async t=>{
 const {store,task,progress}=setup(t);task.platform='discord';store.saveTask(task);let creates=0,edits=0,body='';
 const channel={isSendable:()=>true,isThread:()=>false,send:async(p:any)=>{creates++;body=p.content;return{id:'panel'};},messages:{edit:async(_:string,p:any)=>{edits++;body=p.content;}}};
 progress.clients.set(task.account,{isReady:()=>true,channels:{fetch:async()=>channel}});
 for(let n=0;n<30;n++)progress.event(task,'tool',{id:String(n),type:'commandExecution',command:`command-${n} `+'x'.repeat(500),status:'inProgress'});
 await progress.flush();assert.equal(creates,1);assert.match(body,/^5 more tool calls/);assert.ok(body.length<1900);assert.ok(!body.includes('command-0 '));assert.ok(body.includes('command-29'));
 progress.event(task,'tool',{id:'29',type:'commandExecution',command:'done',status:'completed'});progress.event(task,'completed');await progress.flush();
 assert.equal(creates,1);assert.equal(edits,1);assert.match(body,/✅ Tool activity/);
 assert.ok(toolLine({type:'mcpToolCall',tool:'secret',arguments:{access_token:'never-print'}}).includes('[REDACTED]'));
});
test('WhatsApp steering transfers completion to the newest message and survives reconstruction and duplicates',async t=>{
 const {store,task,progress}=setup(t),sent:{id:string;text:string}[]=[];store.meta('whatsapp',{ready:true});
 const socket=()=>({sendMessage:async(_:string,p:any)=>{sent.push({id:p.react.key.id,text:p.react.text});}});progress.socket=socket;
 const receive=(id:string)=>{const message=`whatsapp:${task.channel}:${id}`;store.record({id:message,platform:'whatsapp',workspace:'secondary',channel:task.channel,author:id,text:'go',time:Date.now(),bot:false,raw:{key:{id,remoteJid:task.channel}}});progress.seen(task,message);return message;};
 const first=receive('alice');store.enqueue(task.key,first,'original');store.jobState(1,'running');await progress.flush();
 const second=receive('bob');store.enqueue(task.key,second,'steer');store.jobState(2,'steering');await progress.flush();
 assert.equal(sent.filter(r=>r.id==='alice').at(-1)!.text,'↩️');assert.equal(sent.filter(r=>r.id==='bob').at(-1)!.text,'🛠️');
 progress.seen(task,first);await progress.flush();assert.equal(sent.filter(r=>r.id==='bob').at(-1)!.text,'🛠️');
 store.jobState(2,'running');const third=receive('carol');store.enqueue(task.key,third,'steer again');store.jobState(3,'running');await progress.flush();
 assert.equal(sent.filter(r=>r.id==='bob').at(-1)!.text,'↩️');
 for(const id of [1,2,3])store.jobState(id,'done');
 const restored=new Progress(store);restored.socket=socket;await restored.flush();await restored.flush();
 assert.equal(sent.filter(r=>r.id==='carol').at(-1)!.text,'✅');
 assert.ok(!sent.some(r=>['alice','bob'].includes(r.id)&&r.text==='✅'));
 const fourth=receive('dave');store.enqueue(task.key,fourth,'new turn');store.jobState(4,'running');await restored.flush();
 assert.equal(sent.filter(r=>r.id==='carol').at(-1)!.text,'✅');
});
test('a failed or queued steering follow-up never gives a superseded message a checkmark',async t=>{
 const {store,task,progress}=setup(t);store.meta('whatsapp',{ready:true});const sent:any[]=[];
 progress.socket=()=>({sendMessage:async(_:string,p:any)=>sent.push(p.react)});
 for(const [n,id] of ['old','new'].entries()){
   store.record({id,platform:'whatsapp',workspace:'secondary',channel:task.channel,author:id,text:id,time:n,bot:false,raw:{key:{id,remoteJid:task.channel}}});
   progress.seen(task,id);store.enqueue(task.key,id,id);if(n===0)store.jobState(1,'running');await progress.flush();
 }
 store.jobState(1,'done');await progress.flush();assert.equal(sent.filter(r=>r.key.id==='old').at(-1).text,'↩️');assert.equal(sent.filter(r=>r.key.id==='new').at(-1).text,'👀');
 store.jobState(2,'interrupted');await progress.flush();assert.equal(sent.filter(r=>r.key.id==='old').at(-1).text,'↩️');
});


test('Discord final replaces the exact tool message, survives restart and keeps earlier turn replies',async t=>{
 const {store,task,progress}=setup(t);task.platform='discord';store.saveTask(task);
 const messages=new Map<string,any>();let creates=0;
 const channel={isSendable:()=>true,isThread:()=>false,send:async(p:any)=>{const id=String(++creates);messages.set(id,p);return{id};},messages:{edit:async(id:string,p:any)=>{assert.ok(messages.has(id));messages.set(id,p);}}};
 const client={isReady:()=>true,channels:{fetch:async()=>channel}};progress.clients.set(task.account,client);
 progress.event(task,'started',{id:'one'});progress.event(task,'tool',{id:'tool',type:'commandExecution',command:'hello'});await progress.flush();
 progress.captureFinal(task,'The final answer.','codex:answer1');progress.event(task,'completed');
 assert.equal(await progress.final(task,'The final answer.','codex:answer1'),'1');assert.equal(creates,1);assert.equal(messages.get('1').content,'The final answer.');
 progress.event(task,'started',{id:'two'});progress.event(task,'tool',{id:'tool',type:'commandExecution',command:'second'});await progress.flush();
 const restored=new Progress(store);restored.clients.set(task.account,client);
 assert.equal(await restored.final(task,'The final answer.','codex:answer1'),'1');assert.equal(messages.get('1').content,'The final answer.');assert.equal(creates,2);
 const long='Full response '.repeat(400);assert.equal(await restored.final(task,long,'codex:answer2'),'2');assert.ok(messages.get('2').content.length<=2000);assert.equal(messages.get('2').files[0].attachment.toString(),long);
 restored.event(task,'completed');await restored.flush();assert.ok(!messages.get('2').content.includes('Tool activity'));
});

test('Discord final wins over an in-flight progress edit and handles replies without tools',async t=>{
 const {store,task,progress}=setup(t);task.platform='discord';store.saveTask(task);let body='',creates=0,release!:()=>void;
 let block=false;const channel={isSendable:()=>true,isThread:()=>false,send:async(p:any)=>{creates++;body=p.content;return{id:'one'};},messages:{edit:async(_:string,p:any)=>{if(block){block=false;await new Promise<void>(r=>release=r);}body=p.content;}}};
 progress.clients.set(task.account,{isReady:()=>true,channels:{fetch:async()=>channel}});
 progress.event(task,'tool',{id:'tool',type:'commandExecution',command:'hello'});await progress.flush();
 block=true;progress.event(task,'working');const pending=progress.flush();while(!release)await new Promise(r=>setTimeout(r,1));
 const final=progress.final(task,'Done','codex:one');release();await pending;await final;assert.equal(body,'Done');assert.equal(creates,1);
 progress.event(task,'started',{id:'next'});await progress.final(task,'No tools needed','codex:two');assert.equal(body,'No tools needed');assert.equal(creates,2);
});

test('Discord reactions use the inbound channel, replace our status and survive restart',async t=>{
 const {store,task,progress}=setup(t);task.platform='discord';task.channel='thread';store.saveTask(task);
 const receipt='discord:secondary:123';store.record({id:receipt,platform:'discord',workspace:'secondary',channel:'parent',author:'user',text:'go',time:1,bot:false});
 const sent:string[]=[],removed:string[]=[];const cache=new Map<string,any>();
 const message={reactions:{cache},react:async(text:string)=>{sent.push(text);cache.set(text,{me:true,emoji:{name:text},users:{remove:async(id:string)=>{assert.equal(id,'bot');removed.push(text);cache.delete(text);}}});}};
 cache.set('other',{me:false,emoji:{name:'👀'},users:{remove:async()=>assert.fail('removed another user reaction')}});
 const channel={messages:{fetch:async(id:string)=>{assert.equal(id,'123');return message;}}};
 const client={user:{id:'bot'},isReady:()=>true,channels:{fetch:async(id:string)=>{assert.equal(id,'parent');return channel;}}};
 progress.clients.set(task.account,client);progress.seen(task,receipt);await progress.flush();assert.deepEqual(sent,['👀']);
 store.enqueue(task.key,receipt,'go');store.jobState(1,'running');await progress.flush();assert.deepEqual(sent,['👀','🛠️']);assert.deepEqual(removed,['👀']);
 const restored=new Progress(store);restored.clients.set(task.account,client);store.jobState(1,'done');await restored.flush();await restored.flush();assert.deepEqual(sent,['👀','🛠️','✅']);assert.deepEqual(removed,['👀','🛠️']);
});

test('unavailable WhatsApp does not block Discord acknowledgement retries',async t=>{
 const {store,task,progress}=setup(t);
 store.record({id:'wa',platform:'whatsapp',workspace:'secondary',channel:task.channel,author:'user',text:'go',time:1,bot:false,raw:{key:{id:'wa',remoteJid:task.channel}}});progress.seen(task,'wa');
 task.platform='discord';store.saveTask(task);store.record({id:'discord:secondary:123',platform:'discord',workspace:'secondary',channel:'parent',author:'user',text:'go',time:2,bot:false});progress.seen(task,'discord:secondary:123');
 let attempts=0;progress.clients.set(task.account,{isReady:()=>true,channels:{fetch:async()=>({messages:{fetch:async()=>({react:async()=>{if(++attempts===1)throw Error('permission');},reactions:{cache:new Map()}})}})}});
 await progress.flush();await progress.flush();await progress.flush();assert.equal(attempts,2);
});

test('Discord steering deletes the old log and creates an empty log below the new input, retaining final answers',async t=>{
 const {store,task,progress}=setup(t);task.platform='discord';store.saveTask(task);
 const messages=new Map<string,any>();let next=0;const deleted:string[]=[];
 const channel={isSendable:()=>true,isThread:()=>false,send:async(p:any)=>{const id=String(++next);messages.set(id,p);return{id};},messages:{fetch:async()=>({react:async()=>{},reactions:{cache:new Map()}}),edit:async(id:string,p:any)=>messages.set(id,p),delete:async(id:string)=>{deleted.push(id);messages.delete(id);}}};
 progress.clients.set(task.account,{user:{id:'bot'},isReady:()=>true,channels:{fetch:async()=>channel}});
 const input=(id:string)=>{const receipt=`discord:secondary:${id}`;store.record({id:receipt,platform:'discord',workspace:'secondary',channel:task.channel,author:'user',text:'go',time:1,bot:false});progress.seen(task,receipt);return receipt;};
 const first=input('first');store.enqueue(task.key,first,'go');store.jobState(1,'running');progress.event(task,'started',{id:'turn'});progress.event(task,'tool',{id:'old',type:'commandExecution',command:'old-command'});await progress.flush();assert.match(messages.get('1').content,/old-command/);
 input('steer');await progress.flush();assert.deepEqual(deleted,['1']);assert.equal(messages.size,1);assert.ok(!messages.get('2').content.includes('old-command'));
 input('steer');await progress.flush();assert.equal(next,2);
 progress.event(task,'tool',{id:'new',type:'commandExecution',command:'new-command'});await progress.flush();assert.match(messages.get('2').content,/new-command/);
 await progress.final(task,'Finished','codex:done');assert.ok(!messages.has('2'));assert.equal(messages.get('3').content,'Finished');assert.deepEqual(messages.get('3').reply,{messageReference:'first',failIfNotExists:false});input('next-turn');await progress.flush();assert.equal(messages.get('3').content,'Finished');assert.equal(messages.size,2);
});

test('steering during an in-flight log creation removes it after delivery',async t=>{
 const {store,task,progress}=setup(t);task.platform='discord';store.saveTask(task);let release!:()=>void;const deleted:string[]=[];let sends=0;
 const channel={isSendable:()=>true,isThread:()=>false,send:async()=>{const id=String(++sends);if(sends===1)await new Promise<void>(r=>release=r);return{id};},messages:{fetch:async()=>({react:async()=>{},reactions:{cache:new Map()}}),delete:async(id:string)=>deleted.push(id)}};
 progress.clients.set(task.account,{user:{id:'bot'},isReady:()=>true,channels:{fetch:async()=>channel}});
 progress.event(task,'tool',{id:'old',type:'commandExecution',command:'old'});const pending=progress.flush();while(!release)await new Promise(r=>setTimeout(r,1));
 const receipt='discord:secondary:new';store.record({id:receipt,platform:'discord',workspace:'secondary',channel:task.channel,author:'user',text:'go',time:1,bot:false});progress.seen(task,receipt);release();await pending;await progress.flush();assert.deepEqual(deleted,['1']);assert.equal(sends,2);
});

test('Discord commentary persists above subsequent tools, dedupes after restart and retains the final answer',async t=>{
 const {store,task,progress}=setup(t);task.platform='discord';store.saveTask(task);
 const messages=new Map<string,any>();let next=0;
 const channel={isSendable:()=>true,isThread:()=>false,send:async(p:any)=>{const id=String(++next);messages.set(id,p);return{id};},messages:{edit:async(id:string,p:any)=>messages.set(id,p)}};
 const client={isReady:()=>true,channels:{fetch:async()=>channel}};progress.clients.set(task.account,client);
 const update={id:'update',type:'agentMessage',phase:'commentary',text:'Found the issue. Testing the fix.',status:'completed'};
 progress.event(task,'tool',{id:'one',type:'commandExecution',command:'inspect'});await progress.flush();
 progress.event(task,'tool',{...update,status:'inProgress'});await progress.flush();assert.match(messages.get('1').content,/inspect/);
 progress.event(task,'tool',update);
 progress.event(task,'tool',{id:'two',type:'commandExecution',command:'test'});await progress.flush();
 assert.equal(messages.get('1').content,update.text);assert.match(messages.get('2').content,/test/);assert.equal(next,2);
 const restored=new Progress(store);restored.clients.set(task.account,client);restored.event(task,'tool',update);await restored.flush();assert.equal(next,2);
 restored.event(task,'tool',{...update,id:'update2',text:'Tests passed.'});await restored.flush();assert.equal(messages.get('2').content,'Tests passed.');assert.equal(next,2);
 await restored.final(task,'Published.','codex:done');assert.equal(messages.get('3').content,'Published.');assert.equal(messages.get('1').content,update.text);
});

test('Discord commentary wins over an in-flight tool send',async t=>{
 const {store,task,progress}=setup(t);task.platform='discord';store.saveTask(task);
 const messages=new Map<string,string>();let next=0,release!:()=>void;
 const channel={isSendable:()=>true,isThread:()=>false,send:async(p:any)=>{const id=String(++next);if(next===1)await new Promise<void>(r=>release=r);messages.set(id,p.content);return{id};},messages:{edit:async(id:string,p:any)=>messages.set(id,p.content)}};
 progress.clients.set(task.account,{isReady:()=>true,channels:{fetch:async()=>channel}});
 progress.event(task,'tool',{id:'one',type:'commandExecution',command:'inspect'});const pending=progress.flush();while(!release)await new Promise(r=>setTimeout(r,1));
 progress.event(task,'tool',{id:'update',type:'agentMessage',phase:'commentary',text:'Still investigating.',status:'completed'});
 progress.event(task,'tool',{id:'two',type:'commandExecution',command:'verify'});release();await pending;await progress.flush();
 assert.equal(messages.get('1'),'Still investigating.');assert.match(messages.get('2')!,/verify/);
});
