import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {imageExecutor} from '../src/image-executor.js';
import {verifyImageDecoder} from '../src/media-image.js';
test('Linux keeps mandatory prlimit settings and unknown platforms fail closed',()=>{
 const x=imageExecutor('linux');assert.equal(x.execPath,'/usr/bin/prlimit');for(const arg of ['--data=1073741824','--fsize=0','--cpu=8','--nofile=64'])assert.ok(x.execArgv!.includes(arg));assert.throws(()=>imageExecutor('win32'),/unsupported/);
});
test('macOS native launcher enforces CPU/file/fd limits and executes the real synthetic decoder',{skip:process.platform!=='darwin'},async()=>{
 const x=imageExecutor();assert.match(x.execPath!,/dist\/native\/image-limit$/);
 const result=spawnSync(x.execPath!,['/bin/sh','-c','ulimit -t; ulimit -f; ulimit -n; ulimit -c'],{encoding:'utf8'});
 assert.equal(result.status,0);assert.deepEqual(result.stdout.trim().split('\n'),['8','0','64','0']);await verifyImageDecoder();
});
