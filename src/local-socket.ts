import { createServer, createConnection, type Server } from 'node:net';
import { lstatSync, chmodSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import type { Bridge } from './bridge.js';
import { BridgeError } from './types.js';
import { localSubmitSchema, localStatusSchema } from './local-intake.js';
const requestSchema=z.discriminatedUnion('operation',[
  z.object({operation:z.literal('submit'),...localSubmitSchema.shape}).strict(),
  z.object({operation:z.literal('status'),...localStatusSchema.shape}).strict(),
  z.object({operation:z.literal('binding')}).strict()
]);
export function validateSocketPath(path:string,existing=false) {
  if(!isAbsolute(path) || Buffer.byteLength(path)>100 || realpathSync(dirname(path))!==dirname(path))throw new BridgeError('invalid_local_socket_path');
  for(let at=dirname(path);;at=dirname(at)) {
    const st=lstatSync(at);
    if(!st.isDirectory() || (st.uid!==0 && st.uid!==process.getuid?.()) || ((st.mode&0o022)!==0 && !(st.uid===0 && (st.mode&0o1000))))throw new BridgeError('untrusted_local_socket_ancestor');
    if(dirname(at)===at)break;
  }
  const parent=lstatSync(dirname(path));
  if(!parent.isDirectory() || parent.uid!==process.getuid?.() || (parent.mode&0o777)!==0o700)throw new BridgeError('local_socket_requires_private_directory');
  if(existing) {const st=lstatSync(path);if(!st.isSocket() || st.uid!==process.getuid?.() || (st.mode&0o777)!==0o600)throw new BridgeError('invalid_local_socket');}
  else {try {lstatSync(path);}catch(e) {if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e;}throw new BridgeError('local_socket_exists');}
}
/** A private same-UID endpoint. It cannot pair, subscribe, set routes, or approve actions. */
export async function startLocalSocket(path:string,bridge:Bridge,owner:string):Promise<Server> {
  validateSocketPath(path);
  const server=createServer(socket=>{
    let size=0,parts:Buffer[]=[],done=false;
    socket.setTimeout(5000,()=>socket.destroy());socket.on('error',()=>{});
    socket.on('data',(chunk:Buffer)=>{
      if(done)return;size+=chunk.length;
      if(size>65536){done=true;socket.end('{"error":"request_too_large"}\n');return;}
      parts.push(chunk);const data=Buffer.concat(parts);if(!data.includes(10))return;done=true;parts=[];
      try {
        if(data.indexOf(10)!==data.length-1)throw new BridgeError('one_request_required');
        const args=requestSchema.parse(JSON.parse(data.toString('utf8'))),p={id:owner,expiresAt:Date.now()+3600000};let result;
        if(args.operation==='binding') result=bridge.status(p);
        else if(args.operation==='submit') {const {operation,...input}=args;result=bridge.local.submit(p,input);}
        else result=bridge.local.status(p,{event_id:args.event_id});
        socket.end(JSON.stringify({result})+'\n');
      } catch(e) {socket.end(JSON.stringify({error:e instanceof BridgeError?e.code:'invalid_request'})+'\n');}
    });
  });server.maxConnections=16;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,()=>{try{chmodSync(path,0o600);resolve();}catch(e){server.close();reject(e);}});});return server;
}
export async function localRequest(path:string,input:unknown):Promise<unknown> {
  validateSocketPath(path,true);const body=JSON.stringify(requestSchema.parse(input))+'\n';
  return new Promise((resolve,reject)=>{const socket=createConnection(path);let data='';
    socket.setTimeout(5000,()=>socket.destroy(new BridgeError('local_socket_timeout')));
    socket.on('connect',()=>socket.write(body));socket.on('error',reject);
    socket.on('data',chunk=>{data+=chunk.toString();if(Buffer.byteLength(data)>65536)socket.destroy(new BridgeError('response_too_large'));});
    socket.on('end',()=>{try{resolve(JSON.parse(data));}catch{reject(new BridgeError('invalid_local_response'));}});
  });
}
