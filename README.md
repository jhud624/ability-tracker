# Coach Loop

A local-first workout coaching dashboard that lets ChatGPT generate weekly plans, stores your checkoffs and subjective feedback, accepts HealthKit-style actuals, and exports a coach summary you can paste back into ChatGPT.

## Features

- Node backend with local file storage and optional Redis/KV storage
- Today and week views for the active plan
- Day streak tracking based on actual logged workout dates
- Gear inventory for equipment-aware workout planning
- Persistent activity and subtask checkoffs
- On-the-fly workout switching from other scheduled sessions
- Quick difficulty and back-pain logging
- Goal editing, durable coach notes, and independently editable memories/preferences
- Weekly plan import from ChatGPT JSON
- HealthKit-style actual workout and recovery metric import
- Coach summary export for ChatGPT
- Stdio and hosted Streamable HTTP MCP servers for ChatGPT/client access
- OAuth 2.1-style authorization-code + PKCE flow for ChatGPT MCP auth

## Run locally

Start the backend:

```bash
npm start
```

Then open `http://127.0.0.1:4173`.

Run the tests:

```bash
npm test
```

## MCP servers

Coach Loop includes MCP servers that let a compatible client read and update the app through tools.

Use the hosted MCP endpoint for ChatGPT:

```text
https://ability-tracker-tau.vercel.app/mcp
```

Use the stdio MCP server for local clients:

```bash
COACH_LOOP_API_URL=http://127.0.0.1:4173 npm run mcp
```

Available tools:

- `get_state`
- `get_current_plan`
- `get_coach_summary`
- `get_planning_context`
- `get_planning_periods`
- `upsert_planning_periods`
- `remove_planning_period`
- `get_run_plan`
- `get_gear`
- `get_audit_log`
- `upsert_gear`
- `remove_gear`
- `import_weekly_plan`
- `update_day_plan`
- `update_goals`
- `patch_goals`
- `update_run_plan`
- `update_coach_notes`
- `get_coaching_memories`
- `upsert_coaching_memories`
- `remove_coaching_memory`
- `mark_activity`
- `save_activity_feedback`
- `save_exercise_log`
- `import_health_actuals`

### Conversational memories and preferences

The ChatGPT connector can save durable Coach Loop context without replacing the freeform coach-notes field. Natural requests such as these map to the structured memory tools:

- “Remember that I prefer run prescriptions by distance, not time.”
- “From now on, keep workout instructions concise.”
- “Update my run-prescription preference to use both distance and effort.”
- “What does Coach Loop remember about me?”
- “Forget the concise-instructions preference.”

Each memory has a stable key, kind (`preference`, `fact`, or `constraint`), category, and text. Reusing a key updates that one item while preserving unrelated memories. The Goals view provides a visible audit/edit/delete surface, and memories are included in planning context and coach summaries.

### Daily learning and timing

`save_activity_feedback` accepts `coach_memories` alongside workout feedback and saves both atomically. Capture explicit durable preferences (“I like…” / “I prefer…”); do not promote transient soreness or an observed outcome to a permanent rule. Preserve `source_quote` and `source_event_id`, reuse the existing key, and pass `expected_version` when correcting a memory. Memory history retains the previous 20 versions. Optional inclusive `effective_from` and `expires_at` dates keep temporary constraints out of later planning.

For between-set active rest, save `rule: {"sequence":"alternate_sets"}`. Strength activities must then include `blocks` referencing distinct movement subtask IDs and `preference_applications` containing the current memory key/version, or an explicit `exception_reason`. Three work sets have two between-set active-rest bouts by default. These rules are checked on weekly import and day updates; existing conflicting plans show review notices.

Planning context and summary include `coaching_brief`: active preferences, application guidance, duration observations, and personal suggestions. Always read it before drafting a daily or weekly plan. Separate `target.time_budget_minutes` from `target.estimated_duration_minutes`; legacy `duration_minutes` remains compatible. A shorter forecast does not automatically change training dose.

Accepted plans save immutable duration forecast revisions. Users can report actual minutes and confirm “Full session as prescribed,” or exclude interrupted/changed work. Matching Health records alone do not establish full completion. Personal suggestions use the median of the latest eight eligible, identically prescribed previous strength sessions, with at least three samples. Different volumes, ambiguous matches, retrospective forecasts, and partial sessions do not train the estimate. Manual durations require a forecast from an earlier calendar day; this conservative rule avoids learning from a same-day forecast entered after training. Suggestions are advisory and never rewrite an accepted forecast or prescription.

The first release intentionally has no automatic free-text classifier running in the browser: the coaching conversation interprets preferences and persists them through the typed tools. Notes entered directly in the workout UI remain notes until the coach or user explicitly saves a preference. Historical sessions without original forecast snapshots remain visible but are not calibration samples.

Preview deployments automatically use a separate Redis key derived from the Git branch or deployment URL, unless an explicit `COACH_LOOP_STORE_KEY` overrides it. Never override a preview with the production key. `scripts/seed-coaching-review.cjs` seeds synthetic examples into an explicitly selected review URL via `COACH_REVIEW_URL` (and optional `COACH_REVIEW_TOKEN`).

For a deployed Coach Loop URL, set `COACH_LOOP_API_URL` to that origin.

## Deploy

The app is Vercel-compatible through `api/[...path].js` and `api/mcp.js`.

```bash
npx vercel --prod
```

Local runs persist to `data/store.json`. Vercel serverless runs use `/tmp` unless Redis/KV environment variables are configured.

Recommended production environment variables:

