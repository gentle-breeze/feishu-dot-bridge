/** Explicit one-shot commands only: no installed timer, daemon, subscription or Git writes. */
import { Scheduler } from '../src/scheduler.js';
import { boundedJson, schedulerConfigSchema, reviewPayload, localClock } from '../src/scheduled-review.js';
import { BridgeError } from '../src/types.js';
process.umask(0o077);
let scheduler:Scheduler|undefined;
try {
  const [configPath,databasePath,operation,arg]=process.argv.slice(2);
  if(!configPath||!databasePath||!operation||process.argv.length>6)throw new BridgeError('usage_tasks_config_database_tick_run_status_refresh_retry_preview_job_or_run_id');
  const config=schedulerConfigSchema.parse(boundedJson(configPath,65536,true));
  if(operation==='preview') {
    const job=config.jobs.find(j=>j.id===arg);if(!job)throw new BridgeError('task_not_found');
    console.log(reviewPayload(job,localClock(Date.now(),job.timezone).date,Date.now()));
  }else{
    if(!['tick','run','status','refresh','retry'].includes(operation))throw new BridgeError('unknown_task_operation');
    if(['run','retry'].includes(operation)!==Boolean(arg))throw new BridgeError('invalid_task_arguments');
    scheduler=new Scheduler(databasePath,config);
    console.log(JSON.stringify(operation==='tick'?await scheduler.tick():operation==='run'?await scheduler.run(arg!):operation==='retry'?await scheduler.retry(arg!):operation==='refresh'?await scheduler.refresh():scheduler.list()));
  }
}catch(e){console.error(JSON.stringify({error:e instanceof BridgeError?e.code:'task_request_rejected'}));process.exitCode=1;}finally{scheduler?.close();}
