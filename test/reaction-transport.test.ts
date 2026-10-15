/** Official SDK + mock HTTP adapter only, with no live token or DNS calls. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import axios,{AxiosError} from 'axios';
import {Agent} from 'node:https';
import {LarkSender} from '../src/feishu.js';
import {mockApp} from './fixtures.js';
const own={reaction_id:'MOCK_reaction',operator:{operator_type:'app',operator_id:mockApp.appId},reaction_type:{emoji_type:'CheckMark'}};
function mockSender(answer:(config:any)=>unknown) {
 const calls:any[]=[];
 const http=axios.create({adapter:async config=>{calls.push(config);return {data:answer(config),status:200,statusText:'OK',headers:{},config};}});http.interceptors.response.use(r=>r.data);
 const sender=new LarkSender([mockApp],{http,wsAgent:new Agent(),startupTimeoutMs:1000,close(){}});
 (sender as any).clients.get(mockApp.appId).tokenManager.getTenantAccessToken=async()=>'MOCK_NOT_A_TOKEN';return {sender,calls};
}
test('reaction lookup uses official page limit and matches both app identity and CheckMark',async()=>{
 const {sender,calls}=mockSender(config=>{
  assert.equal(config.params.page_size,50);assert.equal(config.params.reaction_type,'CheckMark');
  return {code:0,data:config.params.page_token?{items:[own],has_more:false}:{items:[{...own,operator:{operator_type:'user',operator_id:mockApp.appId}},{...own,operator:{operator_type:'app',operator_id:'cli_other'}},{...own,reaction_type:{emoji_type:'DONE'}}],has_more:true,page_token:'MOCK_next'}};
 });assert.equal(await sender.findCheckMark(mockApp.appId,'om_MOCK'),'MOCK_reaction');assert.equal(calls.length,2);assert.ok(calls.every(c=>c.method==='get'));assert.equal(calls[1].params.page_token,'MOCK_next');
});
test('malformed or incomplete lookup never proves absence',async()=>{
 for(const data of [{items:[]},{items:[],has_more:true},{items:[{}],has_more:false},{items:[],has_more:'false'}]) {
  const {sender}=mockSender(()=>({code:0,data}));await assert.rejects(sender.findCheckMark(mockApp.appId,'om_MOCK'),/reaction_lookup_incomplete/);
 }
 const {sender,calls}=mockSender(()=>({code:0,data:{items:[],has_more:true,page_token:'same'}}));await assert.rejects(sender.findCheckMark(mockApp.appId,'om_MOCK'),/reaction_lookup_incomplete/);assert.equal(calls.length,2);
});
test('create sends exact CheckMark and validates the returned operator and type',async()=>{
 const {sender,calls}=mockSender(()=>({code:0,data:own}));assert.equal(await sender.addCheckMark(mockApp.appId,'om_MOCK'),'MOCK_reaction');assert.deepEqual(JSON.parse(calls[0].data),{reaction_type:{emoji_type:'CheckMark'}});
 for(const data of [{reaction_id:'MOCK_id'},{...own,operator:{operator_type:'app',operator_id:'cli_other'}},{...own,reaction_type:{emoji_type:'DONE'}}]) {const {sender}=mockSender(()=>({code:0,data}));await assert.rejects(sender.addCheckMark(mockApp.appId,'om_MOCK'),/reaction_receipt_uncertain/);}
});
test('duplicate-in-progress and unknown failures stay uncertain; documented rejections are definitive',async()=>{
 for(const code of [231015,999999,500]) {const {sender}=mockSender(()=>({code}));await assert.rejects(sender.addCheckMark(mockApp.appId,'om_MOCK'),/reaction_receipt_uncertain/);}
 for(const code of [231001,231002,230110]) {const {sender}=mockSender(()=>({code}));await assert.rejects(sender.addCheckMark(mockApp.appId,'om_MOCK'),/reaction_rejected/);}
 for(const code of [231002,231015]) {const {sender}=mockSender(config=>{throw new AxiosError('MOCK','ERR_BAD_REQUEST',config,undefined,{data:{code},status:400,statusText:'Bad Request',headers:{},config});});await assert.rejects(sender.addCheckMark(mockApp.appId,'om_MOCK'),code===231002?/reaction_rejected/:/reaction_receipt_uncertain/);}
});
