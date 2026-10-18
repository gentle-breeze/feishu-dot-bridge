import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ApprovalStore, type Hook } from '../src/claude-approval/core.js';
import { BoundFeishuApproval, card } from '../src/claude-approval/adapter.js';
import { serveApprovals } from '../src/claude-approval/server.js';
import type { Binding, Inbound } from '../src/types.js';
const sid=randomUUID();
const hook=(tool='Write',event:'PermissionRequest'|'PreToolUse'='PermissionRequest'):Hook=>({session_id:sid,hook_event_name:event,tool_use_id:randomUUID(),tool_name:tool,tool_input:{file_path:'/tmp/example',content:'hello'},permission_mode:'plan'});
function setup(bypass=false){let now=1000;const s=new ApprovalStore(':memory:',()=>now);s.register(sid,bypass);return {s,advance:()=>now+=5000};}
function request(s:ApprovalStore,h=hook()){const r=s.create(h,1000);s.delivered(r.id);return r;}
test('allow once, deny wins until consume, replay and wrong session rejected',()=>{
 const {s}=setup();const r=request(s);
 assert.equal(s.answer(r.id,randomUUID(),'1',{action:'allow'}),'invalid_request');
 assert.equal(s.answer(r.id,sid,'1',{action:'allow'}),'accepted');
 assert.equal(s.answer(r.id,sid,'1',{action:'allow'}),'duplicate_event');
 assert.equal(s.answer(r.id,sid,'2',{action:'deny',feedback:'keep pending'}),'accepted');
 assert.equal(s.answer(r.id,sid,'3',{action:'allow'}),'already_decided');
 assert.match(JSON.stringify(s.consume(r.id,sid)),/keep pending/);
 assert.throws(()=>s.consume(r.id,sid));s.close();
});
test('timeout, delivery failure, cancellation, duplicate hooks',()=>{
 const {s,advance}=setup();const r=request(s);assert.throws(()=>s.create(r.hook,1000));advance();
 assert.equal(s.answer(r.id,sid,'1',{action:'allow'}),'expired');assert.match(JSON.stringify(s.consume(r.id,sid)),/REMOTE_TIMEOUT/);
 const r2=request(s);s.fail(r2.id);assert.throws(()=>s.consume(r2.id,sid));
 const r3=s.create(hook(),1000);assert.equal(s.answer(r3.id,sid,'2',{action:'allow'}),'not_delivered');s.cancel();assert.throws(()=>s.create(hook(),1000));s.close();
});
test('original plan input preserved; bypass needs explicit availability and plan approval',()=>{
 for(const enabled of [false,true]) {const {s}=setup(enabled);const h=hook('ExitPlanMode');h.tool_input={plan:'Exact original plan',planFilePath:'/tmp/plan',extra:'preserved'};const r=request(s,h);
 assert.equal(s.answer(r.id,sid,'1',{action:'bypass'}),enabled?'accepted':'bypass_unavailable');
 if(!enabled)s.answer(r.id,sid,'2',{action:'allow'});
 const out=s.consume(r.id,sid).result as any;
 assert.deepEqual(out.hookSpecificOutput.decision.updatedInput,h.tool_input);
 assert.equal(!!out.hookSpecificOutput.decision.updatedPermissions,enabled);s.close();}
 const {s}=setup(true);const r=request(s);assert.equal(s.answer(r.id,sid,'3',{action:'bypass'}),'bypass_unavailable');s.close();
});
test('single, multiple, free answers map by exact question; missing/duplicate questions fail',()=>{
 const {s}=setup();const h=hook('AskUserQuestion','PreToolUse');h.tool_input={questions:[{question:'Color?',options:[{label:'Blue'}]},{question:'Fruit?',multiSelect:true,options:[{label:'Apple'},{label:'Pear'}]},{question:'Note?',options:[{label:'Short'}]}]};const r=request(s,h);
 assert.equal(s.answer(r.id,sid,'0',{action:'allow'}),'answers_required');
 assert.equal(s.answer(r.id,sid,'1',{action:'answers',answers:{'Color?':'Blue'}}),'incomplete_answers');
 assert.equal(s.answer(r.id,sid,'2',{action:'answers',answers:{'Color?':'Blue','Fruit?':['Apple','Pear'],'Note?':'Custom free text'}}),'accepted');
 const out=s.consume(r.id,sid).result as any;assert.deepEqual(out.hookSpecificOutput.updatedInput.answers,{'Color?':'Blue','Fruit?':'Apple, Pear','Note?':'Custom free text'});s.close();
});
test('restart invalidates pending requests and old sessions durably',()=>{
 const dir=mkdtempSync(join(tmpdir(),'approval-test-'));try{const path=join(dir,'db');const first=new ApprovalStore(path);first.register(sid,false);const r=request(first);first.db.close();const second=new ApprovalStore(path);assert.equal(second.active(sid),false);assert.throws(()=>second.register(sid,false));assert.throws(()=>second.consume(r.id,sid));second.close();}finally{rmSync(dir,{recursive:true,force:true});}
});
const b:Binding={id:'binding',owner:'owner',active:1,appId:'app',tenantKey:'tenant',openId:'me',chatId:'private'};
test('authenticated bound reply rejects other users/chats/apps, old events; cards preserve raw plain text',async()=>{
 const {s}=setup();const r=s.create(hook(),1000);let sent:any;const a=new BoundFeishuApproval(s,{async reply(){},async sendCard(_app,_chat,c){sent=c;return 'message';}},()=>b,'owner');await a.send(r);s.delivered(r.id);assert.equal(sent.elements[1].text.tag,'plain_text');
 const m:Inbound={...b,messageId:'msg',timestamp:new Date().toISOString(),text:'/claude '+JSON.stringify({request:r.id,session:sid,action:'allow'})};
 for(const bad of [{openId:'other'},{chatId:'group'},{appId:'wrong'},{tenantKey:'other'}])assert.equal(a.receive({...m,...bad}),'wrong_identity');
 assert.equal(a.receive({...m,timestamp:'bad'}),'stale_event');assert.equal(a.receive(m),'accepted');assert.equal(a.receive(m),'duplicate_event');a.disconnected();assert.throws(()=>s.consume(r.id,sid));s.close();
});
test('oversized remote detail is not truncated into an approvable card',()=>{const {s}=setup();const h=hook();h.tool_input={content:'x'.repeat(19000)};assert.throws(()=>card(request(s,h)));s.close();});
function pythonHook(socket:string,h:unknown){return new Promise<any>((resolveResult,reject)=>{const p=spawn('/usr/bin/python3',[resolve('scripts/claude-approval/hook.py')],{env:{...process.env,CLAUDE_APPROVAL_SOCKET:socket,CLAUDE_APPROVAL_SESSION:sid},stdio:['pipe','pipe','pipe']});let out='';p.stdout.on('data',x=>out+=x);p.on('error',reject);p.on('exit',code=>{try{assert.equal(code,0);resolveResult(JSON.parse(out));}catch(e){reject(e);}});p.stdin.end(JSON.stringify(h));});}
test('end-to-end Python Hook → Unix broker → simulated bound Feishu reply → Claude result',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'approval-e2e-'));let adapter:BoundFeishuApproval;const service=await serveApprovals(dir,store=>{
 adapter=new BoundFeishuApproval(store,{async reply(){},async sendCard(){return 'mock';}},()=>b,'owner');
 return {async send(r){await adapter.send(r);setTimeout(()=>{const answer=r.hook.tool_name==='AskUserQuestion'?{action:'answers',answers:{'Color?':'Blue'}}:{action:'allow'};assert.equal(adapter.receive({...b,messageId:randomUUID(),timestamp:new Date().toISOString(),text:'/claude '+JSON.stringify({request:r.id,session:r.session,...answer})}),'accepted');},20);}};
 },1000);
 try {service.store.register(sid,false);
 const h=hook('ExitPlanMode');h.tool_input={plan:'original',planFilePath:'/tmp/p'};const out=await pythonHook(service.socket,h);assert.deepEqual(out.hookSpecificOutput.decision.updatedInput,h.tool_input);
 const q=hook('AskUserQuestion','PreToolUse');q.tool_input={questions:[{question:'Color?',options:[{label:'Blue'}]}]};assert.equal((await pythonHook(service.socket,q)).hookSpecificOutput.updatedInput.answers['Color?'],'Blue');
 assert.deepEqual(await pythonHook(service.socket,hook('Read','PreToolUse')),{});
 service.store.cancel();assert.match(JSON.stringify(await pythonHook(service.socket,hook())),/REMOTE_UNAVAILABLE/);
 }finally{await service.close();rmSync(dir,{recursive:true,force:true});}
});
test('missing broker and malformed stdin explicitly deny',async()=>{assert.match(JSON.stringify(await pythonHook('/tmp/nonexistent-approval.sock',hook())),/deny/);assert.equal((await pythonHook('/tmp/nonexistent-approval.sock',{})).continue,false);});
test('lease expiry, renewal and sweep prevent orphaned launcher sessions',()=>{
 let now=0;const s=new ApprovalStore(':memory:',()=>now);s.register(sid,false);now=14000;s.heartbeat(sid);assert.equal(s.active(sid),true);now=30000;s.sweep();assert.equal(s.active(sid),false);assert.throws(()=>s.heartbeat(sid));s.close();
});
test('delivery rejection and unanswered request close through actual Python hook',async()=>{
 for(const rejectDelivery of [true,false]){
 const dir=mkdtempSync(join(tmpdir(),'approval-failure-'));const service=await serveApprovals(dir,()=>({async send(){if(rejectDelivery)throw new Error('simulated');}}),150);
 try{service.store.register(sid,false);assert.match(JSON.stringify(await pythonHook(service.socket,hook())),/deny/);await assert.rejects(serveApprovals(dir,()=>({async send(){}})));}finally{await service.close();rmSync(dir,{recursive:true,force:true});}
 }
});
test('host extension cancels on disconnect/binding change and reuses existing sender only',async()=>{
 const {startBoundApprovals}=await import('../src/claude-approval/host.js');
 const dir=mkdtempSync(join(tmpdir(),'approval-host-'));let binding:Binding|undefined=b;
 const host=await startBoundApprovals({directory:dir,sender:{async reply(){},async sendCard(){return 'mock';}},binding:()=>binding,owner:'owner'});
 try{host.disconnected();host.reconnected();binding=undefined;host.bindingChanged();await assert.rejects(async()=>host.receiveAuthenticated({...b,messageId:'x',timestamp:new Date().toISOString(),text:'/claude {}'}));}finally{await host.close();await host.close();rmSync(dir,{recursive:true,force:true});}
});

