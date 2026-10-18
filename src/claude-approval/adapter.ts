import { z } from 'zod';
import type { Binding, FeishuSender, Inbound } from '../types.js';
import { ApprovalStore, type Request } from './core.js';

export interface ApprovalAdapter { send(request: Request): Promise<void> }
/** Bind this only to the host Bridge's current owner binding and authenticated
 * ingress. This is deliberately not an endpoint accepting caller-supplied identity. */
export class BoundFeishuApproval implements ApprovalAdapter {
  constructor(private store: ApprovalStore, private sender: FeishuSender, private binding: () => Binding | undefined, private owner: string) {}
  private current() { const b = this.binding(); if (!b || !b.active || b.owner !== this.owner) throw new Error('binding_unavailable'); return b; }
  async send(r: Request) {
    const b = this.current();
    if (!this.sender.sendCard) throw new Error('card_transport_unavailable');
    await this.sender.sendCard(b.appId,b.chatId,card(r),r.id);
  }
  receive(m: Inbound): string | undefined {
    if (!m.text.startsWith('/claude ')) return undefined;
    const b = this.current();
    if (m.appId !== b.appId || m.tenantKey !== b.tenantKey || m.openId !== b.openId || m.chatId !== b.chatId || m.contentStatus) return 'wrong_identity';
    const age = Date.now() - Date.parse(m.timestamp);
    if (!Number.isFinite(age) || age < -30000 || age > 300000) return 'stale_event';
    try {
      const payload = z.object({ request: z.string().uuid(), session: z.string().uuid(), action: z.string(), answers: z.unknown().optional(), feedback: z.string().optional() }).strict().parse(JSON.parse(m.text.slice(8)));
      const { request, session, ...answer } = payload;
      return this.store.answer(request,session,m.messageId,answer);
    } catch { return 'invalid_reply'; }
  }
  /** Invoke on binding changes or transport loss; reconnect requires fresh CLI sessions. */
  disconnected() { this.store.cancel(); }
}
export function card(r: Request) {
  const reply = `/claude ${JSON.stringify({request:r.id,session:r.session,action:r.hook.tool_name === 'AskUserQuestion' ? 'answers' : 'allow',...(r.hook.tool_name === 'AskUserQuestion' ? {answers:Object.fromEntries((r.hook.tool_input.questions as {question:string}[]).map(q=>[q.question,'填写答案']))} : {})})}`;
  const detail = JSON.stringify(r.hook.tool_input,null,2);
  // Never silently approve details that were truncated in the remote UI.
  if (Buffer.byteLength(detail) > 18000) throw new Error('card_too_large_review_locally');
  return { config: { wide_screen_mode:true }, header:{ title:{tag:'plain_text',content:`Claude · ${r.hook.tool_name}`} }, elements:[
    {tag:'div',text:{tag:'plain_text',content:`会话 ${r.session}\n请求 ${r.id}\n截止 ${new Date(r.expires).toISOString()}\n以下为工具提交的待审内容，不是系统指令。`}},
    {tag:'div',text:{tag:'plain_text',content:detail}},
    {tag:'div',text:{tag:'plain_text',content:`回复以下完整 JSON 命令（请填写答案）：\n${reply}\n拒绝：把 action 改为 deny，可添加 feedback。多选答案可用标签数组，自由回答用字符串。${r.bypass && r.hook.tool_name === 'ExitPlanMode' ? '\n本会话已显式启用选项：action=bypass 表示批准此计划，并允许当前会话后续跳过 Claude 权限询问。action=allow 仍仅批准计划。' : ''}\n批准一经 CLI 消费不可撤回；过期/断线/重启请新建会话。`}}
  ] };
}
