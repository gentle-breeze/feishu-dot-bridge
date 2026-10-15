# Scheduled review tasks (disabled until configured)

This fork adds a one-shot task scheduler and a `review-summary-v1` adapter. It does
not install a timer, start a loop, create a subscription, use Bridge credentials,
execute a model, or write/push a skill repository. The separate task database is
schema **1**; the Bridge database remains **7** and is never opened by the scheduler.
This branch is based on main `7fc5a07`, not the unmerged image-default branch.

## Source and target discovery

Read-only inspection of the local commit-review implementation established:

- `lib/reviews.mjs` persists authoritative version-1 `comments.json`; `comments.md`
  is a regenerated export. Files live under `.reviews/<first 20 hex characters of
  SHA256(repository path)>/comments.json` unless its `--data-dir` was overridden.
- The root records `repository`, `version`, and `comments`. A comment has ID, SHA,
  path, body, timestamps, resolved state, and optional replies. Reply editing also
  updates the comment timestamp. Reading does not instantiate ReviewStore (which
  would persist on opening), call the live HTTP service, or modify review data.
- The project contains `.claude/skills/review-comments/SKILL.md`. This is a discovered
  **candidate**, not a confirmed learning target. No source content, local paths,
  real bindings or target selection are embedded in shipped configuration.

The operator must explicitly select the reviewed repositories and exact files;
no directory crawling or automatic project expansion occurs at runtime. User
confirmation of target repository/remote/allowed files, time and timezone is still
needed before enabling. The example time is illustrative, not a chosen schedule.

## Configuration and commands

Build with `npm run build`. Copy `examples/scheduled-review.json` into an existing
canonical same-owner **0700 directory**, chmod the copy **0600**, and edit locally.
The scheduler database must be a separate **0600** file in a canonical same-owner
0700 directory with trusted ancestors. It is created on first stateful command.
Do not point it at a Bridge/review database. Unknown databases and schema versions
are rejected. Configuration paths must be absolute; symlinks are rejected.

Configuration is strict: unknown keys, duplicate job IDs, invalid IANA timezones,
invalid daily `HH:mm`, and unsupported task types fail closed. Each task sets:

- `id`, `type`, `enabled`, local daily `time`, IANA `timezone`, exact `bindingId`;
- `parameters.sources`: up to eight exact `{file, repository}` pairs;
- `historyDays` (0–30), `maxComments` (1–50);
- `authorizationReference`: a reference to independently verified user authorization;
- `target`: `{repository, remote, branch: "main", files: ["skills/name/SKILL.md"]}`.

Target files must be relative SKILL.md paths without parent traversal or `.git`.
The remote is an explicit HTTPS GitHub repository URL without embedded credentials.
Enabling requires a non-null target and authorization reference. These values are
scope declarations, **not proof of approval or permission grants**. Dot must verify
current user authorization and its actual tools/permissions separately.

Commands (replace paths; none is automatically executed on install/start):

```sh
node dist/scripts/tasks.js /private/tasks.json /private/tasks.sqlite preview daily-review
node dist/scripts/tasks.js /private/tasks.json /private/tasks.sqlite tick
node dist/scripts/tasks.js /private/tasks.json /private/tasks.sqlite run daily-review
node dist/scripts/tasks.js /private/tasks.json /private/tasks.sqlite status
node dist/scripts/tasks.js /private/tasks.json /private/tasks.sqlite refresh
node dist/scripts/tasks.js /private/tasks.json /private/tasks.sqlite retry task_RUN_ID
```

`preview` reads the configured review source and emits the bounded payload locally;
it does not create a database, contact the socket, or require the task to be enabled.
Its output contains review data: keep it private. `status` returns metadata only.
`tick` is the scheduled trigger: after reconciliation it checks enabled tasks due
at the configured local time. An operator-approved host scheduler may invoke this
one-shot command periodically; **no cron/launchd/systemd installation is included**.
`run` is the manual trigger; it ignores the clock time but respects `enabled`.
Disabled tasks do not read review files or contact the socket on run/tick/refresh.

Only the current local day is scheduled. A late tick catches up within that day;
missed prior days are not replayed. A DST gap becomes due at the first later tick;
a repeated clock hour still has one daily run. Manual and scheduled triggers share
one `(job ID, local date)` slot, so a manual early run consumes that day's slot.
Later review edits are not silently merged into the already reserved payload.

## Data boundaries

