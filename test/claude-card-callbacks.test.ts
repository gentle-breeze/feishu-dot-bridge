import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import type * as lark from '@larksuiteoapi/node-sdk';
import {ApprovalStore,type Request,type Hook} from '../src/claude-approval/core.js';
import {BoundFeishuApproval} from '../src/claude-approval/adapter.js';
import {card,formAnswer} from '../src/claude-approval/cards.js';
import {FeishuWebSocketIngress,type WebSocketFactory} from '../src/feishu-websocket.js';
import type {Binding,FeishuApp} from '../src/types.js';
const b:Binding={id:'bind_mock',owner:'owner',active:1,appId:'cli_0000000000000033',tenantKey:'tenant',openId:'owner_open',chatId:'private_chat'};
function event(r:Request,action='allow',form:Record<string,unknown>={}) {
 return {event_type:'card.action.trigger',event_id:randomUUID(),create_time:String(Date.now()*1000),app_id:b.appId,tenant_key:b.tenantKey,operator:{open_id:b.openId,tenant_key:b.tenantKey},host:'im_message',context:{open_message_id:'om_'+r.id,open_chat_id:b.chatId},action:{tag:'button',name:'act_'+action,value:{kind:'claude_approval_v1',request:r.id,session:r.session,action},form_value:form}};
}
function envelope(e:ReturnType<typeof event>) { const {event_id,event_type,create_time,app_id,tenant_key,...rest}=e;return {schema:'2.0',header:{event_id,event_type,create_time,app_id,tenant_key},event:rest}; }
function fixture(path=':memory:',bypass=false) {
 let now=Date.now(),binding:Binding|undefined=b,fail=false;
 const logs:string[]=[],patches:{message:string;content:any}[]=[],sends:any[]=[];
 const s=new ApprovalStore(path,()=>now,(name,id)=>logs.push(JSON.stringify({name,id})));
 const session=randomUUID();s.register(session,bypass);
 const a=new BoundFeishuApproval(s,{async reply(){throw new Error('must not send text');},async sendCard(_app,chat,content,key){assert.equal(chat,b.chatId);sends.push(content);return 'om_'+key;},async patchCard(_app,message,content){if(fail)throw new Error('PRIVATE_NETWORK_ERROR');patches.push({message,content});}},()=>binding,'owner');
 async function create(tool='Write',input:Record<string,unknown>={file_path:'/tmp/fixture/output.txt',content:'SYNTHETIC'}) {const h:Hook={session_id:session,cwd:'/tmp/fixture/project',hook_event_name:tool==='AskUserQuestion'?'PreToolUse':'PermissionRequest',tool_name:tool,tool_input:input,invocation_id:randomUUID(),permission_mode:'plan'};const r=s.create(h,1000);await a.send(r);s.delivered(r.id);return r;}
 return {s,a,session,create,logs,patches,sends,advance:(ms:number)=>now+=ms,setFailure:(value:boolean)=>fail=value,setBinding:(value:Binding|undefined)=>binding=value};
}
const ok=(value:unknown)=>(value as any).toast?.type==='success';
const questions={questions:[{question:'Color?',options:[{label:'Blue'},{label:'Green'}]},{question:'Fruits?',multiSelect:true,options:[{label:'Apple'},{label:'Pear'}]},{question:'Note?',options:[{label:'Short'}]}]};
test('permission buttons, project/session summary, no JSON commands or bypass; terminal update removes controls',async()=>{
 const f=fixture();try{const r=await f.create();const json=JSON.stringify(f.sends[0]);assert.match(json,/允许本次/);assert.match(json,/拒绝/);assert.match(json,/fixture\/project/);assert.ok(json.includes(r.session));assert.ok(!json.includes('/claude'));assert.ok(!json.includes('bypass'));
 assert.ok(ok(f.a.receiveCard(event(r))));await f.a.flushUpdates();assert.equal(f.patches[0]!.message,'om_'+r.id);assert.match(JSON.stringify(f.patches[0]!.content),/已批准/);assert.ok(!JSON.stringify(f.patches[0]!.content).includes('"tag":"button"'));
 const output=f.s.consume(r.id,r.session).result as any;assert.deepEqual(output.hookSpecificOutput.decision,{behavior:'allow'});assert.ok(!ok(f.a.receiveCard(event(r))));
 }finally{await f.a.stop();f.s.close();}
});
test('one form submits multi-question single/multiple/free values with exact mapping',async()=>{
 const f=fixture();try{const r=await f.create('AskUserQuestion',questions);const json=JSON.stringify(f.sends[0]);assert.match(json,/checker/);assert.ok(!json.includes("select_static"));assert.match(json,/提交全部答案/);
 const bad=[{q0:'2',q1:['0'],free2:'free'},{q0:['0'],q1:['0'],free2:'free'},{q0:'0',q1:['0','0'],free2:'free'},{q0:'0',q1:['0']},{q0:'0',q1:['0'],free2:'free',injected:'bad'}];for(const v of bad)assert.ok(!ok(f.a.receiveCard(event(r,'answers',v))));assert.equal(f.s.consume(r.id,r.session).done,false);
 assert.ok(ok(f.a.receiveCard(event(r,'answers',{q0:'0',q1:['0','1'],q2:'0',free2:'custom note'}))));const out=f.s.consume(r.id,r.session).result as any;assert.deepEqual(out.hookSpecificOutput.updatedInput.answers,{'Color?':'Blue','Fruits?':'Apple, Pear','Note?':'custom note'});
 }finally{await f.a.stop();f.s.close();}
});
test('plan feedback is required, denial wins before consumption; original plan allow remains intact',async()=>{
 const f=fixture();try{const input={plan:'Review only',planFilePath:'/tmp/fixture/plan',extra:'preserve'};const r=await f.create('ExitPlanMode',input);
 assert.ok(!ok(f.a.receiveCard(event(r,'deny',{feedback:'  '}))));assert.ok(ok(f.a.receiveCard(event(r))));assert.ok(ok(f.a.receiveCard(event(r,'deny',{feedback:'Add a check'}))));await f.a.flushUpdates();assert.match(JSON.stringify(f.patches.at(-1)),/已拒绝/);assert.match(JSON.stringify(f.s.consume(r.id,r.session)),/Add a check/);
 const r2=await f.create('ExitPlanMode',input);assert.ok(ok(f.a.receiveCard(event(r2))));const out=f.s.consume(r2.id,r2.session).result as any;assert.deepEqual(out.hookSpecificOutput.decision.updatedInput,input);assert.equal(out.hookSpecificOutput.decision.updatedPermissions,undefined);
 }finally{await f.a.stop();f.s.close();}
});
test('forged/cross-session/forwarded/binding changes/stale/bypass callbacks fail closed',async()=>{
 const f=fixture();try{const r=await f.create(),e=event(r);const variants=[{...e,app_id:'other'},{...e,tenant_key:'other'},{...e,operator:{open_id:b.openId,tenant_key:'other'}},{...e,operator:{open_id:'other',tenant_key:b.tenantKey}},{...e,context:{...e.context,open_message_id:'forwarded'}},{...e,context:{...e.context,open_chat_id:'group'}},{...e,action:{...e.action,value:{...e.action.value,session:randomUUID()}}},{...e,action:{...e.action,value:{...e.action.value,request:randomUUID()}}},{...e,create_time:String((Date.now()-301000)*1000)},event(r,'bypass'),{...e,action:{...e.action,name:'other'}}];for(const v of variants)assert.ok(!ok(f.a.receiveCard(v)));assert.equal(f.s.consume(r.id,r.session).done,false);
 f.setBinding({...b,id:'new_binding'});assert.ok(!ok(f.a.receiveCard(e)));assert.deepEqual(f.a.receiveCard({action:{value:{kind:'other_card'}}}),{});assert.equal(f.a.receive({...b,messageId:'m',text:'ordinary dot chat',timestamp:new Date().toISOString()}),undefined);
 }finally{await f.a.stop();f.s.close();}
});
test('same event cannot answer another request; duplicate clicks never grant twice',async()=>{
 const f=fixture();try{const r=await f.create(),r2=await f.create();const first=event(r);assert.ok(ok(f.a.receiveCard(first)));assert.ok(!ok(f.a.receiveCard(first)));assert.ok(!ok(f.a.receiveCard({...event(r2),event_id:first.event_id})));assert.equal(f.s.consume(r2.id,r2.session).done,false);assert.equal(f.s.consume(r.id,r.session).done,true);assert.throws(()=>f.s.consume(r.id,r.session));}finally{await f.a.stop();f.s.close();}
});
test('expired cards update without clicks; patch failure retries and never changes decision',async()=>{
 const f=fixture();try{const r=await f.create();f.advance(1001);f.s.sweep();f.setFailure(true);await f.a.flushUpdates();assert.equal(f.patches.length,0);assert.ok(f.logs.some(x=>x.includes('card_update_retry')));assert.ok(!f.logs.join('').includes('PRIVATE_NETWORK_ERROR'));assert.ok(!ok(f.a.receiveCard(event(r))));f.setFailure(false);f.advance(5000);await f.a.flushUpdates();assert.match(JSON.stringify(f.patches[0]),/已过期/);assert.throws(()=>f.s.consume(r.id,r.session));}finally{await f.a.stop();f.s.close();}
});
test('restart preserves receipt outbox and expires old requests; new binding cannot patch old cards',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'card-restart-'));const path=join(dir,'db');let f=fixture(path);try{const r=await f.create();await f.a.stop();f.s.db.close();f=fixture(path);f.setBinding({...b,id:'new_binding'});await f.a.flushUpdates();assert.equal(f.patches.length,0);f.setBinding(b);await f.a.flushUpdates();assert.match(JSON.stringify(f.patches[0]),/已过期/);assert.ok(!ok(f.a.receiveCard(event(r))));}finally{await f.a.stop();f.s.close();rmSync(dir,{recursive:true,force:true});}
});
test('markup from tool data is escaped; incomplete form and duplicate question text reject',async()=>{
 const f=fixture();try{const r=await f.create('Write',{content:'<at id=all> [click](https://example.com)'});const json=JSON.stringify(card(r));assert.ok(!json.includes('<at'));assert.ok(json.includes('&lt;at'));assert.throws(()=>formAnswer({...r,hook:{...r.hook,tool_name:'AskUserQuestion',tool_input:questions}},'answers',{}));await assert.rejects(f.create('AskUserQuestion',{questions:[questions.questions[0],questions.questions[0]]}));}finally{await f.a.stop();f.s.close();}
});
test('official SDK dispatcher handles v2 callback separately from normal chat and returns toast',async()=>{
 const f=fixture();let dispatcher:lark.EventDispatcher|undefined,chat=0;
 const app:FeishuApp={appId:b.appId,tenantKey:b.tenantKey,appSecret:'SYNTHETIC',encryptKey:'',verificationToken:'',domain:'feishu',ingress:'websocket',websocketExclusiveConsumer:true};
 const factory:WebSocketFactory=(_app,h)=>({async start(o){dispatcher=o.eventDispatcher;h.ready();},close(){},getConnectionStatus(){return {state:'connected'};}});
 const ingress=new FeishuWebSocketIngress([app],()=>{chat++;},{factory,cardAction:(_app,data)=>f.a.receiveCard(data)});
 try{const r=await f.create();await ingress.start();const result=await dispatcher!.invoke(envelope(event(r)),{needCheck:false});assert.ok(ok(result));assert.equal(chat,0);
 await dispatcher!.invoke({schema:'2.0',header:{event_type:'im.message.receive_v1',app_id:b.appId,tenant_key:b.tenantKey},event:{sender:{sender_type:'user',tenant_key:b.tenantKey,sender_id:{open_id:b.openId}},message:{message_id:'ordinary',chat_id:b.chatId,chat_type:'p2p',message_type:'text',content:JSON.stringify({text:'normal conversation'}),create_time:String(Date.now())}}},{needCheck:false});assert.equal(chat,1);
 ingress.stop();assert.deepEqual(await dispatcher!.invoke(envelope(event(r)),{needCheck:false}),{});
 }finally{ingress.stop();await f.a.stop();f.s.close();}
});

