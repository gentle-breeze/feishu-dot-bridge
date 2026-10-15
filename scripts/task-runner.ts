/** Operator-started process. No daemonization, installation or credentials. */
import {schedulerLoop} from '../src/scheduler-loop.js';
process.umask(0o077);
const [config,database,interval='60000']=process.argv.slice(2);
if(!config||!database||process.argv.length>5){console.error('usage_task_runner_config_database_interval_ms');process.exitCode=1;}
else{const controller=new AbortController();const stop=()=>controller.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
 try{await schedulerLoop(config,database,Number(interval),controller.signal,{report:result=>console.log(JSON.stringify(result))});}catch{console.error('task_runner_failed');process.exitCode=1;}
 finally{process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}}
