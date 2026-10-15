/** One-shot scheduler sidecar. It never pumps callbacks or owns Bridge credentials. */
import { DatabaseSync } from 'node:sqlite';
import { lstatSync, realpathSync, openSync, closeSync, constants } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { hash } from './crypto.js';
import { BridgeError } from './types.js';
import { localRequest } from './local-socket.js';
import { localClock, reviewPayload, schedulerConfigSchema, type ReviewJob } from './scheduled-review.js';
export type TaskConfig=z.infer<typeof schedulerConfigSchema>;
type Run={id:string;jobId:string;date:string;digest:string;requestId:string;state:string;payload:string|null;eventId:string|null;updatedAt:number;error:string|null};
const states=['preparing','ready','submitting','uncertain','queued','received','blocked','failed','cancelled','empty'];
const schema=`CREATE TABLE runs(id TEXT PRIMARY KEY,jobId TEXT NOT NULL,date TEXT NOT NULL,digest TEXT NOT NULL,requestId TEXT UNIQUE NOT NULL,state TEXT NOT NULL,payload TEXT,eventId TEXT,updatedAt INTEGER NOT NULL,error TEXT,UNIQUE(jobId,date)); PRAGMA user_version=1;`;
function privateDatabase(path:string) {
  if(!isAbsolute(path)||realpathSync(dirname(path))!==dirname(path))throw new BridgeError('scheduler_private_directory_required');
  for(let p=dirname(path);;p=dirname(p)) {const st=lstatSync(p);if(!st.isDirectory() || (st.uid!==0&&st.uid!==process.getuid?.()) || ((st.mode&0o022)!==0 && !(st.uid===0&&(st.mode&0o1000))))throw new BridgeError('scheduler_untrusted_ancestor');if(dirname(p)===p)break;}
  const parent=lstatSync(dirname(path));if(parent.uid!==process.getuid?.() || (parent.mode&0o777)!==0o700)throw new BridgeError('scheduler_private_directory_required');
  try{const fd=openSync(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600);closeSync(fd);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}
  const st=lstatSync(path);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o777)!==0o600)throw new BridgeError('scheduler_private_database_required');
}
const response=z.union([z.object({error:z.string()}),z.object({result:z.unknown()})]);
const receipt=z.object({event_id:z.string().min(1),state:z.enum(['pending','sending','sent','dead','cancelled','blocked']),attempts:z.number().int().min(0)});
export class Scheduler {
  readonly db:DatabaseSync;
  constructor(path:string,readonly config:TaskConfig,private now:()=>number=Date.now,private request:(path:string,input:unknown)=>Promise<unknown>=localRequest) {
    schedulerConfigSchema.parse(config);privateDatabase(path);this.db=new DatabaseSync(path);
    try{this.db.exec('PRAGMA busy_timeout=5000;');this.db.exec('BEGIN IMMEDIATE');
      const version=Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
      if(version===0){if(Number(this.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get()!.n)!==0)throw new BridgeError('scheduler_unknown_database');this.db.exec(schema);}
      else if(version!==1)throw new BridgeError('scheduler_unsupported_schema');
      const expected=new DatabaseSync(':memory:');
      try {expected.exec(schema);const description=(db:DatabaseSync)=>JSON.stringify(db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY name").all());if(description(this.db)!==description(expected))throw new BridgeError('scheduler_invalid_schema');}finally{expected.close();}
      if(this.db.prepare('PRAGMA quick_check').get()!.quick_check!=='ok')throw new BridgeError('scheduler_invalid_database');
      const columns=this.db.prepare('PRAGMA table_info(runs)').all().map(r=>r.name).join(',');
      if(columns!=='id,jobId,date,digest,requestId,state,payload,eventId,updatedAt,error')throw new BridgeError('scheduler_invalid_schema');
      for(const r of this.db.prepare('SELECT state,updatedAt FROM runs').all())if(!states.includes(String(r.state))||typeof r.updatedAt!=='number'||!Number.isSafeInteger(r.updatedAt)||Number(r.updatedAt)<0)throw new BridgeError('scheduler_invalid_state');
      this.db.exec('COMMIT');
    }catch(e){try{this.db.exec('ROLLBACK');}catch{}this.db.close();throw e;}
  }
  close(){this.db.close();}
  list(){return this.db.prepare('SELECT id,jobId,date,state,eventId,updatedAt,error FROM runs ORDER BY updatedAt DESC LIMIT 100').all();}
  private row(id:string){return this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Run|undefined;}
  private update(id:string,state:string,error:string|null=null,eventId:string|null=null){this.db.prepare("UPDATE runs SET state=?,error=?,eventId=coalesce(?,eventId),updatedAt=? WHERE id=? AND state NOT IN ('received','cancelled','empty','failed')").run(state,error,eventId,this.now(),id);}
  private async call(input:unknown){const r=response.parse(await this.request(this.config.socketPath,input));if('error'in r)throw new BridgeError(r.error);return r.result;}
  private async bound(job:ReviewJob){const r=z.object({bound:z.boolean(),binding_id:z.string().optional()}).parse(await this.call({operation:'binding'}));if(!r.bound||r.binding_id!==job.bindingId)throw new BridgeError('task_binding_changed');}
  private accept(id:string,value:unknown){const r=receipt.parse(value);this.update(id,r.state==='sent'?'received':r.state==='pending'||r.state==='sending'?'queued':r.state==='dead'?'failed':r.state,null,r.event_id);}
  async run(jobId:string,mode:'manual'|'tick'='manual') {
    const job=this.config.jobs.find(j=>j.id===jobId);if(!job)throw new BridgeError('task_not_found');
    if(!job.enabled)return {jobId,state:'disabled'};
    const clock=localClock(this.now(),job.timezone);
    if(mode==='tick'&&clock.time<job.time)return {jobId,state:'not_due'};
    const id='task_'+hash(JSON.stringify([job.id,clock.date])),digest=hash(JSON.stringify({job,socketPath:this.config.socketPath}));
    this.db.exec('BEGIN IMMEDIATE');
    try{let r=this.row(id);if(r&&r.digest!==digest)throw new BridgeError('task_configuration_changed_for_reserved_day');
      if(!r){if(this.db.prepare("SELECT 1 FROM runs WHERE jobId=? AND state IN ('preparing','ready','submitting','uncertain','queued') LIMIT 1").get(job.id))throw new BridgeError('previous_task_delivery_unresolved');this.db.prepare("INSERT INTO runs(id,jobId,date,digest,requestId,state,updatedAt) VALUES (?,?,?,?,?,'preparing',?)").run(id,job.id,clock.date,digest,id,this.now());
        // File reading is bounded and synchronous while reserving, so no competing snapshot.
        try{const payload=reviewPayload(job,clock.date,this.now());this.db.prepare('UPDATE runs SET payload=?,state=? WHERE id=?').run(payload,JSON.parse(payload).todayCount?'ready':'empty',id);}catch{this.update(id,'blocked','review_snapshot_rejected');}}
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    let r=this.row(id)!;
    if(r.state==='submitting' && this.now()-r.updatedAt>=60000)this.db.prepare("UPDATE runs SET state='uncertain' WHERE id=? AND state='submitting' AND updatedAt<=?").run(id,this.now()-60000);
    r=this.row(id)!;
    if(['queued','uncertain'].includes(r.state))return this.reconcile(job,id);
    if(r.state!=='ready')return this.summary(id);
    const claimed=this.db.prepare("UPDATE runs SET state='submitting',updatedAt=? WHERE id=? AND state='ready'").run(this.now(),id);if(!claimed.changes)return this.summary(id);
    try {await this.bound(job);}catch(e) {this.update(id,e instanceof BridgeError&&['task_binding_changed','binding_not_found','unauthorized'].includes(e.code)?'cancelled':'blocked','binding_check_failed');return this.summary(id);}
    try {this.accept(id,await this.call({operation:'submit',binding_id:job.bindingId,request_id:r.requestId,text:r.payload}));}
    catch(e){ // A lost socket response is not evidence of rejection. Never submit again.
      const definitive=e instanceof BridgeError&&['credential_blocked','binding_not_found','unauthorized','local_subscription_required','local_queue_full','request_already_reserved'].includes(e.code);
      this.update(id,definitive?'blocked':'uncertain',definitive?(e as BridgeError).code:'submission_unknown');
    }
    return this.summary(id);
  }
  private summary(id:string){const r=this.row(id)!;return {id:r.id,jobId:r.jobId,date:r.date,state:r.state,eventId:r.eventId,error:r.error};}
  private async reconcile(job:ReviewJob,id:string){
    try{await this.bound(job);}catch(e){const revoked=e instanceof BridgeError&&['task_binding_changed','binding_not_found'].includes(e.code);this.update(id,revoked?'cancelled':'uncertain',revoked?'binding_check_failed':'binding_status_unavailable');return this.summary(id);}
    const r=this.row(id)!;
    try{const result=await this.call({operation:'request_status',binding_id:job.bindingId,request_id:r.requestId});
      const found=z.object({found:z.boolean()}).parse(result);if(found.found)this.accept(id,result);else this.update(id,'uncertain','submission_not_found_no_automatic_resend');
    }catch{this.update(id,'uncertain','status_unavailable');}return this.summary(id);
  }
  async retry(id:string) {
    const r=this.row(id);if(!r)throw new BridgeError('task_run_not_found');
    const job=this.config.jobs.find(j=>j.id===r.jobId);
    if(!job?.enabled || r.date!==localClock(this.now(),job.timezone).date || r.digest!==hash(JSON.stringify({job,socketPath:this.config.socketPath})))throw new BridgeError('task_retry_scope_changed');
    if(r.state!=='blocked'||!['review_snapshot_rejected','local_subscription_required','local_queue_full','binding_check_failed'].includes(r.error??''))throw new BridgeError('task_retry_not_safe');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if(r.error==='review_snapshot_rejected') {
        const payload=reviewPayload(job,r.date,this.now());
        this.db.prepare("UPDATE runs SET payload=?,state=?,error=NULL,updatedAt=? WHERE id=? AND state='blocked'").run(payload,JSON.parse(payload).todayCount?'ready':'empty',this.now(),id);
      } else this.db.prepare("UPDATE runs SET state='ready',error=NULL,updatedAt=? WHERE id=? AND state='blocked'").run(this.now(),id);
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
    return this.run(job.id);
  }
  async tick(){await this.refresh();const results=[];for(const job of this.config.jobs){try{results.push(await this.run(job.id,'tick'));}catch{results.push({jobId:job.id,state:'blocked',error:'task_configuration_or_state_rejected'});}}return results;}
  async refresh(){const results=[];for(const r of this.db.prepare("SELECT * FROM runs WHERE state IN ('queued','uncertain','submitting')").all() as unknown as Run[]){
    const job=this.config.jobs.find(j=>j.id===r.jobId);if(!job?.enabled)continue;
    if(r.digest!==hash(JSON.stringify({job,socketPath:this.config.socketPath})))continue;
    if(r.state==='submitting'&&this.now()-r.updatedAt<60000)continue;
    results.push(await this.reconcile(job,r.id));
  }return results;}
}
