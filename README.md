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
- Goal editing and durable coach notes
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
- `mark_activity`
- `save_activity_feedback`
- `save_exercise_log`
- `import_health_actuals`

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
