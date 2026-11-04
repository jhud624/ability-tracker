# Browser save and recovery invariants

This client-only candidate is based on published security commit
`2c42d87f28a30d4a74f28d62adbcc4d997fb3b6b`. It does not change `storage.js`,
backup admission, dependencies, environment settings or deployment configuration.
The separate combined backup candidate `eca6c1b82057599ec53e8af9a91825a81d882782`
remains offline and on independent-review HOLD. This document is not rollout approval.

## Save versus backup versus refresh

The browser serializes captured mutation intents. Checkbox values are captured
before asynchronous autosave flushing. Activity intents use a separate queue so
flushing feedback/exercise saves does not deadlock the HTTP queue. Rendering
waits until queued activity intents finish, preserving rapid taps in the DOM.

Silent autosave identity includes method, endpoint and an explicit logical
control key: activity/exercise ID for exercise logs, activity ID for feedback.
One exercise cannot replace another exercise's unconfirmed attempt even when
they share an endpoint. Concurrent identical automatic flushes of that control
share one promise. An unconfirmed payload remains blocked from automatic retry
for that control's current intent. Deliberate changes on that SAME control,
including A-B-A, are separate intents, as is explicit form submission. Missing
logical identity refuses an automatic save before any request is sent.
This is page-session bookkeeping, not server-side/cross-reload idempotency.
After reload, inspect freshly read state before another action.

An acknowledged mutation stays saved even if a later read or redraw fails. A
lost acknowledgement is unconfirmed: it may have committed. Only reads verify
state; neither failed reads nor unlocking after a 401 replay a mutation. Known
unsent edits blocked by recovery are identified as unsent rather than unconfirmed.

Backup warnings persist independently of reads, refresh failures and toast timers.
Only a current full-state write with no warning, or a current partial receipt
with explicit empty `storage_warnings`, can clear one. A read does not establish
that a backup exists. Existing server backup behavior is unchanged.

## Complete snapshots versus partial receipts

`state.data` retains the last COMPLETE snapshot and its original revision/restore
metadata. A partial memory receipt updates only a separate receipt head, marks
full-state reconciliation required and invalidates summaries; it does not stamp
old plan/goals/completions with a newer revision or merge fields into a supposedly
complete snapshot. The app requests `/api/state` after such a receipt. A failed
read preserves acknowledgement of the write but cannot authorize a summary,
even if the summary revision matches the receipt. Only a successful full-state
response reconciles that snapshot. A full-state write reply can also reconcile it.

Summary and partial-memory receipts include revision, restore metadata and
explicit backup outcomes. Summaries require the revision/restore metadata of the
complete displayed snapshot, no outstanding reconciliation/recovery requirement,
and no intervening mutation or data change. Stale summaries cannot be copied.

## Restore/revision anomalies and explicit resync

`restored_at` is an ordering hint, NOT a fenced server generation. The inherited
server permits this race: an updater reads revision 10; another request restores
revision 2 and sets `restored_at`; the first updater commits revision 11 from
its old copy and removes `restored_at`. This client does not fix or mask that P1.

Request IDs, mutation epochs and per-channel ordering discard replies from known
obsolete requests. In contrast, a CURRENT `/api/state` reply with an unexpected
revision/restore order is displayed as the latest server snapshot, with an
explicit recovery warning. It is not silently discarded in favor of obsolete
restored data. Summaries and new/queued mutations are blocked pending explicit
resync. Acknowledged inconsistent mutation replies require a full-state read
rather than silently applying an old mutation snapshot.

Every captured activity intent carries a recovery-generation token. Beginning
recovery, or observing a normal restore boundary, permanently invalidates running
and queued older intents; explicit resync
never revives them. The activity checks after autosave waits, the HTTP queue checks
before execution, and transport checks after unlock and immediately before first
send. Detached autosave controls/timers also retain their original token instead
of silently recapturing old values after resync. Known unsent cancellation is not
reported as an unknown write outcome. Rendering waits only for still-current
activity intents, so the inspected recovery/resync snapshot can render while
invalidated work is still unwinding. A new deliberate action uses a new token. Bulk completion captures one guard,
activity-ID list and logged date at the click, retains that guard through its
initial autosave wait, and passes it through every activity wrapper. Recovery
between activities cancels all remaining captured edits. Deferred exercise-swap
rebuilds check their original control guard before creating replacement controls;
they cannot mint a fresh token from a detached pre-recovery row. Persisted exercise
drafts have no trustworthy capture generation: they stay visible and preserved,
but a new field edit or explicit Save is required before automatic submission.
Visibility/pagehide flushes alone cannot silently reauthorize them.

Normal/background reads cannot clear the resync requirement. The user must use
Refresh, which issues a READ with a local resync flag. It must confirm the same
revision/restore head as the last inspected snapshot; if the head changes, another
explicit consistent read is required. A persistent operator-review warning remains
after resync. No write is replayed. This re-establishes the browser's observation
baseline, not server recovery safety or a durable repair of the restore race.
Manual resets, clock skew and inconsistent backend reads can also trigger this
conservative warning. Reloading loses client-only ordering history.

## Static output and compatibility

The explicit static allowlist/build contains exactly `index.html`, `client-sync.js`,
`app.js`, `styles.css`; the coordinator loads before the app. Backend/data files
remain excluded. Frontend and receipt metadata should ship together. Old summary
responses without required metadata are refused rather than labeled current.

## Validation and recovery rollout HOLD

Deterministic tests cover logical-control collisions, A-B-A, delayed/lost replies,
complete-snapshot reconciliation, restore-marker loss, explicit resync, suspended running/queued activity cancellation, blocked
queued mutations, stale 401s, repeated taps, backup warnings and separate refresh
errors. HTTP receipt tests use temporary synthetic FILE storage with deliberately
failed backup creation; they require no Redis changes or private data.

The server still has an unfenced, nonrenewing five-second lease, GET-then-DEL lock
cleanup and restore outside the update lock. Recovery rollout needs fencing/CAS
covering writers AND restore, or an enforceable quiescent restoration procedure;
client resync is not a substitute. Live cause/database mapping, last verified
recovery point, exports, physical headroom and budget approval remain unresolved.
Do not deploy the held backup candidate or configure budgets from these tests.
