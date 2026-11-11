# Client mutation capture and deferred-entry audit

Scope: all `api(...)` mutation callsites, raw `fetch(...)` calls, event listeners,
timers, promise callbacks and async wrappers in `app.js`; queue/capture boundaries
in `client-sync.js`. Server/MCP writers are outside this client-only change.
Every queued server mutation retains a recovery guard through execution and the
transport checks it after unlock and immediately before its first HTTP send.
Only a new deliberate action after inspected state may capture a new guard.

| Entry point | Capture/waits before scheduling | Guard result |
| --- | --- | --- |
| Bulk Complete workout | Captures IDs/date, awaits autosaves, awaits each activity including its reads | Fixed: one click guard retained through initial wait and every loop iteration; passed through `updateActivity` and `activityIntent`, never reminted |
| Activity overall/checkbox handlers | Capture toggle/checked value, immediately call `updateActivity`; that wrapper awaits intent queue and autosaves | Original event guard retained; checked at callback entry, after autosave wait, HTTP queue execution, unlock and first send |
| Exercise auto-completion poll | Defers a checkbox change until focus leaves its row | Retains original control guard; checks before poll completion and synchronous event dispatch; stale callback cannot dispatch a fresh action |
| Exercise input/change/blur debounce | Captures row/control state, timer later flushes | Original control guard retained; draft writing and flush reject stale controls; input/change count as new edits only on a current control |
| Exercise swap rebuild timer | Captures old activity/exercise/draft, defers replacement-control creation | Audit fix: original guard checked before draft capture, before deferred rebuild and after flush; old callback cannot create freshly guarded controls |
| Persisted exercise draft on new rendering | Reads old local draft into new controls; visibility/pagehide/bulk may later flush | Audit fix: no trustworthy original generation, so preserve/display draft but require a new field edit or explicit form submission before automatic save; status says “Draft; edit to save” |
| Exercise row submit | Immediately calls explicit flusher | Uses original current control guard; old detached controls cannot submit; explicit current submission is new intent |
| Feedback input/change debounce and submit | Timers/explicit flusher | Original control guard retained; no persistent draft hydration; current form baseline prevents untouched autosaves |
| Visibility/pagehide flush | Calls current registered flushers | Each control retains its original guard; does not reauthorize persisted draft or stale control |
| `saveFeedback` → POST activity feedback | Synchronous payload serialization before API request | Preserves supplied control guard; direct new action captures guard at queue admission, before any await |
| `saveExerciseLog` → POST activity exercise-log | Same, with independent activity/exercise autosave key | Preserves supplied guard and uncertainty history; no endpoint-only control collision |
| `linkActivityActual` → POST activity actual-link | Synchronous selected ID/payload then API request | No pre-schedule async wait; queue captures guard once and retains through unlock |
| Remove planning period → DELETE planning-period ID | Synchronous confirm then immediate API request | No async pre-schedule wait or later mutation; queue guard covers execution/unlock |
| Forget memory → DELETE memory ID | Synchronous confirm then immediate API request | Same; partial receipt requires full-state reconciliation |
| Plan import → POST plans/import | Synchronous JSON parse/serialization then API request | No async pre-schedule wait; later awaits are reads/render only |
| Goals → PUT goals | Synchronous field/state capture and serialization | Same |
| Planning period submit → POST planning-periods/upsert | Synchronous field capture and serialization | Same |
| Coach notes → PUT coach-notes | Synchronous field capture and serialization | Same |
| Coach memory submit → POST coach-memories/upsert | Synchronous field/version capture and serialization | Same; partial receipt cannot label old full state with new revision |
| Actuals import → POST health/import | Synchronous JSON parse/serialization | No async pre-schedule wait; later reads do not issue another mutation |
| Gear submit → POST gear/upsert | Synchronous JSON parse/serialization | Same |
| `api` response wrapper | Awaits one mutation, optionally reads full state | Does not schedule a second mutation or replay the first |
| Owner login/logout raw fetch | Explicit authentication actions, immediately serialize/send | Separate session operations; no captured workout edit is reminted; pending data edit guard is rechecked after unlock |
| Summary copy, tab/switch UI, chart/map/library timers, wake lock | Reads, local UI, clipboard or browser APIs | No backend data mutation scheduled |

The 13 backend-data mutation callsites route through the coordinator. The only
raw fetch callsites are that transport and explicit session login/logout.
Post-ack summary/render failures remain refresh failures and do not retry writes.

Deterministic actual-handler regressions cover initial bulk wait under normal
restore and anomaly/resync, both restore types between loop iterations, legitimate
new click, stale swap timer, persisted draft preservation/explicit authorization,
plus prior running/queued activity and unlock checks. Actual Chrome smoke covers
all four bulk scenarios and draft review behavior with synthetic local storage.

Limits: guards are browser observations, not server fencing, cross-tab conflict
resolution or durable/cross-reload idempotency. They cannot undo a request already
sent or detect an unobserved server restore. The inherited server restore/update
race remains unresolved and blocks recovery rollout.
