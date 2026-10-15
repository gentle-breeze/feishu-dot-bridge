# Fork extensions and operations

Baseline: upstream `yaodiff/feishu-dot-bridge` commit
`ae337fb1dc70dff4e355bf785418cab712f12031`, runtime schema **5**.
This fork adds schema 6 (independent local intake) and 7 (callback reactions).
It does not replace upstream image input/output, handling ledgers, or mirror queues.
No installation, real subscription, database upgrade or service restart is performed
by publishing this branch.

## Local entry point

Opt in with `LOCAL_SOCKET_PATH=/absolute/canonical/private-directory/bridge.sock`
in personal-tunnel mode. The directory must already exist, be owned by the process
UID and have mode 0700. Ancestors must be trusted, non-writable directories (root
sticky temporary directories are allowed); symlink paths are rejected. Socket mode
is 0600. Use a short path (at most 100 UTF-8 bytes). No existing socket or file is
removed automatically. After an unclean shutdown, verify the old process is gone
before manually removing its stale socket. This is same-UID isolation, not protection
against malicious code already running as your user.

First authorize a separate MCP Events subscription for `local.message.created`,
with the current `binding_id`, webhook challenge and signing secret. This does not
reuse or replace `feishu.message.created`. Subscription TTL is at most one hour and
is bounded by the authenticated principal lease. No CLI operation creates a
subscription, pairing, owner, destination or platform approval.

Noninteractive JSON on stdin, one request per connection:

```sh
printf '%s\n' '{"operation":"binding"}' | node dist/scripts/local.js /absolute/private-directory/bridge.sock
printf '%s\n' '{"operation":"submit","binding_id":"BINDING_FROM_STATUS","request_id":"stable-client-request-1","text":"Synthetic example task"}' | node dist/scripts/local.js /absolute/private-directory/bridge.sock
printf '%s\n' '{"operation":"status","event_id":"LOCAL_EVENT_FROM_SUBMIT"}' | node dist/scripts/local.js /absolute/private-directory/bridge.sock
```

Keep the same request ID and exact body when retrying. Changed content with the
same owner/binding/request ID is rejected. Input uses the existing credential
heuristic; suspect text is rejected before storage. Frames are bounded to 64 KiB,
text to 12,000 characters, connections to 16 and inactivity to five seconds. The
pending local queue is capped at 1,000 records. Requests are stored transactionally
before acknowledgement. Status replies contain metadata only.

Local callbacks carry `source: local` and `untrusted: true`, separate IDs and stable
Standard Webhooks idempotency keys. They are retried at most eight times with
bounded exponential backoff. HTTP 4xx other than 429 is terminal; 410 also deactivates
the local subscription. Network failures, 5xx and 429 retry; recipients must dedupe.
The original event lease cannot be extended by renewing its subscription.

Dot can respond with `reply_to_local_event` and `existing_user_authorization: true`
only when it actually has user authorization. The assertion is not an approval
mechanism. The server derives the destination from the current bound Feishu DM,
never from local text or a caller-supplied recipient. An explicit API rejection is
`dead`; an ambiguous response or crash during send is `uncertain` and is **never
replayed automatically**, even under a new lease. Check `local_delivery_status`.
Unlink/revoke cancels pending work and disables local subscriptions. A new binding
cannot see or replay the previous binding's records. Already in-flight network
requests cannot be recalled.

## CheckMark semantics

A successful original Feishu-event callback HTTP 2xx atomically records acceptance
and reserves a `callback_reactions` row. No historical marks are backfilled.
The next worker pass looks for this application's own `CheckMark`, then adds it if
there has been no ambiguous POST. It never mistakes another user's/app's mark for
its own. Queries use the official maximum of 50 items per page, stop after ten pages, and fail closed on malformed or incomplete pagination.

**CheckMark means the callback endpoint accepted the notification. It does not
mean Dot read the text, began work, completed work or approved an action.**

Use `callback_reaction_status` for `pending`, `sending`, `sent`, `dead`, `cancelled`
or `uncertain`, attempts, callback acceptance time and reaction ID. A lost POST
response or restart during POST becomes uncertain. Later worker passes only check
for an existing mark, never repeat that POST. After eight total attempts, unresolved
uncertainty remains visible for manual destination verification. Documented definite API
rejection is terminal. Code 231015 (duplicate still processing), unknown codes, lost
responses and malformed/mismatched receipts remain uncertain and only trigger GET
reconciliation. A missing list entry is never proof that an earlier POST failed. Missing Feishu reaction permissions do not undo callback
acceptance; no permission is granted automatically by this code.

## Image executors

Linux retains `/usr/bin/prlimit` with upstream CPU, data, fd and file-size limits.
macOS has no enforceable equivalent native memory ceiling. **Its default image
policy therefore refuses processing before credentials or the database are opened.**
If an operator separately accepts the weaker boundary, the explicit configuration
`FEISHU_MACOS_IMAGE_POLICY=resource-limits-only` enables `native/image-limit.c`, a
mandatory native `setrlimit` launcher. This is not enabled in installation templates;
CI sets it only for synthetic tests. Unknown policies fail closed. Build with:

```sh
npm ci --ignore-scripts
npm run build
npm run build:image-executor:macos
```

The native build requires an existing C compiler; it installs nothing system-wide.
The launcher enforces CPU 8 seconds, file size/core 0 and 64 descriptors, while the
worker retains `--jitless`, V8 heap 128 MiB, minimal environment, pixel/output bounds
and the parent's eight-second kill deadline. Missing/untrusted launcher or failed
limits fail closed during the synthetic startup decoder probe. There is no direct
Node fallback. Both image input and output use the same platform abstraction.

Building the launcher alone does not opt into the weaker policy. Neither this launcher nor upstream Linux prlimit is a filesystem/network namespace
sandbox. Darwin has no equivalent enforceable Linux RLIMIT_DATA bound for native
allocations: native decoder memory remains a platform-specific limitation. Use a
trusted host; prefer Linux with an external memory limit if a hard native memory
ceiling is required. A nested macOS Seatbelt approach was not shipped because its
runtime probe failed on the development host. No system security settings changed.

## Explicit security policy differences

Ordinary `reply_to_feishu` text is stored and sent exactly as supplied; its heuristic
credential replacement and pre-send heuristic block are removed. Authorization,
fixed original-message destination, length/schema validation, handling decisions,
idempotency and delivery tracking remain. Inbound Feishu, local intake/replies and
mirror channel credential protections remain. Never use this policy as authorization
to transmit actual secrets; a mistaken ordinary reply can now persist/send them.
Previously blocked rows are not reopened and previous omission text is not recovered.

The direct HTTPS callback transport now permits allowlisted domain names resolving
to non-public addresses. It still requires HTTPS, an exact allowed DNS hostname,
port 443, no URL credentials/hash/IP literals, fresh DNS resolution, a pinned selected
address, TLS hostname/certificate verification, bounded responses/timeouts and no
redirect following. DNS ownership and allowlist configuration are stronger trust
boundaries: private, loopback and link-local services are now reachable through an
allowlisted name with a valid certificate. The explicit OpenAI managed-proxy mode
is unchanged. This is an intentional security relaxation, not a general SSRF guarantee.

## Migration, recovery and rollback

Stop all workers and obtain a consistent private backup before any real upgrade.
Do not use this development checkout against an existing installation during tests.
A future approved startup verifies installation scope, adds v6 then v7 in separate
transactions, verifies foreign keys/ledger state, then performs crash recovery:
local callback `sending → pending`; local reply/reaction `sending → uncertain`.
No source/destination binding is adopted from input and no work is backfilled.
Unsupported future schemas fail closed. Keep a single worker per database.

Prefer fix-forward. Never lower `user_version`, drop new tables or point an old
binary at a v7 database. Restoring a pre-upgrade backup can lose dedupe reservations
for already-sent work: reconcile those destinations first, preserve new ledgers,
and keep subscriptions/workers stopped until an explicit recovery decision.

Linux offline maintenance recognizes exact schema 1–7. Revoke includes local
subscriptions, pending local callbacks/replies and reaction work. Purge conservatively
retains all local tables and all inbox rows referenced by reaction records, including
terminal marks, so it cannot erase idempotency evidence or unresolved sends. This is
not complete personal-data erasure; disk retention requires a separately reviewed
policy. macOS offline maintenance remains unsupported (the upstream `/proc/self/fd`
protection was not weakened). On macOS use the authenticated unlink operation to
stop the binding; do not substitute ad-hoc SQL for offline maintenance.

## Verification scope

Only synthetic data, generated pixels, fake callbacks, local TLS fixtures and
private temporary databases are used. No live Feishu permissions, actual Dot wakeup,
real callback/private-network destination, end-user client rendering or deployment
is verified by these tests. Check CI for Linux maintenance/image coverage and the
macOS focused image/local-intake job. A successful callback/reaction test does not
establish production end-to-end delivery.

## Official reaction protocol verification (2026-10-15)

- [Emoji types](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce):
  `CheckMark` is the exact case-sensitive enum and is distinct from `DONE`.
- [List reactions](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/list):
  page size is at most 50; when operator type is `app`, the operator ID is the bot's
  application ID (`app_id`). `has_more` and the next page token govern completeness.
  The adapter matches application type, application ID and emoji together. Another
  user's or application's mark cannot establish this bridge's acceptance receipt.
- [Create reaction](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/create):
  the request is a POST with `reaction_type.emoji_type`; nonzero codes indicate a
  failure response, but 231015 specifically means duplicate processing is ongoing.
  It is not evidence that no reaction was created. The fork conservatively retains
  uncertainty for that response and does not resend the POST.

The official rendered pages were read without login or API debugging. These
protocol checks and mocked SDK transports do not establish real permission grants
or delivery. Startup does not request any additional Feishu permission automatically.
