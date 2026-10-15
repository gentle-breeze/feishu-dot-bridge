import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,chmodSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fixture,verifyDelivery} from './fixtures.js';
import {Store} from '../src/store.js';
import {Bridge} from '../src/bridge.js';
import {SecretBox} from '../src/crypto.js';
import {schema5,schema6} from '../scripts/maintenance-schema.js';
import {startLocalSocket,localRequest,validateSocketPath} from '../src/local-socket.js';
const localSub=(f:ReturnType<typeof fixture>)=>f.bridge.subscribe(f.alice,{name:'local.message.created',arguments:{binding_id:f.store.binding(f.alice.id)!.id},delivery:{mode:'webhook',url:'https://callback.example/local',secret:f.secret}});
const input=(binding_id:string)=>({binding_id,request_id:'synthetic-request-1',text:'Synthetic local task'});
test('local intake requires independent subscription, rejects credentials/routes and dedupes',async()=>{
 const f=fixture();try{const b=f.bind();await f.subscribe();assert.throws(()=>f.bridge.local.submit(f.alice,input(b.id)),/local_subscription_required/);await localSub(f);
 const a=f.bridge.local.submit(f.alice,input(b.id));assert.deepEqual(f.bridge.local.submit(f.alice,input(b.id)),a);assert.throws(()=>f.bridge.local.submit(f.alice,{...input(b.id),text:'changed'}),/already_reserved/);
 assert.throws(()=>f.bridge.local.submit(f.alice,{...input(b.id),chat_id:'other'}));assert.throws(()=>f.bridge.local.submit(f.bob,input(b.id)));
 assert.throws(()=>f.bridge.local.submit(f.alice,{...input(b.id),text:'Bearer '+ 'x'.repeat(40)}),/credential_blocked/);
 await f.bridge.pump();const call=f.calls.at(-1)!;verifyDelivery(f.secret,call);assert.equal(call.body.name,'local.message.created');assert.equal(call.body.data.untrusted,true);assert.equal(f.store.db.prepare('SELECT count(*) n FROM inbox').get()!.n,0);
 assert.equal(f.bridge.local.status(f.alice,{event_id:a.event_id}).state,'sent');
 let sends=0;f.sender.sendBound=async(_app,chat)=>{assert.equal(chat,b.chatId);sends++;throw new Error('ambiguous transport');};
 f.bridge.local.reply(f.alice,{event_id:a.event_id,text:'Synthetic answer',existing_user_authorization:true});await f.bridge.pump();await f.bridge.pump();assert.equal(sends,1);assert.equal(f.bridge.local.status(f.alice,{event_id:a.event_id}).reply?.state,'uncertain');
 }finally{f.store.close();}
});
test('local callbacks persist retries and cancel on unlink/rebind and lease expiry',async()=>{
 const f=fixture();try{const b=f.bind();await localSub(f);const a=f.bridge.local.submit(f.alice,input(b.id));f.transport.post=async()=>({status:503,body:''});await f.bridge.pump();assert.equal(f.bridge.local.status(f.alice,{event_id:a.event_id}).attempts,1);await f.bridge.pump();assert.equal(f.bridge.local.status(f.alice,{event_id:a.event_id}).attempts,1);f.advance(1000);await f.bridge.pump();assert.equal(f.bridge.local.status(f.alice,{event_id:a.event_id}).attempts,2);
 f.bridge.unlink(f.alice);f.bind();assert.throws(()=>f.bridge.local.status(f.alice,{event_id:a.event_id}));assert.equal(f.store.db.prepare('SELECT state FROM local_events').get()!.state,'cancelled');
 }finally{f.store.close();}
});
test('CheckMark only follows 2xx and reconciles ambiguous send without resending',async()=>{
 const f=fixture();try{f.bind();await f.subscribe();f.bridge.receive(f.message());const e=String(f.store.db.prepare('SELECT id FROM inbox').get()!.id);let writes=0,found:string|undefined;
 f.sender.findCheckMark=async()=>found;f.sender.addCheckMark=async()=>{writes++;throw new Error('connection lost');};
 assert.equal(f.bridge.reactions.status(f.alice,e).state,'not_queued');await f.bridge.pump();assert.equal(f.bridge.reactions.status(f.alice,e).state,'pending');await f.bridge.pump();assert.equal(f.bridge.reactions.status(f.alice,e).state,'uncertain');f.advance(1000);await f.bridge.pump();assert.equal(writes,1);found='synthetic-reaction';f.advance(2000);await f.bridge.pump();assert.equal(f.bridge.reactions.status(f.alice,e).state,'sent');assert.equal(writes,1);
 }finally{f.store.close();}
});
test('failed callback never queues a mark; revocation cancels local and reaction work',async()=>{
 const f=fixture();try{const b=f.bind();await f.subscribe();await localSub(f);f.bridge.local.submit(f.alice,input(b.id));f.bridge.receive(f.message());f.transport.post=async()=>({status:403,body:''});await f.bridge.pump();assert.equal(f.store.db.prepare('SELECT count(*) n FROM callback_reactions').get()!.n,0);f.store.revoke(f.alice.id);assert.equal(f.store.db.prepare('SELECT active FROM local_subscriptions').get()!.active,0);assert.throws(()=>f.bridge.local.status(f.alice,{event_id:'anything'}));}finally{f.store.close();}
});
for(const [version,schema] of [[5,schema5],[6,schema6]] as const)test(`schema ${version} upgrades additively to 7`,()=>{
 const dir=mkdtempSync(join(tmpdir(),'MOCK-schema-'));try{const path=join(dir,'db');const db=new DatabaseSync(path);db.exec(schema);db.exec('PRAGMA user_version='+version);db.close();const s=new Store(path);try{assert.equal(s.db.prepare('PRAGMA user_version').get()!.user_version,7);assert.equal(s.db.prepare('SELECT count(*) n FROM local_events').get()!.n,0);assert.equal(s.db.prepare('PRAGMA foreign_key_check').get(),undefined);}finally{s.close();}}finally{rmSync(dir,{recursive:true,force:true});}
});
test('restart requeues callback but never repeats ambiguous local reply or reaction write',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'MOCK-recovery-')),path=join(dir,'db');const f=fixture(path);try{const b=f.bind();await localSub(f);const e=f.bridge.local.submit(f.alice,input(b.id));f.sender.sendBound=async()=>'';f.bridge.local.reply(f.alice,{event_id:e.event_id,text:'answer',existing_user_authorization:true});f.store.db.exec("UPDATE local_events SET state='sending',attempts=1;UPDATE local_replies SET state='sending'");f.store.close();const store=new Store(path);try{const bridge=new Bridge(store,new SecretBox(f.storageKey),f.transport,f.sender,f.now);const state=bridge.local.status(f.alice,{event_id:e.event_id});assert.equal(state.state,'pending');assert.equal(state.reply?.state,'uncertain');}finally{store.close();}}finally{rmSync(dir,{recursive:true,force:true});}
});
test('private socket supports bounded JSON CLI requests, never caller-selected owner or subscription',async()=>{
 const dir=realpathSync(mkdtempSync('/tmp/MOCK-socket-'));chmodSync(dir,0o700);const f=fixture();let server:Awaited<ReturnType<typeof startLocalSocket>>|undefined;
 try{const b=f.bind();await localSub(f);const path=join(dir,'bridge.sock');server=await startLocalSocket(path,f.bridge,f.alice.id);validateSocketPath(path,true);assert.throws(()=>validateSocketPath(path));const r=await localRequest(path,{operation:'submit',...input(b.id)}) as {result:{event_id:string}};assert.ok(r.result.event_id.startsWith('local_evt_'));await assert.rejects(localRequest(path,{operation:'subscribe'}));await assert.rejects(localRequest(path,{operation:'binding',owner:f.bob.id}));}
 finally{if(server)await new Promise<void>(r=>server!.close(()=>r()));f.store.close();rmSync(dir,{recursive:true,force:true});}
});
test('unlink preserves uncertain reaction evidence and stops reconciliation',async()=>{
 const f=fixture();try{f.bind();await f.subscribe();f.bridge.receive(f.message());f.sender.findCheckMark=async()=>undefined;f.sender.addCheckMark=async()=>{throw new Error('ambiguous POST');};await f.bridge.pump();await f.bridge.pump();f.bridge.unlink(f.alice);f.advance(1000);await f.bridge.pump();const row=f.store.db.prepare('SELECT state,attempts,nextAt FROM callback_reactions').get()!;assert.equal(row.state,'uncertain');assert.equal(row.attempts,1);assert.equal(row.nextAt,Number.MAX_SAFE_INTEGER);}finally{f.store.close();}
});
test('malformed local counters fail startup before ambiguous sends can recover',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'MOCK-malformed-')),path=join(dir,'db'),f=fixture(path);try{const b=f.bind();await localSub(f);f.bridge.local.submit(f.alice,input(b.id));f.store.db.exec("UPDATE local_events SET state='sending',nextAt=-1");f.store.close();assert.throws(()=>new Store(path),/Malformed/);const db=new DatabaseSync(path);try{assert.equal(db.prepare('SELECT state FROM local_events').get()!.state,'sending');}finally{db.close();}}finally{rmSync(dir,{recursive:true,force:true});}
});
for(const status of [503,410])test(`unsubscribe persists across in-flight HTTP ${status} and resubscribe`,async()=>{
 const f=fixture();try{const b=f.bind();await localSub(f);const e=f.bridge.local.submit(f.alice,input(b.id));let release!:(r:{status:number;body:string})=>void;let entered!:()=>void;const started=new Promise<void>(r=>entered=r);
 const original=f.transport.post;f.transport.post=async()=>{entered();return new Promise(r=>release=r);};const pumping=f.bridge.pump();await started;
 f.bridge.unsubscribe(f.alice,{name:'local.message.created',arguments:{binding_id:b.id},delivery:{mode:'webhook',url:'https://callback.example/local'}});
 f.transport.post=original;await localSub(f);release({status,body:''});await pumping;
 assert.equal(f.bridge.local.status(f.alice,{event_id:e.event_id}).state,'cancelled');assert.equal(f.store.db.prepare('SELECT active FROM local_subscriptions').get()!.active,1);const calls=f.calls.length;f.advance(2000);await f.bridge.pump();assert.equal(f.calls.length,calls);
 }finally{f.store.close();}
});
test('subscription renewal cannot extend a queued local event lease',async()=>{
 const f=fixture();try{const b=f.bind();await localSub(f);const e=f.bridge.local.submit(f.alice,input(b.id));f.advance(3600001);f.alice.expiresAt=f.now()+3600000;await localSub(f);await f.bridge.pump();assert.equal(f.bridge.local.status(f.alice,{event_id:e.event_id}).state,'cancelled');}finally{f.store.close();}
});
