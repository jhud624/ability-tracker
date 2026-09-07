# Reliable coaching preferences and personalized workout timing

Design review — September 7, 2026. Status: first implementation available on the review branch; no production changes made.

## Findings from the current app

Reviewed local server, MCP tools, dashboard code, existing weekly automation definition, and authenticated live planning context and coach summary.

1. **The current plan contradicts the stored preference.** Live coach notes say “arm set → back-health active-rest set → return to arm work.” September 7 and 11 activities instead explicitly require finishing all arm sets before the next exercise. September 7 labels demanding rows and pull-ups as active rest. The weekly goal repeats the incorrect sequencing. This is a retrieval/application problem, not simply a missing note.
2. **Structured memory exists locally but is absent from the live contract inspected.** Local `server.js` implements `coach_memories`, per-memory CRUD, and inclusion in planning context and summaries. The live responses omit that field, and this session's connector catalog exposes no dedicated memory tools. Existing uncommitted changes include this feature. Verify deployment and connector refresh before treating it as available; the exact deployment cause remains unconfirmed.
3. **Capture requires overly explicit phrasing.** The local `upsert_coaching_memories` description focuses on “remember,” “always,” and similar commands. A daily statement such as “I really like active rest between sets” should qualify as an explicit preference without requiring a special command. Activity feedback currently persists subjective fields and notes; there is no integrated preference extraction/capture transaction.
4. **Weekly generation has no preference application receipt.** The automation reads coach notes and general planning context but does not explicitly require structured preferences, conflict resolution, or a check that the exercise sequence implements them. Its default 30-minute strength target also conflates a preferred session budget with a predicted duration.
5. **Actual durations are displayed, not systematically used to calibrate forecasts.** `actualsForActivity` links actuals manually or by date/type. The summary exposes them, but the reviewed code has no personal timing estimator, immutable forecast history, or forecast-error feedback loop.
6. **Completion alone is insufficient for timing calibration.** `activityIsComplete` can become true when an actual matches, without establishing that all prescribed work was performed. A partial workout must not train the estimator as a faster complete workout.

Live evidence: September 7 has a 35-minute target and a linked strength actual of 29.88 minutes: 5.12 minutes over, or about 17% relative to actual. September 4 has a 30.88-minute strength actual; durable notes record the user's comparison of roughly 30 actual versus 60 estimated minutes. The original September 4 forecast was not independently recovered in this review. Fourteen imported strength actuals are available, but they are not fourteen validated comparable forecast/actual pairs.

## 1. Capture preferences in the daily coaching conversation

Extend the existing memory model rather than building a second memory store.

Daily flow:

1. Save workout feedback and its source event ID.
2. Classify each statement as an explicit durable preference, a temporary exception, an observed outcome, or an uncertain candidate. “I prefer X” is durable; “today my legs are sore” is a dated exception; “that took 30 minutes” is an observation. A single successful workout is not automatically a permanent preference.
3. Upsert explicit preferences by stable key, retaining the user's exact source wording and the interpreted rule. A correction creates a new version and supersedes the previous value instead of appending contradictory prose.
4. Persist feedback and derived memory together with an idempotency key. On failure, do not tell the user it was remembered. For ambiguous statements, keep a candidate and ask a narrow clarification during the conversation.
5. Read back the saved preference and acknowledge it briefly: “Remembered: alternate individual sets with another muscle group's active-rest movement.” Offer edit/undo controls.

Additional memory fields:

| Field | Purpose |
|---|---|
| `key`, `kind`, `category`, `text` | Retain existing API compatibility |
| `rule` | Typed, machine-checkable behavior where possible |
| `scope` | Applicable session types and conditions |
| `source_event_id`, `source_quote`, `asserted_at` | Explain where the preference came from |
| `status`, `effective_from`, `expires_at` | Active, superseded, candidate, or temporary |
| `version`, `supersedes_version` | Resolve corrections and detect stale writes |

Proposed canonical rule from this request:

```json
{
  "key": "strength-active-rest-sequencing",
  "kind": "preference",
  "category": "exercise",
  "text": "Alternate individual work sets with active rest using another muscle group. Examples: biceps curls with ATG lunges; pull-ups with bird dogs.",
  "scope": { "activity_types": ["strength", "lift"] },
  "rule": {
    "sequence": "alternate_sets",
    "recovery_role": "active_rest",
    "examples": [
      { "primary": "biceps curl", "active_rest": "ATG lunge" },
      { "primary": "pull-up", "active_rest": "bird dog" }
    ]
  }
}
```