test('stopped adapter cannot accept clicks or send new cards; input length obeys official limit',async()=>{
 const f=fixture();try{const r=await f.create('AskUserQuestion',questions);assert.throws(()=>formAnswer(r,'answers',{free0:'x'.repeat(1001),q1:['0'],free2:'ok'}));await f.a.stop();assert.ok(!ok(f.a.receiveCard(event(r,'answers',{q0:'0',q1:['0'],free2:'ok'}))));await assert.rejects(f.a.send(r));assert.equal(f.s.consume(r.id,r.session).done,false);}finally{await f.a.stop();f.s.close();}
});

test('card persistence failure rolls back approval and event receipt atomically',async()=>{
 const f=fixture();try{const r=await f.create();f.s.db.exec("CREATE TRIGGER fail_card BEFORE UPDATE ON approval_cards WHEN NEW.desired='approved' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_STORAGE_FAILURE'); END;");const e=event(r);assert.ok(!ok(f.a.receiveCard(e)));assert.equal(f.s.consume(r.id,r.session).done,false);assert.equal(f.s.db.prepare('SELECT id FROM events WHERE id=?').get(e.event_id),undefined);f.s.db.exec('DROP TRIGGER fail_card');assert.ok(ok(f.a.receiveCard(e)));}finally{await f.a.stop();f.s.close();}
});