test('launcher uses only claude-gptcc with safe default and explicit plan availability',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'approval-launch-'));const record=join(dir,'argv.json');
 writeFileSync(join(dir,'claude-gptcc'),`#!/usr/bin/python3
import json,sys
open(${JSON.stringify(record)},'w').write(json.dumps(sys.argv[1:]))
`,{mode:0o700});
 const service=await serveApprovals(join(dir,'state'),()=>({async send(){}}));
 try{for(const mode of [[],['--offer-session-bypass']]){
 await new Promise<void>((done,reject)=>{const child=spawn('/usr/bin/python3',[resolve('scripts/claude-approval/launch.py'),'--state-dir',join(dir,'state'),...mode],{env:{...process.env,PATH:dir+':'+process.env.PATH,PYTHONPYCACHEPREFIX:join(dir,'pycache')},stdio:'ignore'});child.on('error',reject);child.on('exit',code=>code===0?done():reject(new Error('launcher failed')));});
 const args=JSON.parse(readFileSync(record,'utf8')) as string[];assert.equal(args[args.indexOf('--permission-mode')+1],mode.length?'plan':'manual');assert.equal(args.includes('--allow-dangerously-skip-permissions'),!!mode.length);assert.equal(args.includes('--dangerously-skip-permissions'),false);assert.equal(service.store.db.prepare('SELECT count(*) AS n FROM sessions WHERE active=1').get()!.n,0);
 }}finally{await service.close();rmSync(dir,{recursive:true,force:true});}
});
