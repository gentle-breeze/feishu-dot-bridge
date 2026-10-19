import type { Request, Answer, CardRecord } from './core.js';
import { z } from 'zod';
const plain=(content:string)=>({tag:'plain_text',content});
// Tool-authored text must never become card markup, links or mentions.
const escaped=(text:string)=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/[\\`*_{}\[\]()#+.!|~-]/g,'\\$&');
const text=(content:string)=>({tag:'markdown',content:escaped(content)});
const base=(title:string,elements:unknown[])=>({schema:'2.0',config:{update_multi:true,enable_forward:false},header:{title:plain(title)},body:{elements}});
const qsSchema=z.array(z.object({question:z.string(),multiSelect:z.boolean().optional(),options:z.array(z.object({label:z.string(),description:z.string().optional()}))}));
export function card(r:Request) {
  const detail=JSON.stringify(r.hook.tool_input,null,2);
  if(Buffer.byteLength(detail)>18000)throw new Error('card_too_large_review_locally');
  const button=(action:string,label:string,submit=false)=>({tag:'button',name:`act_${action}`,text:plain(label),type:action==='deny'?'danger':'primary',...(submit?{form_action_type:'submit'}:{}),behaviors:[{type:'callback',value:{kind:'claude_approval_v1',request:r.id,session:r.session,action}}]});
  const elements:unknown[]=[text(`项目目录：${r.hook.cwd || '未提供项目目录'}\n会话：${r.session}\n请求：${r.id}\n截止：${new Date(r.expires).toISOString()}\n请求摘要：${r.hook.tool_name}\n以下内容由工具提交，请审阅后决定。`),text(detail)];
  if(r.hook.tool_name==='AskUserQuestion') {
    const fields:unknown[]=[];
    for(const [index,q] of qsSchema.parse(r.hook.tool_input.questions).entries()) {
      fields.push(text(`${index+1}. ${q.question}${q.multiSelect?'（多选）':'（单选）'}`));
      fields.push({tag:q.multiSelect?'multi_select_static':'select_static',name:`q${index}`,placeholder:plain('请选择，或在下方填写其他答案'),options:q.options.map((o,i)=>({text:plain(o.label),value:String(i)})),required:false});
      fields.push({tag:'input',name:`free${index}`,placeholder:plain('其他 / 自由回答（填写后优先采用此内容）'),max_length:1000,input_type:'multiline_text'});
    }
    fields.push(button('answers','提交全部答案',true));
    elements.push({tag:'form',name:'approval_form',elements:fields},button('deny','拒绝回答'));
  } else if(r.hook.tool_name==='ExitPlanMode') {
    elements.push(button('allow','批准计划（仅本次）'),{tag:'form',name:'feedback_form',elements:[{tag:'input',name:'feedback',required:true,max_length:1000,input_type:'multiline_text',placeholder:plain('填写修改意见后退回计划')},button('deny','退回修改',true)]});
  } else elements.push(button('allow','允许本次'),button('deny','拒绝'));
  const result=base(`Claude · ${r.hook.tool_name}`,elements);
  if(Buffer.byteLength(JSON.stringify(result))>28000)throw new Error('card_too_large_review_locally');
  return result;
}
export function terminalCard(c:Pick<CardRecord,'project'|'session'|'request'|'tool'>,status:string) {
  const label=status==='approved'?'已批准':status==='denied'?'已拒绝':'已过期';
  return base(`Claude · ${label}`,[text(`项目目录：${c.project}\n会话：${c.session}\n请求：${c.request}\n请求摘要：${c.tool}\n状态：${label}`),text(status==='expired'?'请求已失效，请在新的有效会话重新发起。':'决定已记录；实际工具执行结果以 Claude CLI 为准。')]);
}
export function formAnswer(r:Request,action:'allow'|'deny'|'answers',form:Record<string,unknown>):Answer {
  if(action==='deny') {
    if(r.hook.tool_name==='ExitPlanMode')return {action:'deny',feedback:z.string().trim().min(1).max(1000).parse(form.feedback)};
    return {action:'deny'};
  }
  if(r.hook.tool_name!=='AskUserQuestion') { if(action!=='allow')throw new Error('wrong_action');return {action:'allow'}; }
  if(action!=='answers')throw new Error('answers_required');
  const answers:Record<string,string|string[]>={};
  const qs=qsSchema.parse(r.hook.tool_input.questions);
  const keys=new Set(qs.flatMap((_,i)=>[`q${i}`,`free${i}`]));
  if(Object.keys(form).some(k=>!keys.has(k)))throw new Error('unexpected_field');
  for(const [i,q] of qs.entries()) {
    const free=form[`free${i}`];
    if(free!==undefined && typeof free!=='string')throw new Error('invalid_free_text');
    if(typeof free==='string' && free.trim()) { answers[q.question]=z.string().trim().min(1).max(1000).parse(free);continue; }
    const selected=form[`q${i}`];
    const indices=q.multiSelect?z.array(z.string()).min(1).max(20).parse(selected):[z.string().parse(selected)];
    if(new Set(indices).size!==indices.length)throw new Error('duplicate_option');
    const labels=indices.map(v=>{if(!/^(0|[1-9]\d*)$/.test(v)||!q.options[Number(v)])throw new Error('unknown_option');return q.options[Number(v)]!.label;});
    answers[q.question]=q.multiSelect?labels:labels[0]!;
  }
  return {action:'answers',answers};
}