test('standalone button callback may omit form-only name; form submission requires its name',async()=>{
 const f=fixture();try{const r=await f.create(),e=event(r);const {name,...action}=e.action;assert.ok(ok(f.a.receiveCard({...e,action})));const q=await f.create('AskUserQuestion',questions),qe=event(q,'answers',{q0:'0',q1:['0'],free2:'ok'});const {name:formName,...formAction}=qe.action;assert.ok(!ok(f.a.receiveCard({...qe,action:formAction})));}finally{await f.a.stop();f.s.close();}
});

test('flat checkers show descriptions once, submit all questions and retain extra review data',async()=>{
 const f=fixture();try{
 const input={questions:[{header:'颜色',question:'Choose color',options:[{label:'Blue',description:'Use blue for this project'},{label:'Green',description:'Use green instead'}]},{question:'Pick fruits',multiSelect:true,options:[{label:'Apple'},{label:'Pear'}]},{question:'Your note',options:[{label:'Default'}]}]};
 const r=await f.create('AskUserQuestion',input);const c=card(r) as any;const json=JSON.stringify(c);
 assert.ok(!json.includes('"questions"'));assert.ok(!json.includes('"options"'));assert.ok(!json.includes('select_static'));assert.equal(json.split('Use blue for this project').length-1,1);
 const form=c.body.elements.find((x:any)=>x.tag==='form');const checks=form.elements.filter((x:any)=>x.tag==='checker');assert.equal(checks.length,5);assert.equal(new Set(checks.map((x:any)=>x.name)).size,5);assert.ok(checks.every((x:any)=>x.checked===false && !x.behaviors));
 const valid={q0_o0:true,q0_o1:false,q1_o0:true,q1_o1:true,free2:'custom note'};
 assert.match((f.a.receiveCard(event(r,'answers',{...valid,q0_o1:true})) as any).toast.content,/单选题请只勾选一项/);
 assert.deepEqual(formAnswer(r,'answers',{free0:'other color',q1_o0:false,free1:'other fruit',free2:'note'}),{action:'answers',answers:{'Choose color':'other color','Pick fruits':'other fruit','Your note':'note'}});
 for(const bad of [{...valid,q0_o1:true},{...valid,q0_o0:false},{...valid,q0_o0:'true'},{...valid,q9_o0:true},{...valid,q0:'0'},{...valid,q0_o0:1}])assert.ok(!ok(f.a.receiveCard(event(r,'answers',bad))));
 const toggle=event(r,'answers',valid);toggle.action.tag='checker';assert.ok(!ok(f.a.receiveCard(toggle)));assert.equal(f.s.consume(r.id,r.session).done,false);
 const submit=event(r,'answers',valid);assert.ok(ok(f.a.receiveCard(submit)));assert.ok(!ok(f.a.receiveCard(submit)));
 const out=f.s.consume(r.id,r.session).result as any;assert.deepEqual(out.hookSpecificOutput.updatedInput.answers,{'Choose color':'Blue','Pick fruits':'Apple, Pear','Your note':'custom note'});
 const more=card({...r,hook:{...r.hook,tool_input:{command:'inspect /tmp/important',questions:[{...input.questions[0],context_path:'/tmp/context',options:[{label:'One',description:'<at id=all>',target_path:'/tmp/target'}]}]}}});
 const moreJson=JSON.stringify(more);for(const value of ['important','context','target'])assert.ok(moreJson.includes(value));assert.ok(moreJson.includes('"tag":"plain_text","content":"One\\n<at id=all>"'));
 }finally{await f.a.stop();f.s.close();}
});