Preserve “ATG lunge” as the user's wording and explicitly resolve its glossary identity before prescribing it; do not silently assume every lunge variation is equivalent. The examples are preferred patterns, not mandatory exercise choices for every session. Existing dated recovery constraints can modify their use without erasing the preference.

## 2. Make weekly planning use and verify the preferences

Return a compact `planning_brief` from the backend: current goals, active preferences with versions, current constraints, recent feedback, and timing evidence. Both daily and weekly coaching consume this same brief.

Precedence: current applicable constraints and explicit temporary exceptions govern the session; the latest explicit correction governs a preference; older notes and historical plan text are context rather than authority. If two current user instructions genuinely conflict, expose the conflict instead of silently choosing one. Expired travel notes should not occupy the active preference list.

Before plan import:

- Fetch fresh memory versions and relevant feedback, including daily updates after the previous weekly plan was generated.
- Attach an application receipt for each applicable preference: memory key/version, affected activity/block IDs, and “applied” or a concrete exception reason.
- Validate typed rules against actual structured blocks; a model-written receipt alone is not proof.
- Reject stale memory versions and invalid pairing references. Return actionable errors so the coach can revise the draft.
- Read the imported plan back and verify the blocks and preference receipts, not just titles and subtask counts.

When a preference changes midweek, flag affected future sessions as needing review. Preserve completed sessions and their logs. Let the daily coaching flow revise a specifically requested session while keeping the existing automation as the single recurring weekly writer.

## 3. Represent active rest as workout structure

Keep each movement as its own loggable subtask. Add a `blocks` array referencing those IDs:

```json
{
  "block_id": "block-curls-atg",
  "mode": "alternating_sets",
  "rounds": 3,
  "primary_subtask_id": "st-curls",
  "active_rest_subtask_id": "st-atg",
  "active_rest_between_rounds_only": true,
  "additional_rest_seconds": 0
}
```

For three primary sets and between-set active rest, the sequence is curl set 1 → ATG → curl set 2 → ATG → curl set 3. That is two active-rest bouts. If a third ATG bout is desired after the final curl set, prescribe it explicitly. Unequal set counts must be represented rather than implied in a title.

Show one paired block in the workout UI, with the next movement clear and each movement still independently loggable. Pull-ups can be primary work with bird dogs as active rest. Do not infer that any exercise labeled “back” is a recovery movement.

Time accounting: active-rest work occupies elapsed time but can replace passive rest. Include primary work, active-rest bouts, transitions, and any additional rest once each. Never add the original full passive-rest allowance on top by default.

## 4. Learn duration from actual performance

Separate three concepts:

- `time_budget_minutes`: how long the user has available.
- `estimated_duration_minutes` plus an uncertainty range: predicted time for this exact prescription.
- Planned training dose: exercises, sets, reps, loads, and intended effort.

A 30-minute forecast must not silently become a 30-minute maximum budget. Conversely, correcting a 60-minute forecast to 30 does not automatically justify doubling training volume.

### Persist comparable evidence

Create an immutable forecast snapshot when a session is first accepted: activity ID, plan revision, structured prescription, session family, estimate, budget, estimator version, and timestamp. If the user changes the prescription before training, preserve both revisions and associate the actual with the performed revision.

Record actual elapsed session duration, source, actual workout ID, confirmed full/partial completion, interruptions, and material prescription changes. Prefer an explicitly linked and confirmed actual; accept a unique compatible automatic match only when full-session coverage is established. Exclude ambiguous matches, duplicates, partial sessions, and known timer errors. Never treat missing duration as zero or use the same actual twice.

Do not sum exercise-log timestamps to infer total duration: those are logging times, not set timers. Watch duration can also omit warm-up or include unrelated time, so expose “used for timing / excluded” with an editable reason. Offer manual duration when a watch record is absent.

### Initial estimator

Start with similar-session comparisons, not a complex predictive model:

