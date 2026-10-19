import { z } from 'zod';
import type { Binding, FeishuSender, Inbound } from '../types.js';
import { ApprovalStore, bindingIdentity, type Request } from './core.js';
import { card, formAnswer, terminalCard } from './cards.js';
export { card } from './cards.js';
export interface ApprovalAdapter { send(request: Request): Promise<void> }
const id=z.string().min(1).max(256);
const callbackSchema=z.object({
  event_type:z.literal('card.action.trigger'),event_id:id,create_time:z.string().regex(/^\d{16}$/),app_id:id,tenant_key:id,
  operator:z.object({open_id:id,tenant_key:id}),host:z.literal('im_message'),
  context:z.object({open_message_id:id,open_chat_id:id}),
  action:z.object({tag:z.literal('button'),name:z.string().optional(),value:z.object({kind:z.literal('claude_approval_v1'),request:z.string().uuid(),session:z.string().uuid(),action:z.enum(['allow','deny','answers'])}).strict(),form_value:z.record(z.string(),z.unknown()).optional()})
});
const toast=(content:string,ok=false)=>({toast:{type:ok?'success':'error',content}});
/** ONLY call from the existing SDK dispatcher on the authenticated app WS.
 * No HTTP/raw-JSON endpoint is exposed. IDs alone are not authentication. */
export class BoundFeishuApproval implements ApprovalAdapter {
  private stopped=false;
  private sending=new Set<Promise<void>>();
  private flushing?:Promise<void>;
  constructor(private store: ApprovalStore, private sender: FeishuSender, private binding: () => Binding | undefined, private owner: string) {}
  private current() { const b = this.binding(); if (!b || !b.active || b.owner !== this.owner) throw new Error('binding_unavailable'); return b; }
  send(r:Request):Promise<void> {
    const task=this.sendOnce(r);this.sending.add(task);
    void task.finally(()=>this.sending.delete(task)).catch(()=>{});return task;
  }
  private async sendOnce(r: Request) {
    if(this.stopped)throw new Error('adapter_stopped');
    const b = this.current();
    if (!this.sender.sendCard || !this.sender.patchCard) throw new Error('card_transport_unavailable');
    const message=await this.sender.sendCard(b.appId,b.chatId,card(r),r.id);
    this.store.cardSent(r,b,message);
  }
  // Legacy JSON replies are consumed but cannot grant approval or leak into dot.
  receive(m: Inbound): string | undefined { return m.text.startsWith('/claude ')?'use_card_controls':undefined; }
  receiveCard(raw:unknown) {
    try {
      if(!z.object({action:z.object({value:z.object({kind:z.literal('claude_approval_v1')})})}).safeParse(raw).success)return {};
      if(this.stopped)return toast('审批服务已停止，未执行');
      if(Buffer.byteLength(JSON.stringify(raw))>64000)return toast('回调过大，未执行');
      const parsed=callbackSchema.safeParse(raw);
      if(!parsed.success)return toast('无效回调，未执行');
      const e=parsed.data,b=this.current(),v=e.action.value;
      if(e.action.name!==undefined && e.action.name!==`act_${v.action}`)return toast('按钮不匹配，未执行');
      const age=Date.now()-Number(e.create_time)/1000;
      if(age < -30000 || age>300000)return toast('回调已过期，未执行');
      if(e.app_id!==b.appId || e.tenant_key!==b.tenantKey || e.operator.tenant_key!==b.tenantKey || e.operator.open_id!==b.openId || e.context.open_chat_id!==b.chatId)return toast('身份或私聊不匹配，未执行');
      this.store.reconcileCards();
      const c=this.store.cardRecord(v.request);
      if(!c || c.session!==v.session || c.message!==e.context.open_message_id || c.binding!==JSON.stringify(bindingIdentity(b)))return toast('卡片归属不匹配，未执行');
      if(c.desired==='expired')return toast('请求已过期，请重新发起');
      const r=this.store.requestForCard(v.request);
      if(!r)return toast('请求已处理，请勿重复点击');
      const submittingForm=v.action==='answers' || (r.hook.tool_name==='ExitPlanMode' && v.action==='deny');
      if(submittingForm && e.action.name!==`act_${v.action}`)return toast('表单按钮不匹配，未执行');
      const answer=formAnswer(r,v.action,e.action.form_value || {});
      const result=this.store.answer(v.request,v.session,e.event_id,answer);
      // Network patching is deliberately outside the callback's 3 second budget.
      // Persisted status is applied by the serialized outbox worker.
      return result==='accepted'?toast(answer.action==='deny'?'已拒绝，原卡片即将更新':'已记录，原卡片即将更新',true):toast(result==='expired'?'请求已过期':'请求未接受或已处理，请勿重复点击');
    } catch { return toast('表单不完整或会话失效，未执行'); }
  }
  flushUpdates():Promise<void> {
    if(this.flushing)return this.flushing;
    if(this.stopped)return Promise.resolve();
    this.flushing=this.flushOnce().finally(()=>{this.flushing=undefined;});return this.flushing;
  }
  private async flushOnce() {
    for(const c of this.store.cardUpdates()) {
      if(this.stopped)return;
      // Never update messages belonging to a different/new binding.
      let b:Binding;try{b=this.current();}catch{return;}
      if(c.binding!==JSON.stringify(bindingIdentity(b)))continue;
      try {
        if(!this.sender.patchCard)throw new Error('patch_unavailable');
        await this.sender.patchCard(b.appId,c.message,terminalCard(c,c.desired));
        this.store.cardUpdated(c.request,c.desired);
      } catch {this.store.cardRetry(c.request);}
    }
  }
  disconnected() { this.store.cancel(); }
  async stop() {this.stopped=true;await this.flushing;await Promise.allSettled(this.sending);}
}