test('tool execution and plan review keep full commands, paths and input values',async()=>{
 const f=fixture();try{for(const [tool,input] of [['Bash',{command:'ls /tmp/review',timeout:5000}],['Write',{file_path:'/tmp/output',content:'full file content'}],['ExitPlanMode',{plan:'review this plan',planFilePath:'/tmp/plan'}]] as const){const r=await f.create(tool,input);const c=card(r) as any;const rendered=c.body.elements.filter((x:any)=>x.tag==='markdown').map((x:any)=>x.content).join('\n');for(const value of Object.values(input))assert.ok(rendered.includes(String(value)));}}finally{await f.a.stop();f.s.close();}
});

test('explicit plan availability offers two choices; only bypass choice emits session mode update',async()=>{
 const f=fixture(':memory:',true);try{
 const input={plan:'SYNTHETIC PLAN',planFilePath:'/tmp/synthetic-plan',extra:'preserved'};
 const normal=await f.create('ExitPlanMode',input);const ui=JSON.stringify(card(normal));assert.match(ui,/批准并保留普通审批/);assert.match(ui,/批准并进入本会话 bypass/);assert.match(ui,/整个当前会话/);assert.match(ui,/组织和平台/);
 assert.ok(ok(f.a.receiveCard(event(normal,'allow'))));const regular=f.s.consume(normal.id,normal.session).result as any;assert.equal(regular.hookSpecificOutput.decision.updatedPermissions,undefined);assert.deepEqual(regular.hookSpecificOutput.decision.updatedInput,input);
 const r=await f.create('ExitPlanMode',input);const e=event(r,'bypass');assert.ok(ok(f.a.receiveCard(e)));assert.ok(!ok(f.a.receiveCard(e)));await f.a.flushUpdates();assert.match(JSON.stringify(f.patches.at(-1)),/已请求本会话 bypass/);
 const output=f.s.consume(r.id,r.session).result as any;assert.deepEqual(output.hookSpecificOutput.decision.updatedPermissions,[{type:'setMode',mode:'bypassPermissions',destination:'session'}]);assert.deepEqual(output.hookSpecificOutput.decision.updatedInput,input);assert.ok(!ok(f.a.receiveCard(event(r,'bypass'))));
 const denied=await f.create('ExitPlanMode',input);assert.ok(ok(f.a.receiveCard(event(denied,'bypass'))));assert.ok(ok(f.a.receiveCard(event(denied,'deny',{feedback:'Not this plan'}))));assert.equal((f.s.consume(denied.id,denied.session).result as any).hookSpecificOutput.decision.behavior,'deny');
 }finally{await f.a.stop();f.s.close();}
});

