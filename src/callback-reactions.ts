import type { Bridge } from './bridge.js';
import { BridgeError, type FeishuSender, type Principal } from './types.js';
export class CallbackReactions {
  constructor(private bridge:Bridge, private sender:FeishuSender, private now:()=>number) {}
  private get db() {return this.bridge.store.db;}
  accepted(eventId:string) {this.db.prepare('INSERT OR IGNORE INTO callback_reactions(eventId,acceptedAt) VALUES (?,?)').run(eventId,this.now());}
  status(p:Principal,id:string) {this.bridge.status(p);const b=this.bridge.store.binding(p.id); if(!b || !this.bridge.store.ownedHandlingEvent(b,id)) throw new BridgeError('event_not_found',403); return this.db.prepare('SELECT state,attempts,acceptedAt,reactionId FROM callback_reactions WHERE eventId=?').get(id)??{state:'not_queued'};}
  async pumpOne():Promise<boolean> {
    const r=this.db.prepare("SELECT * FROM callback_reactions WHERE state IN ('pending','uncertain') AND attempts<8 AND nextAt<=? ORDER BY acceptedAt LIMIT 1").get(this.now());if(!r)return false;
    const inbox=this.bridge.store.inbox(String(r.eventId)),b=inbox&&this.bridge.store.binding(inbox.owner);
    const state=(s:string)=>this.db.prepare('UPDATE callback_reactions SET state=? WHERE eventId=?').run(s,r.eventId!);
    if(!inbox || !b || !this.bridge.store.ownedHandlingEvent(b,inbox.id) || this.bridge.store.isRevoked(b.owner)) {state('cancelled');return true;}
    if(!this.sender.findCheckMark || !this.sender.addCheckMark) {state('dead');return true;}
    this.db.prepare('UPDATE callback_reactions SET attempts=attempts+1,nextAt=? WHERE eventId=?').run(this.now()+Math.min(300000,1000*2**Number(r.attempts)),r.eventId!);
    let sending=false;
    try {
      const existing=await this.sender.findCheckMark(inbox.appId,inbox.messageId);
      if(existing) {this.db.prepare("UPDATE callback_reactions SET state='sent',reactionId=? WHERE eventId=?").run(existing,r.eventId!);return true;}
      // An absent list entry is not proof an earlier POST failed. Never resend an uncertain POST.
      if(r.state==='uncertain') return true;
      if(this.bridge.store.binding(inbox.owner)?.id!==b.id || this.bridge.store.isRevoked(b.owner)) {state('cancelled');return true;}
      state('sending'); sending=true;
      const id=await this.sender.addCheckMark(inbox.appId,inbox.messageId);
      this.db.prepare("UPDATE callback_reactions SET state='sent',reactionId=? WHERE eventId=?").run(id,r.eventId!);
    } catch(error) {
      if(sending) state(error instanceof BridgeError&&error.code==='reaction_rejected'?'dead':'uncertain');
      else if(Number(r.attempts)+1>=8 && r.state==='pending') state('dead');
    }
    return true;
  }
}
