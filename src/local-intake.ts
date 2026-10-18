import { diagnosticStage, subscriptionSaved } from './request-diagnostics.js';
import { z } from 'zod';
import { Webhook } from 'standardwebhooks';
import { BridgeError, type Principal, type CallbackTransport, type FeishuSender } from './types.js';
import type { Bridge } from './bridge.js';
import { validSecret } from './crypto.js';
import { hash, randomToken, equal, type SecretBox } from './crypto.js';
import { classifyText } from './content-safety.js';
export const LOCAL_EVENT = 'local.message.created';
const id = z.string().min(1).max(256);
export const localSubmitSchema = z.object({ binding_id:id, request_id:id, text:z.string().min(1).max(12000) }).strict();
export const localStatusSchema = z.object({ event_id:id }).strict();
export const localReplySchema = z.object({ event_id:id, text:z.string().min(1).max(12000), existing_user_authorization:z.literal(true) }).strict();
type LocalEvent = {id:string;owner:string;bindingId:string;subscriptionId:string;text:string;createdAt:number;expiresAt:number;state:string;attempts:number};
export class LocalIntake {
  constructor(private bridge:Bridge, private box:SecretBox, private transport:CallbackTransport, private sender:FeishuSender, private now:()=>number) {}
  private get db() { return this.bridge.store.db; }
  private binding(p:Principal) { this.bridge.status(p); const b=this.bridge.store.binding(p.id); if(!b) throw new BridgeError('binding_not_found',403); return b; }
  private owned(p:Principal,id:string) { const b=this.binding(p); const e=this.db.prepare('SELECT * FROM local_events WHERE id=? AND owner=? AND bindingId=?').get(id,p.id,b.id) as LocalEvent|undefined; if(!e) throw new BridgeError('local_event_not_found',403); return {b,e}; }
  private headers(id:string,sub:string,body:string,secret:string) { const at=new Date(this.now()); return {'content-type':'application/json','webhook-id':id,'webhook-timestamp':String(Math.floor(at.getTime()/1000)),'webhook-signature':new Webhook(secret).sign(id,at,body),'x-mcp-subscription-id':sub}; }
  async subscribe(p:Principal,args:{arguments:{binding_id:string};delivery:{url:string;secret:string};ttlMs?:number|null}) {
    const b=this.binding(p); if(args.arguments.binding_id!==b.id) throw new BridgeError('binding_not_found',403);
    if(!validSecret(args.delivery.secret)) throw new BridgeError('invalid_signing_secret');
    const id='local_sub_'+hash(JSON.stringify([p.id,b.id,args.delivery.url])), challenge=randomToken(), body=JSON.stringify({type:'verification',challenge}), started=this.now();
    diagnosticStage('callback_verification');
    try { const r=await this.transport.post(args.delivery.url,body,this.headers('verify_'+randomToken(),id,body,args.delivery.secret)); if(r.status<200 || r.status>=300 || this.now()-started>10000 || !equal(JSON.parse(r.body).challenge,challenge)) throw new Error(); } catch { throw new BridgeError('callback_verification_failed'); }
    const expiresAt=Math.min(p.expiresAt,this.now()+Math.min(args.ttlMs??3600000,3600000));
    diagnosticStage('database_save');
    this.bridge.store.transaction(()=>{
      if(this.binding(p).id!==b.id) throw new BridgeError('binding_not_found',403);
      this.db.prepare('UPDATE local_subscriptions SET active=0 WHERE bindingId=? AND expiresAt<=?').run(b.id,this.now());
      if(this.db.prepare('SELECT 1 FROM local_subscriptions WHERE bindingId=? AND active=1 AND id!=?').get(b.id,id)) throw new BridgeError('subscription_exists_unsubscribe_first');
      this.db.prepare('INSERT INTO local_subscriptions(id,owner,bindingId,url,secret,expiresAt) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET secret=excluded.secret,expiresAt=excluded.expiresAt,active=1').run(id,p.id,b.id,args.delivery.url,this.box.seal(args.delivery.secret),expiresAt);
    });
    subscriptionSaved(expiresAt);
    return {id,refreshBefore:new Date(expiresAt).toISOString(),cursor:null,truncated:false};
  }
  unsubscribe(p:Principal,args:{arguments:{binding_id:string};delivery:{url:string}}) {
    const b=this.binding(p); if(b.id!==args.arguments.binding_id) throw new BridgeError('binding_not_found',403);
    this.bridge.store.transaction(()=>{ const sub=this.db.prepare('SELECT id FROM local_subscriptions WHERE owner=? AND bindingId=? AND url=?').get(p.id,b.id,args.delivery.url); if(sub) {this.db.prepare('UPDATE local_subscriptions SET active=0 WHERE id=?').run(sub.id!);this.db.prepare("UPDATE local_events SET state='cancelled' WHERE subscriptionId=? AND state IN ('pending','sending')").run(sub.id!);} }); return {};
  }
  submit(p:Principal,input:unknown) {
    const args=localSubmitSchema.parse(input), b=this.binding(p); if(args.binding_id!==b.id) throw new BridgeError('binding_not_found',403);
    if(classifyText(args.text)==='credential') throw new BridgeError('credential_blocked');
    const id='local_evt_'+hash(JSON.stringify([p.id,b.id,args.request_id]));
    this.bridge.store.transaction(()=>{
      const old=this.db.prepare('SELECT text FROM local_events WHERE id=?').get(id); if(old) {if(old.text!==args.text) throw new BridgeError('request_already_reserved'); return;}
      const sub=this.db.prepare('SELECT id,expiresAt FROM local_subscriptions WHERE owner=? AND bindingId=? AND active=1 AND expiresAt>?').get(p.id,b.id,this.now()); if(!sub) throw new BridgeError('local_subscription_required',403);
      if(Number(this.db.prepare("SELECT COUNT(*) n FROM local_events WHERE state IN ('pending','sending')").get()!.n)>=1000) throw new BridgeError('local_queue_full',429);
      this.db.prepare('INSERT INTO local_events(id,owner,bindingId,requestId,subscriptionId,text,createdAt,expiresAt) VALUES (?,?,?,?,?,?,?,?)').run(id,p.id,b.id,args.request_id,sub.id!,args.text,this.now(),Math.min(Number(sub.expiresAt),p.expiresAt));
    }); return this.status(p,{event_id:id});
  }
  status(p:Principal,input:unknown) { const {e}=this.owned(p,localStatusSchema.parse(input).event_id); const reply=this.db.prepare('SELECT state,remoteMessageId FROM local_replies WHERE eventId=?').get(e.id); return {event_id:e.id,state:e.state,attempts:e.attempts,reply:reply??null}; }
  requestStatus(p:Principal,input:unknown) {
    const args=z.object({binding_id:id,request_id:id}).strict().parse(input),b=this.binding(p);
    if(b.id!==args.binding_id)throw new BridgeError('binding_not_found',403);
    const eventId='local_evt_'+hash(JSON.stringify([p.id,b.id,args.request_id]));
    if(!this.db.prepare('SELECT 1 FROM local_events WHERE id=? AND owner=? AND bindingId=?').get(eventId,p.id,b.id))return {found:false};
    return {found:true,...this.status(p,{event_id:eventId})};
  }
  reply(p:Principal,input:unknown) {
    const args=localReplySchema.parse(input), {e}=this.owned(p,args.event_id);
    if(this.now()-e.createdAt>86400000) throw new BridgeError('local_event_expired');
    if(classifyText(args.text)==='credential') throw new BridgeError('credential_blocked');
    if(!this.sender.sendBound) throw new BridgeError('send_not_supported');
    const old=this.db.prepare('SELECT text FROM local_replies WHERE eventId=?').get(e.id); if(old && old.text!==args.text) throw new BridgeError('reply_already_reserved');
    this.db.prepare('INSERT OR IGNORE INTO local_replies(eventId,text,accessUntil) VALUES (?,?,?)').run(e.id,args.text,p.expiresAt); return this.status(p,{event_id:e.id});
  }
  async pumpOne():Promise<boolean> {
    // One reply and one callback lane, always bounded; uncertain sends never replay.
    const r=this.db.prepare("SELECT r.*,e.owner,e.bindingId FROM local_replies r JOIN local_events e ON e.id=r.eventId WHERE r.state='pending' LIMIT 1").get();
    if(r) {
      const b=this.bridge.store.binding(String(r.owner));
      if(!b || b.id!==r.bindingId || this.bridge.store.isRevoked(b.owner) || Number(r.accessUntil)<=this.now()) {this.db.prepare("UPDATE local_replies SET state='cancelled' WHERE eventId=?").run(r.eventId!);return true;}
      this.db.prepare("UPDATE local_replies SET state='sending' WHERE eventId=?").run(r.eventId!);
      try { if(classifyText(String(r.text))==='credential') {this.db.prepare("UPDATE local_replies SET state='blocked' WHERE eventId=?").run(r.eventId!);return true;} const receipt=await this.sender.sendBound!(b.appId,b.chatId,String(r.text),hash(String(r.eventId)).slice(0,32)); this.db.prepare("UPDATE local_replies SET state='sent',remoteMessageId=? WHERE eventId=?").run(receipt,r.eventId!); }
      catch(error) {this.db.prepare('UPDATE local_replies SET state=? WHERE eventId=?').run(error instanceof BridgeError && error.code==='feishu_send_rejected'?'dead':'uncertain',r.eventId!);} return true;
    }
    const e=this.db.prepare("SELECT * FROM local_events WHERE state='pending' AND nextAt<=? ORDER BY seq LIMIT 1").get(this.now()) as LocalEvent|undefined; if(!e) return false;
    const sub=this.db.prepare('SELECT * FROM local_subscriptions WHERE id=?').get(e.subscriptionId), b=this.bridge.store.binding(e.owner);
    const state=(value:string)=>this.db.prepare('UPDATE local_events SET state=? WHERE id=?').run(value,e.id);
    if(!b || b.id!==e.bindingId || this.bridge.store.isRevoked(e.owner) || !sub?.active || sub.owner!==e.owner || sub.bindingId!==e.bindingId || Number(sub.expiresAt)<=this.now() || e.expiresAt<=this.now()) {state('cancelled');return true;}
    if(e.attempts>=8){state('dead');return true;}
    if(classifyText(e.text)==='credential') {state('blocked');return true;}
    this.db.prepare("UPDATE local_events SET state='sending',attempts=attempts+1 WHERE id=?").run(e.id);
    const body=JSON.stringify({eventId:e.id,name:LOCAL_EVENT,timestamp:new Date(e.createdAt).toISOString(),data:{event_id:e.id,binding_id:e.bindingId,text:e.text,source:'local',untrusted:true},cursor:null});
    try {const r=await this.transport.post(String(sub.url),body,this.headers(e.id,e.subscriptionId,body,this.box.open(String(sub.secret)))); if(r.status>=200&&r.status<300) {state('sent');return true;} if(this.db.prepare('SELECT state FROM local_events WHERE id=?').get(e.id)?.state!=='sending')return true;if(r.status>=400&&r.status<500&&r.status!==429) {state('dead');if(r.status===410)this.db.prepare('UPDATE local_subscriptions SET active=0 WHERE id=?').run(e.subscriptionId);return true;} } catch { /* at-least-once callback uses stable event id */ }
    // Unsubscribe/revoke can race a network await. Never resurrect its tombstone.
    if(this.db.prepare('SELECT state FROM local_events WHERE id=?').get(e.id)?.state!=='sending')return true;
    if(e.attempts+1>=8) state('dead'); else this.db.prepare("UPDATE local_events SET state='pending',nextAt=? WHERE id=?").run(this.now()+Math.min(300000,1000*2**e.attempts),e.id);return true;
  }
}
