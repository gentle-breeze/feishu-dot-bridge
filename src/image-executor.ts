import { realpathSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ForkOptions } from 'node:child_process';
import { BridgeError } from './types.js';
const runtimeArgs=['--jitless','--max-old-space-size=128'];
/** Resource limiter, not a filesystem/network namespace sandbox. Like upstream
 * Linux, this requires a trusted host. Darwin has no equivalent enforceable
 * RLIMIT_DATA limit for native allocations; pixel/output/deadline limits apply. */
export function imageExecutor(platform:NodeJS.Platform=process.platform):ForkOptions {
  if(platform==='linux') return {execPath:'/usr/bin/prlimit',execArgv:['--core=0','--fsize=0','--data=1073741824','--cpu=8','--nofile=64','--',process.execPath,...runtimeArgs]};
  if(platform!=='darwin') throw new BridgeError('image_executor_unsupported');
  const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'), launcher=resolve(root,'dist/native/image-limit');
  const st=statSync(launcher);
  if(realpathSync(launcher)!==launcher || !st.isFile() || st.uid!==process.getuid?.() || (st.mode&0o022))throw new BridgeError('image_executor_untrusted');
  // Mandatory native launcher: fail startup if missing or if setrlimit fails.
  return {execPath:launcher,execArgv:[process.execPath,...runtimeArgs]};
}
