import {test,mock} from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PublicHttpsCallback,validateCallbackUrl} from '../src/callback.js';
// Mock only built-in seams in this isolated test process; production has no bypass.
test('direct callback accepts private DNS but retains pinned TLS and never follows redirects',async()=>{
 let calls=0;const host='synthetic.example';
 mock.method(dns,'lookup',async()=>[{address:'127.0.0.1',family:4}]);
 mock.method(https,'request',(_url:URL,options:any,callback:(res:any)=>void)=>{
  calls++;assert.equal(options.rejectUnauthorized,true);assert.equal(options.servername,host);assert.equal(options.agent,false);
  options.lookup(host,{},(error:unknown,address:string,family:number)=>{assert.equal(error,null);assert.equal(address,'127.0.0.1');assert.equal(family,4);});
  const request=new EventEmitter() as EventEmitter&{end:(body:string)=>void};request.end=()=>{const res=new EventEmitter() as any;res.statusCode=302;res.headers={location:'https://evil.invalid/'};callback(res);res.emit('end');};return request;
 });syncBuiltinESMExports();
 try {const r=await new PublicHttpsCallback([host]).post('https://'+host+'/callback','{}',{});assert.equal(r.status,302);assert.equal(calls,1);
 for(const url of ['http://synthetic.example','https://evil.invalid','https://synthetic.example:444','https://user:pass@synthetic.example','https://127.0.0.1','https://synthetic.example/#fragment'])assert.throws(()=>validateCallbackUrl(url,[host]));
 }finally{mock.restoreAll();syncBuiltinESMExports();}
});