test('bypass callback cannot exceed launch availability, plan tool/mode, binding, expiry or session',async()=>{
 const safe=fixture();const f=fixture(':memory:',true);try{
 const unoffered=await safe.create('ExitPlanMode',{plan:'ordinary'});assert.ok(!JSON.stringify(card(unoffered)).includes('act_bypass'));assert.ok(!ok(safe.a.receiveCard(event(unoffered,'bypass'))));
 const write=await f.create('Write');assert.ok(!JSON.stringify(card(write)).includes('act_bypass'));assert.ok(!ok(f.a.receiveCard(event(write,'bypass'))));
 const r=await f.create('ExitPlanMode',{plan:'test'});for(const h of [{...r.hook,permission_mode:'default'},{...r.hook,hook_event_name:'PreToolUse' as const}]){assert.ok(!JSON.stringify(card({...r,hook:h})).includes('act_bypass'));assert.throws(()=>formAnswer({...r,hook:h},'bypass',{}));}
 const e=event(r,'bypass');for(const bad of [{...e,operator:{...e.operator,open_id:'other'}},{...e,context:{...e.context,open_message_id:'wrong'}},{...e,action:{...e.action,value:{...e.action.value,session:randomUUID()}}},{...e,create_time:String((Date.now()-301000)*1000)}])assert.ok(!ok(f.a.receiveCard(bad)));
 f.setBinding({...b,id:'changed'});assert.ok(!ok(f.a.receiveCard(e)));f.setBinding(b);f.advance(1001);assert.ok(!ok(f.a.receiveCard(e)));
 }finally{await safe.a.stop();safe.s.close();await f.a.stop();f.s.close();}
});
