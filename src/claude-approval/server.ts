import { createServer, type Server } from 'node:http';
import { mkdirSync, lstatSync, chmodSync, existsSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ApprovalStore, hookSchema } from './core.js';
import type { ApprovalAdapter } from './adapter.js';

/** Private local IPC, never bind a TCP port. The containing directory is owner-only. */
export async function serveApprovals(directory: string, makeAdapter: (store: ApprovalStore) => ApprovalAdapter, ttl = 120000) {
  mkdirSync(directory,{recursive:true,mode:0o700});
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw new Error('unsafe_state_directory');
  const lock = join(directory,'server.lock');
  const fd = openSync(lock,'wx',0o600); // Never steal a possibly live instance's lock.
  const socket = join(directory,'approval.sock');
  let store: ApprovalStore | undefined;
  let server: Server | undefined;
  try {
    const database = join(directory,'approval.sqlite');
    if (existsSync(database) && lstatSync(database).isSymbolicLink()) throw new Error('unsafe_database');
    store = new ApprovalStore(database,Date.now,(event,request) => process.stderr.write(JSON.stringify({time:new Date().toISOString(),event,request})+'\n'));
    chmodSync(database,0o600);
    const activeStore = store, adapter = makeAdapter(activeStore);
    if (existsSync(socket)) { if (!lstatSync(socket).isSocket()) throw new Error('unsafe_socket'); unlinkSync(socket); }
    let stopped=false;
    server = createServer(async (req,res) => {
      const send = (status:number,value:unknown) => { res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value)); };
      try {
        if (req.method !== 'POST') return send(405,{error:'method'});
        let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body)>64000) throw new Error('too_large'); }
        const x = JSON.parse(body);
        if (req.url === '/register') {
          const p = z.object({session:z.string().uuid(),bypass:z.boolean()}).strict().parse(x);activeStore.register(p.session,p.bypass);return send(200,{ok:true});
        }
        if (req.url === '/heartbeat') { activeStore.heartbeat(z.string().uuid().parse(x.session));return send(200,{ok:true}); }
        if (req.url === '/cancel') { activeStore.cancel(z.string().uuid().parse(x.session));return send(200,{ok:true}); }
        if (req.url === '/hook') {
          const h = hookSchema.parse(x);
          if (!activeStore.active(h.session_id)) throw new Error('inactive_session');
          if (h.hook_event_name === 'PreToolUse' && h.tool_name !== 'AskUserQuestion') return send(200,{guard:true});
          const r = activeStore.create(h,ttl);
          // Do not hold the HTTP response while a remote API may hang. Polling stays bounded.
          void Promise.resolve().then(()=>adapter.send(r)).then(()=>{if(!stopped)activeStore.delivered(r.id);}).catch(()=>{if(!stopped)activeStore.fail(r.id);});
          return send(200,{request:r.id});
        }
        if (req.url === '/poll') {
          const p=z.object({request:z.string().uuid(),session:z.string().uuid()}).parse(x);
          return send(200,activeStore.consume(p.request,p.session));
        }
        return send(404,{error:'route'});
      } catch { send(400,{error:'request_rejected'}); }
    });
    server.requestTimeout = 5000;
    await new Promise<void>((resolve,reject)=>{server!.once('error',reject);server!.listen(socket,resolve);});chmodSync(socket,0o600);
    const sweep=setInterval(()=>activeStore.sweep(),1000);
    let closing:Promise<void>|undefined;
    return { store:activeStore,socket,close:()=>closing ??= (async()=>{stopped=true;clearInterval(sweep);activeStore.cancel();await new Promise<void>(resolve=>server!.close(()=>resolve()));activeStore.close();closeSync(fd);unlinkSync(lock);})() };
  } catch(error) { server?.close(); store?.close(); closeSync(fd);unlinkSync(lock);throw error; }
}
