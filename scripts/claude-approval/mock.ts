import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { serveApprovals } from '../../src/claude-approval/server.js';
import { card } from '../../src/claude-approval/adapter.js';
const directory = resolve(process.argv[2] || '.claude-approval-mock');
const service = await serveApprovals(directory,()=>({async send(request) {
  process.stdout.write(JSON.stringify({mock:true,request:request.id,session:request.session,card:card(request)})+'\n');
}}));
process.stderr.write('LOCAL SIMULATION ONLY. Paste {"request":"...","session":"...","action":"deny"} on stdin.\n');
const lines=createInterface({input:process.stdin});
lines.on('line',line=>{try{const {request,session,...answer}=JSON.parse(line);process.stderr.write(service.store.answer(request,session,crypto.randomUUID(),answer)+'\n');}catch{process.stderr.write('invalid_reply\n');}});
let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;lines.close();await service.close();};
process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());lines.once('close',()=>void stop());
