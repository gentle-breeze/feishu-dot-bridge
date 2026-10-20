import type { Request, Answer, CardRecord } from './core.js';
import { z } from 'zod';
const plain=(content:string)=>({tag:'plain_text',content});
// Tool-authored text must never become card markup, links or mentions.
const escaped=(text:string)=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/[\\`*_{}\[\]()#+.!|~-]/g,'\\$&');
const text=(content:string)=>({tag:'markdown',content:escaped(content)});
const base=(title:string,elements:unknown[])=>({schema:'2.0',config:{update_multi:true,enable_forward:false},header:{title:plain(title)},body:{elements}});
const qsSchema=z.array(z.object({question:z.string(),header:z.string().optional(),multiSelect:z.boolean().optional(),options:z.array(z.object({label:z.string(),description:z.string().optional()}).passthrough())}).passthrough());
const extra=(value:Record<string,unknown>,known:string[])=>Object.fromEntries(Object.entries(value).filter(([k])=>!known.includes(k)));
export const canOfferBypass=(r:Request)=>r.bypass && r.hook.tool_name==='ExitPlanMode' && r.hook.hook_event_name==='PermissionRequest' && r.hook.permission_mode==='plan';
export function card(r:Request) {
  const detail=JSON.stringify(r.hook.tool_input,null,2);
  if(Buffer.byteLength(detail)>18000)throw new Error('card_too_large_review_locally');
  const button=(action:string,label:string,submit=false)=>({tag:'button',name:`act_${action}`,text:plain(label),type:action==='deny'?'danger':'primary',...(submit?{form_action_type:'submit'}:{}),behaviors:[{type:'callback',value:{kind:'claude_approval_v1',request:r.id,session:r.session,action}}]});
  const elements:unknown[]=[text(`项目目录：${r.hook.cwd || '未提供项目目录'}\n会话：${r.session}\n请求：${r.id}\n截止：${new Date(r.expires).toISOString()}\n请求摘要：${r.hook.tool_name}\n以下内容由工具提交，请审阅后决定。`)];
  // Only remove question data rendered below. Other tool inputs (including
  // commands, paths, plans and unknown question metadata) remain reviewable.
  const remaining=r.hook.tool_name==='AskUserQuestion'?extra(r.hook.tool_input,['questions']):r.hook.tool_input;
  if(Object.keys(remaining).length)elements.push(text(JSON.stringify(remaining,null,2)));
  if(r.hook.tool_name==='AskUserQuestion') {
    const fields:unknown[]=[];
    for(const [index,q] of qsSchema.parse(r.hook.tool_input.questions).entries()) {
      fields.push(text(`${index+1}. ${q.header?`${q.header}：`:''}${q.question}${q.multiSelect?'（可勾选多项）':'（请只勾选一项；多选时提交会提示重选）'}`));
      const metadata=extra(q,['question','header','multiSelect','options']);
      if(Object.keys(metadata).length)fields.push(text(JSON.stringify(metadata,null,2)));
      for(const [i,o] of q.options.entries()) {
        fields.push({tag:'checker',name:`q${index}_o${i}`,checked:false,text:plain(o.label+(o.description?`\n${o.description}`:'')),checked_style:{show_strikethrough:false,opacity:1}});
        const optionMetadata=extra(o,['label','description']);
        if(Object.keys(optionMetadata).length)fields.push(text(JSON.stringify(optionMetadata,null,2)));
      }
      fields.push({tag:'input',name:`free${index}`,placeholder:plain('其他 / 自由回答（填写后优先采用此内容）'),max_length:1000,input_type:'multiline_text'});
    }
    fields.push(button('answers','提交全部答案',true));
    elements.push({tag:'form',name:'approval_form',elements:fields},button('deny','拒绝回答'));
  } else if(r.hook.tool_name==='ExitPlanMode') {
    elements.push(button('allow','批准并保留普通审批'));
    if(canOfferBypass(r))elements.push(text('可选：批准并进入本会话 bypass 将免除整个当前会话后续的普通权限确认，不只限于本计划内的操作。仍受组织和平台限制。停止 CLI 并以普通模式启动新会话可恢复；不是全局设置。'),button('bypass','批准并进入本会话 bypass'));
    elements.push({tag:'form',name:'feedback_form',elements:[{tag:'input',name:'feedback',required:true,max_length:1000,input_type:'multiline_text',placeholder:plain('填写修改意见后退回计划')},button('deny','退回修改',true)]});
  } else elements.push(button('allow','允许本次'),button('deny','拒绝'));
  const result=base(`Claude · ${r.hook.tool_name}`,elements);
  if(Buffer.byteLength(JSON.stringify(result))>28000)throw new Error('card_too_large_review_locally');
  return result;
}
export function terminalCard(c:Pick<CardRecord,'project'|'session'|'request'|'tool'>,status:string) {
  const label=status==='approved_bypass'?'已批准 · 已请求本会话 bypass':status==='approved'?'已批准':status==='denied'?'已拒绝':'已过期';
  return base(`Claude · ${label}`,[text(`项目目录：${c.project}\n会话：${c.session}\n请求：${c.request}\n请求摘要：${c.tool}\n状态：${label}`),text(status==='expired'?'请求已失效，请在新的有效会话重新发起。':'决定已记录；实际工具执行结果以 Claude CLI 为准。')]);
}
export function formAnswer(r:Request,action:'allow'|'deny'|'answers'|'bypass',form:Record<string,unknown>):Answer {
  if(action==='bypass') {if(!canOfferBypass(r))throw new Error('bypass_unavailable');return {action:'bypass'};}
  if(action==='deny') {
    if(r.hook.tool_name==='ExitPlanMode')return {action:'deny',feedback:z.string().trim().min(1).max(1000).parse(form.feedback)};
    return {action:'deny'};
  }
  if(r.hook.tool_name!=='AskUserQuestion') { if(action!=='allow')throw new Error('wrong_action');return {action:'allow'}; }
  if(action!=='answers')throw new Error('answers_required');
  const answers:Record<string,string|string[]>={};
  const qs=qsSchema.parse(r.hook.tool_input.questions);
  // Old in-flight dropdown cards can still submit, but formats cannot be mixed.
  const legacy=qs.some((_,i)=>Object.hasOwn(form,`q${i}`));
  const keys=new Set(qs.flatMap((q,i)=>[`free${i}`,...(legacy?[`q${i}`]:q.options.map((_,j)=>`q${i}_o${j}`))]));
  if(Object.keys(form).some(k=>!keys.has(k)))throw new Error('unexpected_field');
  if(!legacy && Object.entries(form).some(([k,v])=>!k.startsWith('free') && typeof v!=='boolean'))throw new Error('invalid_checked_value');
  for(const [i,q] of qs.entries()) {
    const free=form[`free${i}`];
    if(free!==undefined && typeof free!=='string')throw new Error('invalid_free_text');
    if(typeof free==='string' && free.trim()) { answers[q.question]=z.string().trim().min(1).max(1000).parse(free);continue; }
    const selected=form[`q${i}`];
    const indices=legacy?(q.multiSelect?z.array(z.string()).min(1).max(20).parse(selected):[z.string().parse(selected)]):q.options.flatMap((_,j)=>form[`q${i}_o${j}`]===true?[String(j)]:[]);
    if(!indices.length || (!q.multiSelect && indices.length!==1))throw new Error('invalid_selection_count');
    if(new Set(indices).size!==indices.length)throw new Error('duplicate_option');
    const labels=indices.map(v=>{if(!/^(0|[1-9]\d*)$/.test(v)||!q.options[Number(v)])throw new Error('unknown_option');return q.options[Number(v)]!.label;});
    answers[q.question]=q.multiSelect?labels:labels[0]!;
  }
  return {action:'answers',answers};
}
