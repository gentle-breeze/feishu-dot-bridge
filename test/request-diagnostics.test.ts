import test from 'node:test';
import assert from 'node:assert/strict';
import { makeApp } from '../src/http.js';
import { BridgeError } from '../src/types.js';
import { fixture } from './fixtures.js';
import { traceRequests } from '../src/request-diagnostics.js';
const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'MOCK_SECRET', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} };
function request(params: unknown, protocol = '2026-07-28') {
  return new Request('https://bridge.example/mcp?MOCK_SECRET', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer MOCK_SECRET', 'MCP-Protocol-Version': protocol, 'Mcp-Method': 'events/subscribe', 'x-request-id': 'MOCK_SECRET' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'MOCK_SECRET', method: 'events/subscribe', params }) });
}
for (const eventName of ['feishu.message.created', 'local.message.created']) for (const scenario of ['success', 'authentication', 'protocol_validation', 'parameter_validation', 'callback_verification', 'database_save'] as const) {
  test(`request diagnostics: ${eventName} ${scenario}, correlated and private`, async () => {
    const f = fixture(), events: Readonly<Record<string, string | number>>[] = [];
    try {
      const b = f.bind();
      const params = { name: eventName, arguments: { binding_id: b.id }, delivery: { mode: 'webhook', url: 'https://callback.example/MOCK_SECRET', secret: f.secret }, _meta: meta };
      if (scenario === 'callback_verification') f.transport.post = async () => { throw new Error('MOCK_SECRET'); };
      const table = eventName === 'feishu.message.created' ? 'subscriptions' : 'local_subscriptions';
      if (scenario === 'database_save') f.store.db.exec(`CREATE TRIGGER fail_save BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'MOCK_SECRET database details'); END`);
      const app = makeApp({ authMode: 'oauth', publicUrl: 'https://bridge.example', apps: [], allowedOrigins: [] }, f.bridge, { async authenticate() { if (scenario === 'authentication') throw new BridgeError('unauthorized', 401); return f.alice; } }, undefined, undefined, event => { events.push(event); });
      const response = await app(request(scenario === 'parameter_validation' ? { ...params, delivery: {} } : params, scenario === 'protocol_validation' ? '2025-11-25' : undefined));
      await response.text();
      assert.equal(events[0]?.event, 'request_received');
      assert.equal(events.at(-1)?.event, 'request_completed');
      assert.equal(events.at(-1)?.http_status, response.status);
      assert.ok(Number(events.at(-1)?.elapsed_ms) >= 0);
      assert.equal(new Set(events.map(e => e.correlation_id)).size, 1);
      assert.match(String(events[0]?.correlation_id), /^[0-9a-f-]{36}$/);
      assert.doesNotMatch(JSON.stringify(events), /MOCK_SECRET|whsec_|https:|binding_id|authorization|challenge|stack/);
      if (scenario === 'success') {
        assert.equal(events.find(e => e.event === 'request_failure'), undefined);
        const saved = events.find(e => e.event === 'subscription_saved');
        assert.equal(saved?.deadline_semantics, 'subscription_expires_at');
        const stored = f.store.db.prepare(`SELECT expiresAt FROM ${table}`).get()!;
        assert.equal(saved?.expires_at, new Date(Number(stored.expiresAt)).toISOString());
      } else {
        assert.equal(events.find(e => e.event === 'request_failure')?.stage, scenario, JSON.stringify(events));
        assert.equal(events.find(e => e.event === 'subscription_saved'), undefined);
      }
    } finally { f.store.close(); }
  });
}
test('concurrent request IDs are isolated; throwing observers do not change responses', async () => {
  const events: Readonly<Record<string, string | number>>[] = [];
  const traced = traceRequests(async () => { await new Promise(resolve => setImmediate(resolve)); return new Response('ok'); }, e => { events.push(e); });
  await Promise.all([traced(new Request('https://example.test')), traced(new Request('https://example.test'))]);
  assert.equal(new Set(events.map(e => e.correlation_id)).size, 2);
  for (const id of new Set(events.map(e => e.correlation_id))) assert.equal(events.filter(e => e.correlation_id === id).length, 2);
  for (const sink of [() => { throw Error('MOCK_SECRET'); }, async () => { throw Error('MOCK_SECRET'); }]) {
    assert.equal((await traceRequests(async () => new Response('ok'), sink)(new Request('https://example.test'))).status, 200);
  }
  await new Promise(resolve => setImmediate(resolve));
});
test('untrusted method hints and correlation IDs are never echoed to diagnostics', async () => {
  const events: Readonly<Record<string, string | number>>[] = [];
  const app = traceRequests(async () => new Response(null, { status: 400 }), e => { events.push(e); });
  await app(new Request('https://example.test/MOCK_SECRET', { method: 'MOCK_SECRET', headers: { 'Mcp-Method': 'MOCK_SECRET', 'x-request-id': 'MOCK_SECRET' } }));
  assert.equal(events[0]?.http_method, 'OTHER');
  assert.equal(events[0]?.rpc_method, 'OTHER');
  assert.doesNotMatch(JSON.stringify(events), /MOCK_SECRET/);
});