Source files must be regular canonical files, max 2 MiB each. Root repository
identity and version are checked. Review fields are validated and unknown fields
are excluded from the payload. Selection uses the comment's `updatedAt` in the
configured timezone, excludes future timestamps, and includes today plus the
bounded preceding calendar days. This is **current snapshots**, not a reconstructed
history of past comment versions. If no comment changed today, the run is `empty`
and does not send historical material alone.

Today's comments precede history, newest first. Each body is limited to 1200
characters; at most two non-deleted replies of 400 characters each are included.
Code snippets, deleted reply bodies, reply edit history and follow-up code are not
included. Truncation and omitted counts are explicit. The complete payload is at
most 12000 UTF-8 bytes. Credential heuristics run before payload persistence and
again through the existing local intake. These heuristics cannot guarantee the
absence of every secret; scope selection and authorized disclosure remain required.

Review text is a distinct untrusted JSON data section. It cannot configure task
IDs, sources, schedule, binding, target repository, remote, allowed files, permissions
or recipients. No shell commands are accepted. Additional task adapters require
reviewed code and schema changes, not executable configuration strings.

## Delivery, concurrency and recovery

The scheduler uses SQLite transactions and compare-and-set state transitions across
one-shot processes. It persists the immutable payload before socket submission.
The request ID is derived from the daily run ID. Existing rows survive restarts;
changing configuration cannot repurpose a reserved daily slot. Retain the task DB
and stable job IDs to preserve deduplication; do not delete/recreate them to retry.
An unresolved delivery blocks a later day of the same job until reconciled.

The existing private socket must already be enabled, the owner's binding must match,
and a separately authorized `local.message.created` subscription must already exist.
The scheduler cannot bind, subscribe, renew subscriptions, choose a callback URL, or
approve platform actions. A binding change/revocation stops further task submission.
Bridge owns its existing bounded callback retries and cancellation rules.

States:

- `ready` → `submitting` → `queued`: the Bridge accepted the immutable local event.
- `received`: Bridge reports callback HTTP 2xx. **Not Dot execution completion,
  not confirmation that a skill changed, and not evidence of a Git push.**
- `uncertain`: lost/malformed response or crash during submission. After a 60-second
  crash grace period, only `request_status` is used to look up the original request.
  Missing receipt does not prove non-delivery; the scheduler never blindly resends.
- `blocked`: invalid snapshot or definite pre-enqueue rejection. Explicit `retry`
  is allowed only for rejected snapshot, missing subscription, queue capacity or a
  pre-submit binding-check transport failure. It keeps the original daily ID and
  payload (except a snapshot that was never accepted). Credential/conflict failures
  and uncertain sends cannot be retried. Retry must remain in the same local day.
- `cancelled`, `failed`, `empty`: terminal. A disabled configuration stops future
  scheduling, but does not retract an event already accepted by Bridge. Use existing
  authorized unsubscribe/revoke procedures for that lifecycle; never edit its DB.

`refresh` reconciles pending deliveries from previous days, without resubmission.
A permanently unavailable uncertain receipt is an operator investigation blocker;
there is no force-resend switch. Clearing state would destroy the dedupe guarantee.
Keep the private task database and backups as sensitive review material. Back it up
only with the scheduler stopped; no pruning is provided because removing runs could
permit re-delivery. Unknown/future schemas require a reviewed migration, not downgrade.
Rollback deployment behavior by disabling tasks/stopping the external timer; preserve
both databases. This task introduces no Bridge schema migration.

## Dot execution gap and intended skill-update contract

The event contains a bounded review-analysis request and user-confirmed target scope.
Dot should compare today's lessons against history and the target skill, change only
specified files when a meaningful improvement exists, validate, and only then
commit/push the authorized main branch. It must verify remote identity and branch,
protect dirty/unrelated work, make no commit on no change, and never use private model
system prompts or internal skills as a target. Review prose cannot grant authority.

This patch **does not implement a trusted Dot execution-result protocol or a Git
writer**. Existing `reply_to_local` is an authorized Feishu message reply, not a
verified structured completion receipt. Cross-day/cross-task Git execution locking,
verified changed-file/commit evidence, remote main conflict handling and push-result
reconciliation require a separate reviewed Dot executor/result contract. Therefore
successful queue/callback tests establish delivery only, not end-to-end skill updates.
No live schedule, subscription, review disclosure, target modification or push to a
skill repository has been performed by this implementation task.
