import {SkillExecution,executionContextSchema,revisionSchema,reconcileExecutionSchema} from './skill-execution.js';
import {SkillGitExecutor,type ExecutorConfig} from './skill-git-executor.js';
/** Optional personal-owner MCP adapter; arguments cannot change executable configuration. */
import { z } from 'zod';
import type { Bridge } from './bridge.js';
import { BridgeError, type Principal } from './types.js';
import { Scheduler, type TaskConfig } from './scheduler.js';
import { localRequest } from './local-socket.js';
export const scheduledTaskSchema=z.object({task_id:z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),binding_id:z.string().min(1).max(256)}).strict();
export const runScheduledTaskSchema=scheduledTaskSchema.extend({existing_user_authorization:z.literal(true)}).strict();
export class ScheduledTaskTools {
  constructor(private bridge:Bridge,private owner:string,private databasePath:string,private config:TaskConfig,private now:()=>number=Date.now,private request:typeof localRequest=localRequest,private executorFactory:(c:ExecutorConfig)=>SkillGitExecutor=c=>new SkillGitExecutor(c)) {}
  private authorize(p:Principal,bindingId:string,taskId:string){
    if(p.id!==this.owner)throw new BridgeError('unauthorized',403);
    const status=this.bridge.status(p),job=this.config.jobs.find(j=>j.id===taskId);
    if(!status.bound || status.binding_id!==bindingId || !job || job.bindingId!==bindingId)throw new BridgeError('scheduled_task_not_available',403);
    return job;
  }
  async run(p:Principal,input:unknown){
    const args=runScheduledTaskSchema.parse(input);this.authorize(p,args.binding_id,args.task_id);
    const scheduler=new Scheduler(this.databasePath,this.config,this.now,async(path,request)=>{
      this.authorize(p,args.binding_id,args.task_id); // Recheck expiry/revoke/binding before every await boundary's next operation.
      return this.request(path,request);
    });
    try{return await scheduler.run(args.task_id);}finally{scheduler.close();}
  }
  async execute(p:Principal,operation:'context'|'submit'|'reconcile',input:unknown){
    const args=operation==='submit'?revisionSchema.parse(input):operation==='reconcile'?reconcileExecutionSchema.parse(input):executionContextSchema.parse(input);
    const job=this.authorize(p,args.binding_id,args.task_id);
    if(!job.enabled)throw new BridgeError('scheduled_task_disabled');
    const scheduler=new Scheduler(this.databasePath,this.config,this.now);
    try{
      const run=scheduler.db.prepare('SELECT id,state FROM runs WHERE eventId=? AND jobId=?').get(args.event_id,args.task_id);
      if(!run || ('run_id' in args && args.run_id!==run.id) || !['queued','received','uncertain'].includes(String(run.state)))throw new BridgeError('skill_event_run_mismatch');
      const authorize=()=>{this.authorize(p,args.binding_id,args.task_id);if(this.bridge.local.status(p,{event_id:args.event_id}).state!=='sent')throw new BridgeError('skill_callback_not_received');};
      authorize();scheduler.db.prepare("UPDATE runs SET state='received' WHERE id=? AND state IN ('queued','uncertain')").run(run.id!);
      const execution=new SkillExecution(scheduler,this.config,this.now,this.executorFactory);
      return await (operation==='context'?execution.context(job,String(run.id),authorize):operation==='submit'?execution.submit(job,revisionSchema.parse(args),authorize):execution.reconcile(job,String(run.id),authorize));
    }finally{scheduler.close();}
  }
  status(p:Principal,input:unknown){
    const args=scheduledTaskSchema.parse(input),job=this.authorize(p,args.binding_id,args.task_id);
    const scheduler=new Scheduler(this.databasePath,this.config,this.now);
    try{return {task_id:job.id,enabled:job.enabled,time:job.time,timezone:job.timezone,runs:scheduler.list().filter(r=>r.jobId===job.id)};}finally{scheduler.close();}
  }
}
