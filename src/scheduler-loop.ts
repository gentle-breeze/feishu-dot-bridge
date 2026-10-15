/** Optional explicit foreground loop, never started by Bridge or package installation. */
import {Scheduler} from './scheduler.js';
import {boundedJson,schedulerConfigSchema} from './scheduled-review.js';
export async function schedulerLoop(configPath:string,databasePath:string,intervalMs:number,signal:AbortSignal,
  dependencies:{tick?:()=>Promise<unknown>;wait?:(ms:number,signal:AbortSignal)=>Promise<void>;report?:(result:unknown)=>void}={}) {
 if(!Number.isInteger(intervalMs)||intervalMs<10000||intervalMs>3600000)throw new Error('invalid_scheduler_interval');
 const wait=dependencies.wait??((ms,signal)=>new Promise<void>(resolve=>{const done=()=>{clearTimeout(timer);signal.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,ms);signal.addEventListener('abort',done,{once:true});if(signal.aborted)done();}));
 while(!signal.aborted){try{const result=dependencies.tick?await dependencies.tick():await(async()=>{const config=schedulerConfigSchema.parse(boundedJson(configPath,65536,true)),scheduler=new Scheduler(databasePath,config);try{return await scheduler.tick();}finally{scheduler.close();}})();dependencies.report?.(result);}catch{dependencies.report?.({error:'scheduled_tick_failed'});}if(!signal.aborted)await wait(intervalMs,signal);}
}
