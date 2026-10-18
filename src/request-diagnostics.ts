import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

type Stage = 'routing' | 'authentication' | 'protocol_validation' | 'parameter_validation' | 'callback_verification' | 'database_save';
export type DiagnosticSink = (event: Readonly<Record<string, string | number>>) => void | Promise<void>;
const context = new AsyncLocalStorage<{ id: string; sink: DiagnosticSink; stage: Stage; failed: boolean }>();
const rpcMethods = new Set(['server/discover', 'tools/list', 'tools/call', 'events/list', 'events/subscribe', 'events/unsubscribe']);
const methods = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
function emit(fields: Record<string, string | number>) {
  const ctx = context.getStore();
  if (!ctx) return;
  try { void Promise.resolve(ctx.sink(Object.freeze({ ...fields, correlation_id: ctx.id }))).catch(() => {}); } catch { /* Diagnostics must never affect requests. */ }
}
export function diagnosticStage(stage: Stage) { const ctx = context.getStore(); if (ctx) ctx.stage = stage; }
export function diagnosticFailure() {
  const ctx = context.getStore();
  if (!ctx || ctx.failed) return;
  ctx.failed = true;
  emit({ event: 'request_failure', stage: ctx.stage });
}
export function subscriptionSaved(expiresAt: number) {
  emit({ event: 'subscription_saved', stage: 'database_save', outcome: 'succeeded', expires_at: new Date(expiresAt).toISOString(), deadline_semantics: 'subscription_expires_at' });
}
export function traceRequests(handler: (request: Request) => Promise<Response>, sink?: DiagnosticSink) {
  if (!sink) return handler;
  return (request: Request) => context.run({ id: randomUUID(), sink, stage: 'routing', failed: false }, async () => {
    const start = performance.now();
    emit({ event: 'request_received', arrived_at: new Date().toISOString(), http_method: methods.has(request.method) ? request.method : 'OTHER', rpc_method: rpcMethods.has(request.headers.get('mcp-method') ?? '') ? request.headers.get('mcp-method')! : 'OTHER' });
    let status = 500;
    try { const response = await handler(request); status = response.status; if (status >= 400) diagnosticFailure(); return response; }
    catch (error) { diagnosticFailure(); throw error; }
    finally { emit({ event: 'request_completed', elapsed_ms: Math.max(0, Math.floor(performance.now() - start)), http_status: status }); }
  });
}
