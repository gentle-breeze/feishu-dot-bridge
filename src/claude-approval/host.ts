import type { Binding, FeishuSender, Inbound } from '../types.js';
import { BoundFeishuApproval } from './adapter.js';
import { serveApprovals } from './server.js';

/** Explicit opt-in host extension. No second WS connection, credentials, or schedules.
 * Install in the existing Bridge only after reviewing deployment and live testing. */
export async function startBoundApprovals(options: { directory:string; sender:FeishuSender; binding:()=>Binding|undefined; owner:string; ttlMs?:number }) {
  const initial=options.binding();
  if (!initial || !initial.active || initial.owner!==options.owner) throw new Error('owner_binding_required');
  const identity=JSON.stringify([initial.id,initial.appId,initial.tenantKey,initial.openId,initial.chatId,initial.owner]);
  let connected=true;
  const binding=()=>{const b=options.binding();return connected && b?.active && JSON.stringify([b.id,b.appId,b.tenantKey,b.openId,b.chatId,b.owner])===identity ? b : undefined;};
  let adapter:BoundFeishuApproval;
  const service=await serveApprovals(options.directory,store=>adapter=new BoundFeishuApproval(store,options.sender,binding,options.owner),options.ttlMs);
  const timer=setInterval(()=>{if(!binding())service.store.cancel();void adapter.flushUpdates().catch(()=>{});},250);
  return {
    receiveCardAuthenticated(event:unknown) { return adapter.receiveCard(event); },
    receiveAuthenticated(message:Inbound) { return adapter.receive(message); },
    disconnected() {connected=false;adapter.disconnected();},
    reconnected() {connected=true;},
    bindingChanged() {service.store.cancel();},
    async close() {clearInterval(timer);await adapter.stop();await service.close();}
  };
}