```text
COACH_LOOP_API_TOKEN=<shared write token for the web app and MCP tools>
KV_REST_API_URL=<Vercel KV or Upstash Redis REST URL>
KV_REST_API_TOKEN=<Vercel KV or Upstash Redis REST token>
COACH_LOOP_STORE_KEY=coach-loop:store
```

`UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` also work in place of the `KV_` variables.

Production requires durable Redis/KV storage. The server refuses to use local file storage on Vercel unless `COACH_LOOP_ALLOW_FILE_STORAGE=true` is explicitly set for a temporary test deployment.

Optional environment variables:

```text
COACH_LOOP_API_URL=https://ability-tracker-tau.vercel.app
COACH_LOOP_MCP_TOKEN=<bearer token required to connect to /mcp>
COACH_LOOP_REQUIRE_MCP_OAUTH=true
COACH_LOOP_OAUTH_PASSWORD=<password entered on the authorization page>
COACH_LOOP_OAUTH_SIGNING_SECRET=<stable secret for OAuth codes and tokens>
```

When `COACH_LOOP_API_TOKEN` is set, both reads and writes to personal data endpoints require either the owner session cookie or a bearer token. Static assets, health checks, OAuth metadata, and OAuth registration/authorization endpoints remain public.

Use `COACH_LOOP_REQUIRE_MCP_OAUTH=true` for ChatGPT connector auth. Leave `COACH_LOOP_MCP_TOKEN` unset for ChatGPT unless you specifically need a static bearer-token bypass for another MCP client.

OAuth endpoints:

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-authorization-server
/oauth/register
/oauth/authorize
/oauth/token
```

The OAuth implementation uses stateless signed authorization codes and access tokens, so it works on Vercel serverless without a session database. Set a stable `COACH_LOOP_OAUTH_SIGNING_SECRET`; if omitted, `COACH_LOOP_API_TOKEN` is used as the signing secret.

Check deployment health:

```bash
curl https://ability-tracker-tau.vercel.app/api/healthz
```

Health Auto Export can POST raw Apple Health exports to:

```text
https://ability-tracker-tau.vercel.app/api/health/auto-export
```

Use headers:

```text
Authorization: Bearer <COACH_LOOP_API_TOKEN>
Content-Type: application/json
```

The adapter accepts Health Auto Export-style `workouts` and `metrics` payloads and normalizes workouts, steps, resting heart rate, HRV, sleep duration, and active energy into Coach Loop health actuals.

## Plan JSON shape

Weekly plans are treated as complete planning contracts:

- Include at least one weekly goal.
- Keep every movement in its own subtask. Runs, weighted-vest work, rest, and other general activity log at the activity level and may carry an empty `subtasks` array; every other activity type must break the session out into movement rows.
- Use references such as `ref-atg-back-ability` as canonical source catalogs only. References never expand into exercise rows automatically.
- Keep all activity dates inside the declared Monday-through-Sunday plan week.
- Activity IDs must be unique across the whole week, including activities preserved from dates a partial import or day update did not touch. Omit `activity_id` to have a stable one derived; supply it only to keep an existing activity's completions and logs.
- `required_or_optional` is authoritative when present. A legacy `target.optional` flag is only consulted when the field is absent.

```json
{
  "plan_id": "plan-2026-06-22",
  "week_start_date": "2026-06-22",
  "goals": ["Run 3 days per week", "Improve back health"],
  "activities": [
    {
      "activity_id": "easy-run-2026-06-23",
      "date": "2026-06-23",
      "title": "Easy Run + Back Reset",
      "type": "run",
      "equipment": ["treadmill or outdoor route"],
      "references": ["ref-atg-back-ability"],
      "required_or_optional": "required",
      "target": {
        "distance_miles": 3,
        "intensity": "easy",
        "notes": "Conversational pace."
      },
      "subtasks": [
        "Warm up 5 minutes",
        { "title": "Bodyweight squat — 3x10", "log_mode": "strength" },
        { "title": "Couch stretch — 45 sec each side", "log_mode": "timed" },
        { "title": "Log difficulty and back pain", "log_mode": "check" }
      ]
    }
  ]
}
```

Subtasks may be plain strings or objects. The optional `log_mode` (also accepted as `tracking`) controls which logging fields the app shows for that exercise and overrides the title-based heuristic:

- `strength` — total lb / sets / reps
- `timed` — time (min/sec) + rounds
- `loaded-timed` — time + total lb + rounds
- `check` — checkbox only, no logging fields

Without `log_mode`, the app infers the mode from the title: an explicit `3x10`-style prescription means strength; stretch/hold/walk/warmup wording means timed; sled/carry wording means loaded-timed.

Exercise tracking is not medical advice. Stop if a movement causes pain and use professional guidance for injuries.

## Vacation and deload planning

Vacation and purposeful deload windows are stored separately from goals so they are not lost when goals change. Each inclusive period records why the constraint exists and the intended training load:

```json
{
  "period_id": "period-2026-08-vacation",
  "title": "August vacation",
  "start_date": "2026-08-17",
  "end_date": "2026-08-28",
  "reason": "vacation",
  "training_load": "full_deload",
  "notes": "Optional walking and easy mobility only; resume progressively."
}
```

`reason` is `vacation`, `planned_deload`, or `other`. `training_load` is `full_deload`, `reduced`, or `normal`. Planning context includes these periods and explicit guidance. Required activities dated inside a full deload are excused from adherence and miss streaks; the run-plan view reduces overlapping weeks and adds a gradual two-week return.
