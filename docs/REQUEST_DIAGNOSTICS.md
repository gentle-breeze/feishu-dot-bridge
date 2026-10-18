# Request and subscription diagnostics

The main HTTP app writes structured JSON records to its existing stdout log sink.
`makeApp` callers can opt in by supplying the final diagnostic sink argument.
Each request gets a server-generated UUID; client request IDs are never copied.

- `request_received`: `correlation_id`, UTC `arrived_at`, allowlisted `http_method` and `rpc_method` (the MCP header hint, not proof of a valid envelope; unknown values become `OTHER`).
- `request_failure`: the same correlation ID and a fixed `stage`: routing, authentication, protocol_validation, parameter_validation, callback_verification or database_save. Only the first observed failure is recorded.
- `subscription_saved`: emitted after the transaction commits for either supported event subscription, with `outcome: succeeded`, `expires_at` and `deadline_semantics: subscription_expires_at`.
- `request_completed`: correlation ID, monotonic `elapsed_ms`, and the actual app response `http_status`. MCP errors can legitimately have HTTP 200; use the failure record too.

`expires_at` is the database subscription expiry, also currently returned by the protocol as `refreshBefore`. It is **not** a known platform renewal schedule or a promise of a future renewal attempt. No timers or renewal policies change.

These records omit URLs, paths, bodies, headers, tokens, keys, challenges, principal/binding/subscription IDs and exception details. Every field is constructed explicitly; no request or exception objects are serialized. Sink throws and rejected promises are ignored. Logging is bounded to at most four records per request and has no durable queue; existing host log retention applies.

Scope: arrival and duration refer to the application handler, after the Node adapter has collected the body, and completion means a Response was produced, not that the client received it. Requests rejected earlier by the proxy/Node adapter (host, rate or body limits) are outside these records. Detailed stage attribution covers subscription processing; other handlers retain routing/protocol-level diagnostics. Existing standalone callback transport/verification logs remain separate. Direct Bridge calls outside an HTTP diagnostic context do not generate these request records.

Synthetic success example (all IDs and dates invented):

```json
{"event":"request_received","correlation_id":"00000000-0000-4000-8000-000000000001","arrived_at":"2026-01-01T00:00:00.000Z","http_method":"POST","rpc_method":"events/subscribe"}
{"event":"subscription_saved","correlation_id":"00000000-0000-4000-8000-000000000001","stage":"database_save","outcome":"succeeded","expires_at":"2026-01-01T01:00:00.000Z","deadline_semantics":"subscription_expires_at"}
{"event":"request_completed","correlation_id":"00000000-0000-4000-8000-000000000001","elapsed_ms":12,"http_status":200}
```