1. Separate strength with alternating active rest from straight-set strength, runs, mobility, and other activity families.
2. Use the latest 6–8 eligible comparable sessions as a proposed starting window. Match structured volume and session format; flag large prescription changes as poor matches.
3. With fewer than three comparable sessions, show low confidence and use a provisional recent comparable duration or a structural estimate. Current September evidence suggests roughly 30 minutes as a provisional reference for similar sessions, not a universal conversion factor.
4. With adequate comparable history, use a robust median duration for substantially equivalent prescriptions. For modest volume changes, use a structural baseline with a robust personal actual/baseline ratio; calibrate against the unadjusted baseline, not recursively against an already corrected forecast.
5. Publish sample count, date range, exclusions, and an empirical range. With very little data, label the range provisional rather than presenting statistical precision.
6. Backtest using chronological holdouts. Measure signed error (`predicted - actual`), absolute error in minutes, and interval coverage. Compare with the current fixed/default estimates before activating the learned estimator.

Prefer one reliable session-duration measure over requiring set timers. Optional start/pause/finish controls can improve data later, but should not make the workout harder to log.

### Use recovered time deliberately

Build the desired training dose, estimate its duration, then compare it with the user's actual budget. If there is spare time, the coach can propose another goal-relevant block or a clearly optional finish, informed by effort and recovery. Report the tradeoff in plain language. Do not trim useful work because an uncalibrated estimate says it cannot fit.

## 5. Visible evidence that the app learned

- Daily feedback: “Remembered for future strength sessions” with the interpreted preference and edit/undo.
- Goals: active preferences first; source date, temporary exceptions, and superseded history accessible.
- Weekly plan: “Used your between-set active-rest preference” linked to the actual paired blocks; show exceptions where relevant.
- Workout header: “About 30 minutes · 40 minutes available” rather than one ambiguous duration.
- Completed workout: “Estimated 35 / actual 30 minutes,” whether the session informed calibration, and why.
- Weekly review: concise preference changes and timing adjustments, with no claim of learning until persistence and read-back succeed.

## Delivery order and acceptance criteria

**First: close the existing local/live gap.** Preserve the eight already-modified source/test files. Review and validate the local memory implementation, deploy through the established project workflow, refresh the connector, and verify memory CRUD plus planning-context read-back through authenticated production tools and the signed-in Goals UI. Do not infer success from a local test or deployment response.

**Second: reliable preference application.** Add versioned capture, typed alternating blocks, weekly validation, and visible receipts. Update the existing weekly automation instead of creating another writer. Migrate durable notes into reviewed structured entries; retain original notes as history and do not silently promote temporary observations.

**Third: timing evidence and calibration.** Add immutable snapshots and eligibility checks, surface paired forecast/actual history, then enable the estimator after chronological evaluation. Historical estimates without a recoverable original prescription stay provisional.

Required behavioral tests:

1. “I like active rest between sets” survives a new chat and is included in next week's planning brief.
2. Correcting the preference supersedes one entry without changing unrelated preferences; repeated capture is idempotent.
3. Temporary soreness expires without becoming a permanent exercise exclusion.
4. Curls/ATG and pull-ups/bird-dogs appear as individual-set sequences with separate exercise logs; an all-sets-first plan fails validation.
5. A stale planner cannot overwrite or claim compliance with a newer preference.
6. A 35-minute forecast paired with a confirmed 29.88-minute complete session yields +5.12 minutes error. Missing, partial, duplicated, or ambiguous actuals are excluded.
7. Two same-day strength workouts cannot silently share one calibration actual.
8. Revised plans cannot rewrite historical predictions and make forecast errors disappear.
9. Alternating active rest does not double-count replaced passive rest; three primary sets correctly allow two between-set recovery bouts.
10. A shorter learned estimate changes the forecast without independently increasing dose or changing the time budget.

This deliverable is a repository and authenticated data-flow review/design. It does not claim a full rendered-UI audit, deployment, updated automation, saved production preference, or repaired weekly plan.

## Review implementation scope

Implemented: versioned preference CRUD and source wording; date bounds; atomic daily feedback/preference writes; alternating blocks; preference validation on imports/day updates; visible conflict notices; immutable forecast revisions; duration confirmation and exclusion; conservative comparable-session median suggestions; isolated preview storage.

Deferred: automated extraction outside a coaching conversation, cross-volume structural duration modeling, an evaluated statistical prediction interval, and automatic repair of existing plans. The current range is the observed sample range, not a statistical confidence interval. The production weekly automation and connector must be refreshed after promotion; the review preview does not change the production scheduler.
