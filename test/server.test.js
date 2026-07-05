const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDefaultPlan,
  createCoachSummary,
  createDefaultState,
  createStreak,
  handleRequest,
  validatePlan
} = require("../server");

function request(handler, { method = "GET", path = "/", body = null, headers = {}, preParsedBody = false } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    const req = new (require("node:stream").Readable)({
      read() {
        if (body === null || preParsedBody) this.push(null);
        else {
          this.push(typeof body === "string" ? body : JSON.stringify(body));
          this.push(null);
        }
      }
    });
    req.method = method;
    req.url = path;
    if (preParsedBody) req.body = body || {};
    const resolvedHeaders = {
      host: "127.0.0.1",
      "content-type": "application/json",
      ...headers
    };
    if (process.env.COACH_LOOP_API_TOKEN && resolvedHeaders.authorization === undefined && resolvedHeaders.cookie === undefined) {
      resolvedHeaders.authorization = `Bearer ${process.env.COACH_LOOP_API_TOKEN}`;
    }
    req.headers = resolvedHeaders;
    const res = {
      statusCode: 200,
      headers: {},
      writeHead(statusCode, responseHeaders) {
        this.statusCode = statusCode;
        this.headers = responseHeaders || {};
      },
      end(chunk) {
        if (chunk) chunks.push(Buffer.from(chunk));
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          statusCode: this.statusCode,
          headers: this.headers,
          body: text ? JSON.parse(text) : null
        });
      }
    };
    handler(req, res);
  });
}

test("buildDefaultPlan creates a weekly coach plan with stable activity shape", () => {
  const plan = buildDefaultPlan(new Date("2026-06-19T12:00:00"));
  const easyRun = plan.activities.find((activity) => activity.title === "Easy Run");
  const backHealth = plan.activities.find((activity) => activity.title.includes("Back Health"));

  assert.equal(plan.week_start_date, "2026-06-15");
  assert.equal(plan.activities.length, 7);
  assert.equal(plan.activities.filter((activity) => activity.type === "run").length, 3);
  assert.ok(plan.activities.every((activity) => activity.activity_id));
  assert.ok(plan.activities.every((activity) => Array.isArray(activity.subtasks)));
  assert.equal(easyRun.target.distance_miles, 3);
  assert.equal(easyRun.subtasks.length, 0);
  assert.deepEqual(backHealth.references, ["ref-atg-back-ability"]);
});

test("validatePlan accepts ChatGPT-style plan JSON and normalizes subtasks", () => {
  const plan = validatePlan({
    week_start_date: "2026-06-22",
    goals: ["Run three days"],
    activities: [
      {
        date: "2026-06-22",
        title: "Easy Run",
        type: "run",
        equipment: ["treadmill"],
        subtasks: ["Warm up", "Run easy"]
      }
    ]
  });

  assert.equal(plan.plan_id, "plan-2026-06-22");
  assert.equal(plan.activities[0].required_or_optional, "required");
  assert.deepEqual(plan.activities[0].equipment, ["treadmill"]);
  assert.equal(plan.activities[0].subtasks[0].title, "Warm up");
});

test("createDefaultState seeds inferred gear inventory", () => {
  const store = createDefaultState(new Date("2026-06-19T12:00:00"));
  const names = store.gear.map((item) => item.name);

  assert.ok(names.includes("Weighted vest"));
  assert.ok(names.includes("Treadmill"));
  assert.ok(store.gear.find((item) => item.gear_id === "gear-weighted-vest").notes.includes("Hiking"));
});

test("private read endpoints require owner auth when an API token is configured", async () => {
  const previousDataDir = process.env.COACH_LOOP_DATA_DIR;
  const previousApiToken = process.env.COACH_LOOP_API_TOKEN;
  process.env.COACH_LOOP_DATA_DIR = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/coach-loop-read-auth-test-`);
  process.env.COACH_LOOP_API_TOKEN = "test-token";

  try {
    const denied = await request(handleRequest, {
      path: "/api/state",
      headers: { authorization: "" }
    });
    assert.equal(denied.statusCode, 401);

    const allowed = await request(handleRequest, {
      path: "/api/state",
      headers: { authorization: "Bearer test-token" }
    });
    assert.equal(allowed.statusCode, 200);
    assert.ok(allowed.body.health);
  } finally {
    if (previousDataDir === undefined) delete process.env.COACH_LOOP_DATA_DIR;
    else process.env.COACH_LOOP_DATA_DIR = previousDataDir;
    if (previousApiToken === undefined) delete process.env.COACH_LOOP_API_TOKEN;
    else process.env.COACH_LOOP_API_TOKEN = previousApiToken;
  }
});

test("validatePlan rejects plans without activities", () => {
  assert.throws(
    () => validatePlan({ week_start_date: "2026-06-22", activities: [] }),
    /at least one activity/
  );
});

test("day plan update replaces only one date in the active week", async () => {
  const previousDataDir = process.env.COACH_LOOP_DATA_DIR;
  const previousApiToken = process.env.COACH_LOOP_API_TOKEN;
  process.env.COACH_LOOP_DATA_DIR = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/coach-loop-day-test-`);
  process.env.COACH_LOOP_API_TOKEN = "test-token";

  try {
    const before = await request(handleRequest, { path: "/api/state" });
    const originalActivities = before.body.active_plan.activities;
    const date = originalActivities[0].date;
    const untouchedDate = originalActivities.find((activity) => activity.date !== date).date;
    const untouchedBefore = originalActivities.filter((activity) => activity.date === untouchedDate).map((activity) => activity.activity_id);

    const response = await request(handleRequest, {
      method: "PUT",
      path: `/api/plans/current/days/${date}`,
      headers: { authorization: "Bearer test-token" },
      body: {
        activities: [
          {
            title: "Adjusted Upper Body",
            type: "strength",
            required_or_optional: "required",
            equipment: ["dumbbells"],
            subtasks: ["Incline curl", "Cable pressdown"]
          }
        ]
      }
    });

    assert.equal(response.statusCode, 200);
    const updatedActivities = response.body.active_plan.activities;
    assert.deepEqual(updatedActivities.filter((activity) => activity.date === date).map((activity) => activity.title), ["Adjusted Upper Body"]);
    assert.deepEqual(updatedActivities.filter((activity) => activity.date === untouchedDate).map((activity) => activity.activity_id), untouchedBefore);
  } finally {
    if (previousDataDir === undefined) delete process.env.COACH_LOOP_DATA_DIR;
    else process.env.COACH_LOOP_DATA_DIR = previousDataDir;
    if (previousApiToken === undefined) delete process.env.COACH_LOOP_API_TOKEN;
    else process.env.COACH_LOOP_API_TOKEN = previousApiToken;
  }
});

test("weekly plan import preserves untouched existing dates in the same week", async () => {
  const previousDataDir = process.env.COACH_LOOP_DATA_DIR;
  const previousApiToken = process.env.COACH_LOOP_API_TOKEN;
  process.env.COACH_LOOP_DATA_DIR = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/coach-loop-plan-merge-test-`);
  process.env.COACH_LOOP_API_TOKEN = "test-token";

  try {
    const before = await request(handleRequest, { path: "/api/state" });
    const originalActivities = before.body.active_plan.activities;
    const replaceDate = originalActivities[0].date;
    const untouchedDate = originalActivities.find((activity) => activity.date !== replaceDate).date;
    const untouchedBefore = originalActivities.filter((activity) => activity.date === untouchedDate).map((activity) => activity.activity_id);

    const response = await request(handleRequest, {
      method: "POST",
      path: "/api/plans/import",
      headers: { authorization: "Bearer test-token" },
      body: {
        week_start_date: before.body.active_plan.week_start_date,
        activities: [
          {
            date: replaceDate,
            title: "Merged Replacement",
            type: "lift"
          }
        ]
      }
    });

    assert.equal(response.statusCode, 201);
    const updatedActivities = response.body.active_plan.activities;
    assert.deepEqual(updatedActivities.filter((activity) => activity.date === replaceDate).map((activity) => activity.title), ["Merged Replacement"]);
    assert.deepEqual(updatedActivities.filter((activity) => activity.date === untouchedDate).map((activity) => activity.activity_id), untouchedBefore);
  } finally {
    if (previousDataDir === undefined) delete process.env.COACH_LOOP_DATA_DIR;
    else process.env.COACH_LOOP_DATA_DIR = previousDataDir;
    if (previousApiToken === undefined) delete process.env.COACH_LOOP_API_TOKEN;
    else process.env.COACH_LOOP_API_TOKEN = previousApiToken;
  }
});

test("health auto export payload imports workouts and metrics", async () => {
  const previousDataDir = process.env.COACH_LOOP_DATA_DIR;
  const previousApiToken = process.env.COACH_LOOP_API_TOKEN;
  process.env.COACH_LOOP_DATA_DIR = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/coach-loop-health-test-`);
  process.env.COACH_LOOP_API_TOKEN = "test-token";

  try {
    const response = await request(handleRequest, {
      method: "POST",
      path: "/api/health/auto-export",
      headers: { authorization: "Bearer test-token" },
      body: {
        workouts: [
          {
            id: "workout-1",
            name: "Outdoor Run",
            startDate: "2026-06-30T10:00:00-04:00",
            duration: { qty: 1800, units: "sec" },
            distance: { qty: 5, units: "km" },
            averageHeartRate: { qty: 145, units: "count/min" },
            activeEnergyBurned: { qty: 320, units: "kcal" },
            totalEnergy: { qty: 380, units: "kcal" },
            elevationUp: { qty: 84, units: "ft" },
            temperature: { qty: 72, units: "degF" },
            humidity: { qty: 64, units: "%" },
            stepCadence: { qty: 162, units: "steps/min" },
            avgSpeed: { qty: 5, units: "mi" },
            maxSpeed: { qty: 7.2, units: "mph" },
            heartRateData: [
              { Avg: 130, date: "2026-06-30 10:00:00 -0400" },
              { Avg: 140, date: "2026-06-30 10:10:00 -0400" },
              { Avg: 150, date: "2026-06-30 10:20:00 -0400" },
              { Avg: 160, date: "2026-06-30 10:30:00 -0400" }
            ],
            heartRateRecovery: [
              { Avg: 158, date: "2026-06-30 10:30:00 -0400" },
              { Avg: 138, date: "2026-06-30 10:31:00 -0400" }
            ],
            walkingAndRunningDistance: [
              { qty: 0.11, units: "mi", date: "2026-06-30 10:00:00 -0400" },
              { qty: 0.1, units: "mi", date: "2026-06-30 10:10:00 -0400" },
              { qty: 0.09, units: "mi", date: "2026-06-30 10:20:00 -0400" },
              { qty: 0.08, units: "mi", date: "2026-06-30 10:30:00 -0400" }
            ],
            stepCount: [
              { qty: 1000, date: "2026-06-30 10:00:00 -0400" },
              { qty: 900, date: "2026-06-30 10:15:00 -0400" }
            ],
            basalEnergy: [
              { qty: 30, units: "kcal", date: "2026-06-30 10:00:00 -0400" },
              { qty: 31, units: "kcal", date: "2026-06-30 10:15:00 -0400" }
            ]
          }
        ],
        metrics: [
          {
            name: "step_count",
            data: [{ date: "2026-06-30 10:00:00 -0400", qty: 9300 }]
          },
          {
            name: "resting_heart_rate",
            data: [{ date: "2026-06-30 07:00:00 -0400", qty: 58 }]
          },
          {
            name: "heart_rate_variability_sdnn",
            data: [{ date: "2026-06-30 07:05:00 -0400", qty: 62 }]
          }
        ]
      }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.health.actual_workouts[0].type, "run");
    assert.equal(response.body.health.actual_workouts[0].duration_minutes, 30);
    assert.equal(Math.round(response.body.health.actual_workouts[0].distance_miles * 100) / 100, 3.11);
    assert.equal(response.body.health.actual_workouts[0].active_energy_kcal, 320);
    assert.equal(response.body.health.actual_workouts[0].basal_energy_kcal, 61);
    assert.equal(response.body.health.actual_workouts[0].total_energy_kcal, 380);
    assert.equal(response.body.health.actual_workouts[0].elevation_gain.qty, 84);
    assert.equal(response.body.health.actual_workouts[0].temperature.qty, 72);
    assert.equal(response.body.health.actual_workouts[0].humidity.qty, 64);
    assert.equal(response.body.health.actual_workouts[0].step_cadence.qty, 162);
    assert.equal(response.body.health.actual_workouts[0].avg_speed.units, "mph");
    assert.equal(response.body.health.actual_workouts[0].total_steps, 1900);
    assert.equal(response.body.health.actual_workouts[0].heart_rate_series.length, 4);
    assert.equal(response.body.health.actual_workouts[0].heart_rate_series[0].offset_seconds, 0);
    assert.equal(response.body.health.actual_workouts[0].heart_rate_series[3].avg_bpm, 160);
    assert.equal(response.body.health.actual_workouts[0].heart_rate_recovery.drop_bpm, 20);
    assert.equal(response.body.health.actual_workouts[0].heart_rate_drift.drift_bpm, 20);
    assert.equal(response.body.health.actual_workouts[0].pace_drift.slowdown_percent, 19);
    assert.equal(response.body.health.daily_metrics[0].steps, 9300);
    assert.equal(response.body.health.daily_metrics[0].resting_heart_rate, 58);
    assert.equal(response.body.health.daily_metrics[0].hrv_ms, 62);
    assert.equal(response.body.health.imports[0].source, "health_auto_export");
    assert.equal(response.body.health.imports[0].normalized_actual_workouts, 1);
    assert.equal(response.body.health.imports[0].normalized_daily_metrics, 1);

    const status = await request(handleRequest, { path: "/api/health/import-status" });
    assert.equal(status.body.actual_workouts_count, 1);
    assert.equal(status.body.latest_imports[0].payload.shapes.workouts.type, "array");
  } finally {
    if (previousDataDir === undefined) delete process.env.COACH_LOOP_DATA_DIR;
    else process.env.COACH_LOOP_DATA_DIR = previousDataDir;
    if (previousApiToken === undefined) delete process.env.COACH_LOOP_API_TOKEN;
    else process.env.COACH_LOOP_API_TOKEN = previousApiToken;
  }
});

test("health auto export imports nested data.workouts payloads", async () => {
  const previousDataDir = process.env.COACH_LOOP_DATA_DIR;
  const previousApiToken = process.env.COACH_LOOP_API_TOKEN;
  process.env.COACH_LOOP_DATA_DIR = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/coach-loop-health-nested-test-`);
  process.env.COACH_LOOP_API_TOKEN = "test-token";

  try {
    const response = await request(handleRequest, {
      method: "POST",
      path: "/api/health/auto-export",
      headers: { authorization: "Bearer test-token" },
      body: {
        data: {
          workouts: [
            {
              id: "nested-workout-1",
              name: "Outdoor Run",
              startDate: "2026-06-30T10:00:00-04:00",
              duration: { qty: 1200, units: "sec" },
              distance: { qty: 2, units: "mi" }
            },
            {
              id: "nested-workout-2",
              name: "Other",
              startDate: "2026-06-30T12:00:00-04:00",
              duration: 1800
            }
          ]
        }
      }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.health.actual_workouts.length, 2);
    assert.equal(response.body.health.actual_workouts[0].actual_id, "nested-workout-1");
    assert.equal(response.body.health.actual_workouts[0].duration_minutes, 20);
    assert.equal(response.body.health.actual_workouts[1].duration_minutes, 30);
    assert.equal(response.body.health.imports[0].normalized_actual_workouts, 2);

    const deleted = await request(handleRequest, {
      method: "DELETE",
      path: "/api/health/actuals/nested-workout-1",
      headers: { authorization: "Bearer test-token" }
    });
    assert.equal(deleted.statusCode, 200);
    assert.equal(deleted.body.health.actual_workouts.length, 1);
    assert.equal(deleted.body.health.actual_workouts[0].actual_id, "nested-workout-2");
  } finally {
    if (previousDataDir === undefined) delete process.env.COACH_LOOP_DATA_DIR;
    else process.env.COACH_LOOP_DATA_DIR = previousDataDir;
    if (previousApiToken === undefined) delete process.env.COACH_LOOP_API_TOKEN;
    else process.env.COACH_LOOP_API_TOKEN = previousApiToken;
  }
});

test("health imports accept Vercel pre-parsed request bodies", async () => {
  const previousDataDir = process.env.COACH_LOOP_DATA_DIR;
  const previousApiToken = process.env.COACH_LOOP_API_TOKEN;
  process.env.COACH_LOOP_DATA_DIR = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/coach-loop-preparsed-body-test-`);
  process.env.COACH_LOOP_API_TOKEN = "test-token";

  try {
    const response = await request(handleRequest, {
      method: "POST",
      path: "/api/health/auto-export",
      headers: { authorization: "Bearer test-token" },
      preParsedBody: true,
      body: {
        workouts: [
          {
            id: "preparsed-workout-1",
            name: "Outdoor Run",
            startDate: "2026-06-30T10:00:00-04:00",
            duration: { qty: 600, units: "sec" },
            distance: { qty: 1, units: "mi" }
          }
        ]
      }
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.body.health.actual_workouts[0].actual_id, "preparsed-workout-1");
    assert.equal(response.body.health.actual_workouts[0].duration_minutes, 10);
  } finally {
    if (previousDataDir === undefined) delete process.env.COACH_LOOP_DATA_DIR;
    else process.env.COACH_LOOP_DATA_DIR = previousDataDir;
    if (previousApiToken === undefined) delete process.env.COACH_LOOP_API_TOKEN;
    else process.env.COACH_LOOP_API_TOKEN = previousApiToken;
  }
});

test("health imports sanitize supplied route previews and short numeric durations", async () => {
  const previousDataDir = process.env.COACH_LOOP_DATA_DIR;
  const previousApiToken = process.env.COACH_LOOP_API_TOKEN;
  process.env.COACH_LOOP_DATA_DIR = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/coach-loop-route-sanitize-test-`);
  process.env.COACH_LOOP_API_TOKEN = "test-token";

  try {
    const response = await request(handleRequest, {
      method: "POST",
      path: "/api/health/import",
      headers: { authorization: "Bearer test-token" },
      body: {
        actual_workouts: [
          {
            id: "route-xss-1",
            name: "Outdoor Run",
            startDate: "2026-06-30T10:00:00-04:00",
            duration: 540,
            route_shape: {
              source_points: "<img src=x onerror=alert(1)>",
              points: [{ x: 0, y: 0 }, { x: 1, y: 1 }]
            },
            route_map: {
              source_points: "<script>alert(1)</script>",
              points: [{ lat: 42.1, lon: -71.1 }, { lat: 42.2, lon: -71.2 }]
            }
          }
        ]
      }
    });

    assert.equal(response.statusCode, 200);
    const actual = response.body.health.actual_workouts[0];
    assert.equal(actual.duration_minutes, 9);
    assert.equal(actual.route_shape.source_points, 2);
    assert.equal(actual.route_map.source_points, 2);
    assert.deepEqual(Object.keys(actual.route_shape.points[0]).sort(), ["x", "y"]);
    assert.deepEqual(Object.keys(actual.route_map.points[0]).sort(), ["lat", "lon"]);
  } finally {
    if (previousDataDir === undefined) delete process.env.COACH_LOOP_DATA_DIR;
    else process.env.COACH_LOOP_DATA_DIR = previousDataDir;
    if (previousApiToken === undefined) delete process.env.COACH_LOOP_API_TOKEN;
    else process.env.COACH_LOOP_API_TOKEN = previousApiToken;
  }
});

test("activity actual links can attach same-day unmatched workouts", async () => {
  const previousDataDir = process.env.COACH_LOOP_DATA_DIR;
  const previousApiToken = process.env.COACH_LOOP_API_TOKEN;
  process.env.COACH_LOOP_DATA_DIR = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/coach-loop-actual-link-test-`);
  process.env.COACH_LOOP_API_TOKEN = "test-token";

  try {
    const state = await request(handleRequest, { path: "/api/state" });
    const activity = state.body.active_plan.activities[0];

    await request(handleRequest, {
      method: "POST",
      path: "/api/health/auto-export",
      headers: { authorization: "Bearer test-token" },
      body: {
        data: {
          workouts: [
            {
              id: "actual-other-1",
              name: "Other",
              start: `${activity.date} 07:00:00 -0400`,
              end: `${activity.date} 07:30:00 -0400`,
              duration: 1800
            }
          ]
        }
      }
    });

    const linked = await request(handleRequest, {
      method: "POST",
      path: `/api/activities/${encodeURIComponent(activity.activity_id)}/actual-link`,
      headers: { authorization: "Bearer test-token" },
      body: { actual_id: "actual-other-1" }
    });

    const updatedActivity = linked.body.active_plan.activities.find((item) => item.activity_id === activity.activity_id);
    assert.equal(updatedActivity.actuals.length, 1);
    assert.equal(updatedActivity.actuals[0].actual_id, "actual-other-1");
    assert.equal(updatedActivity.actual_match_candidates[0].linked, true);
    assert.equal(updatedActivity.completion.completed, true);
    assert.equal(linked.body.streak.completed_dates.includes(activity.date), true);
  } finally {
    if (previousDataDir === undefined) delete process.env.COACH_LOOP_DATA_DIR;
    else process.env.COACH_LOOP_DATA_DIR = previousDataDir;
    if (previousApiToken === undefined) delete process.env.COACH_LOOP_API_TOKEN;
    else process.env.COACH_LOOP_API_TOKEN = previousApiToken;
  }
});

test("same-day functional strength actual automatically matches a lift workout", async () => {
  const previousDataDir = process.env.COACH_LOOP_DATA_DIR;
  const previousApiToken = process.env.COACH_LOOP_API_TOKEN;
  process.env.COACH_LOOP_DATA_DIR = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/coach-loop-strength-match-test-`);
  process.env.COACH_LOOP_API_TOKEN = "test-token";

  try {
    const before = await request(handleRequest, { path: "/api/state" });
    const activity = before.body.active_plan.activities.find((item) => item.type === "lift");

    const imported = await request(handleRequest, {
      method: "POST",
      path: "/api/health/auto-export",
      headers: { authorization: "Bearer test-token" },
      body: {
        workouts: [
          {
            id: "strength-actual-1",
            name: "Functional Strength Training",
            type: "strength",
            startDate: `${activity.date}T06:45:00-04:00`,
            duration: { qty: 1800, units: "sec" },
            averageHeartRate: { qty: 99, units: "count/min" }
          }
        ]
      }
    });
    assert.equal(imported.statusCode, 200);

    const updatedActivity = imported.body.active_plan.activities.find((item) => item.activity_id === activity.activity_id);
    assert.equal(updatedActivity.actuals.length, 1);
    assert.equal(updatedActivity.actuals[0].name, "Functional Strength Training");
    assert.equal(updatedActivity.actual_match_candidates[0].natural_match, true);
    assert.equal(updatedActivity.completion.completed, true);
  } finally {
    if (previousDataDir === undefined) delete process.env.COACH_LOOP_DATA_DIR;
    else process.env.COACH_LOOP_DATA_DIR = previousDataDir;
    if (previousApiToken === undefined) delete process.env.COACH_LOOP_API_TOKEN;
    else process.env.COACH_LOOP_API_TOKEN = previousApiToken;
  }
});

test("ambiguous same-day actual defaults to the first compatible workout and flags it", async () => {
  const previousDataDir = process.env.COACH_LOOP_DATA_DIR;
  const previousApiToken = process.env.COACH_LOOP_API_TOKEN;
  process.env.COACH_LOOP_DATA_DIR = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/coach-loop-ambiguous-match-test-`);
  process.env.COACH_LOOP_API_TOKEN = "test-token";

  try {
    const before = await request(handleRequest, { path: "/api/state" });
    const date = before.body.active_plan.activities[0].date;
    const updatedDay = await request(handleRequest, {
      method: "PUT",
      path: `/api/plans/current/days/${date}`,
      headers: { authorization: "Bearer test-token" },
      body: {
        activities: [
          {
            title: "Lower Body Maintenance",
            type: "lift",
            required_or_optional: "required",
            target: { duration_minutes: 30 }
          },
          {
            title: "Upper Body Strength",
            type: "lift",
            required_or_optional: "optional",
            target: { duration_minutes: 25 }
          }
        ]
      }
    });
    const firstActivity = updatedDay.body.active_plan.activities.find((item) => item.title === "Lower Body Maintenance");
    const secondActivity = updatedDay.body.active_plan.activities.find((item) => item.title === "Upper Body Strength");

    const imported = await request(handleRequest, {
      method: "POST",
      path: "/api/health/auto-export",
      headers: { authorization: "Bearer test-token" },
      body: {
        workouts: [
          {
            id: "ambiguous-strength-actual-1",
            name: "Functional Strength Training",
            type: "strength",
            startDate: `${date}T06:45:00-04:00`,
            duration: { qty: 1800, units: "sec" }
          }
        ]
      }
    });

    const updatedFirst = imported.body.active_plan.activities.find((item) => item.activity_id === firstActivity.activity_id);
    const updatedSecond = imported.body.active_plan.activities.find((item) => item.activity_id === secondActivity.activity_id);
    assert.equal(updatedFirst.actuals.length, 1);
    assert.equal(updatedFirst.actuals[0].actual_id, "ambiguous-strength-actual-1");
    assert.equal(updatedFirst.actuals[0].natural_match_multiple, true);
    assert.equal(updatedFirst.actuals[0].natural_match_compatible_count, 2);
    assert.equal(updatedFirst.actual_match_candidates[0].natural_match_multiple, true);
    assert.equal(updatedSecond.actuals.length, 0);
    assert.equal(updatedSecond.actual_match_candidates[0].natural_match, false);
  } finally {
    if (previousDataDir === undefined) delete process.env.COACH_LOOP_DATA_DIR;
    else process.env.COACH_LOOP_DATA_DIR = previousDataDir;
    if (previousApiToken === undefined) delete process.env.COACH_LOOP_API_TOKEN;
    else process.env.COACH_LOOP_API_TOKEN = previousApiToken;
  }
});

test("same-day Other actual automatically matches an other yard-work workout", async () => {
  const previousDataDir = process.env.COACH_LOOP_DATA_DIR;
  const previousApiToken = process.env.COACH_LOOP_API_TOKEN;
  process.env.COACH_LOOP_DATA_DIR = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/coach-loop-other-match-test-`);
  process.env.COACH_LOOP_API_TOKEN = "test-token";

  try {
    const before = await request(handleRequest, { path: "/api/state" });
    const date = before.body.active_plan.activities[0].date;
    const updatedDay = await request(handleRequest, {
      method: "PUT",
      path: `/api/plans/current/days/${date}`,
      headers: { authorization: "Bearer test-token" },
      body: {
        activities: [
          {
            title: "Outside Work / Yard Work",
            type: "other",
            required_or_optional: "required",
            target: { duration_minutes: 40 }
          }
        ]
      }
    });
    const activity = updatedDay.body.active_plan.activities.find((item) => item.date === date);

    const imported = await request(handleRequest, {
      method: "POST",
      path: "/api/health/auto-export",
      headers: { authorization: "Bearer test-token" },
      body: {
        workouts: [
          {
            id: "other-actual-1",
            name: "Other",
            type: "other",
            startDate: `${date}T07:15:00-04:00`,
            duration: { qty: 2400, units: "sec" }
          }
        ]
      }
    });

    const updatedActivity = imported.body.active_plan.activities.find((item) => item.activity_id === activity.activity_id);
    assert.equal(updatedActivity.actuals.length, 1);
    assert.equal(updatedActivity.actuals[0].actual_id, "other-actual-1");
    assert.equal(updatedActivity.actual_match_candidates[0].natural_match, true);
  } finally {
    if (previousDataDir === undefined) delete process.env.COACH_LOOP_DATA_DIR;
    else process.env.COACH_LOOP_DATA_DIR = previousDataDir;
    if (previousApiToken === undefined) delete process.env.COACH_LOOP_API_TOKEN;
    else process.env.COACH_LOOP_API_TOKEN = previousApiToken;
  }
});

test("same-day Hiking actual automatically matches a weighted vest workout", async () => {
  const previousDataDir = process.env.COACH_LOOP_DATA_DIR;
  const previousApiToken = process.env.COACH_LOOP_API_TOKEN;
  process.env.COACH_LOOP_DATA_DIR = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/coach-loop-ruck-match-test-`);
  process.env.COACH_LOOP_API_TOKEN = "test-token";

  try {
    const before = await request(handleRequest, { path: "/api/state" });
    const date = before.body.active_plan.activities[0].date;
    const updatedDay = await request(handleRequest, {
      method: "PUT",
      path: `/api/plans/current/days/${date}`,
      headers: { authorization: "Bearer test-token" },
      body: {
        activities: [
          {
            title: "Weighted Vest Ruck",
            type: "weighted_vest",
            required_or_optional: "required",
            equipment: ["weighted vest"],
            target: { duration_minutes: 35 }
          }
        ]
      }
    });
    const activity = updatedDay.body.active_plan.activities.find((item) => item.date === date);

    const imported = await request(handleRequest, {
      method: "POST",
      path: "/api/health/auto-export",
      headers: { authorization: "Bearer test-token" },
      body: {
        workouts: [
          {
            id: "hiking-actual-1",
            name: "Hiking",
            type: "hiking",
            startDate: `${date}T06:30:00-04:00`,
            duration: { qty: 2100, units: "sec" }
          }
        ]
      }
    });

    const updatedActivity = imported.body.active_plan.activities.find((item) => item.activity_id === activity.activity_id);
    assert.equal(updatedActivity.actuals.length, 1);
    assert.equal(updatedActivity.actuals[0].actual_id, "hiking-actual-1");
    assert.equal(updatedActivity.actual_match_candidates[0].natural_match, true);
  } finally {
    if (previousDataDir === undefined) delete process.env.COACH_LOOP_DATA_DIR;
    else process.env.COACH_LOOP_DATA_DIR = previousDataDir;
    if (previousApiToken === undefined) delete process.env.COACH_LOOP_API_TOKEN;
    else process.env.COACH_LOOP_API_TOKEN = previousApiToken;
  }
});

test("applying an incompatible Hiking actual creates a weighted vest activity and can clear a wrong completion", async () => {
  const previousDataDir = process.env.COACH_LOOP_DATA_DIR;
  const previousApiToken = process.env.COACH_LOOP_API_TOKEN;
  process.env.COACH_LOOP_DATA_DIR = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/coach-loop-apply-actual-test-`);
  process.env.COACH_LOOP_API_TOKEN = "test-token";

  try {
    const before = await request(handleRequest, { path: "/api/state" });
    const date = before.body.active_plan.activities[0].date;
    const updatedDay = await request(handleRequest, {
      method: "PUT",
      path: `/api/plans/current/days/${date}`,
      headers: { authorization: "Bearer test-token" },
      body: {
        activities: [
          {
            title: "Upper Body + Arms",
            type: "lift",
            required_or_optional: "required",
            target: { duration_minutes: 50 }
          }
        ]
      }
    });
    const lift = updatedDay.body.active_plan.activities.find((item) => item.title === "Upper Body + Arms");

    await request(handleRequest, {
      method: "PATCH",
      path: `/api/activities/${encodeURIComponent(lift.activity_id)}`,
      headers: { authorization: "Bearer test-token" },
      body: { completed: true, logged_date: date }
    });

    await request(handleRequest, {
      method: "POST",
      path: "/api/health/auto-export",
      headers: { authorization: "Bearer test-token" },
      body: {
        workouts: [
          {
            id: "vest-walk-actual-1",
            name: "Hiking",
            type: "hiking",
            startDate: `${date}T08:00:00-04:00`,
            duration: { qty: 1830, units: "sec" },
            distance: { qty: 1.43, units: "mi" },
            averageHeartRate: { qty: 106, units: "count/min" }
          }
        ]
      }
    });

    const applied = await request(handleRequest, {
      method: "POST",
      path: "/api/health/actuals/vest-walk-actual-1/apply",
      headers: { authorization: "Bearer test-token" },
      body: {
        title: "Weighted Vest Dog Walk",
        clear_activity_id: lift.activity_id
      }
    });

    assert.equal(applied.statusCode, 200);
    const updatedLift = applied.body.active_plan.activities.find((item) => item.activity_id === lift.activity_id);
    const ruck = applied.body.active_plan.activities.find((item) => item.title === "Weighted Vest Dog Walk");
    assert.equal(updatedLift.completion.completed, false);
    assert.ok(ruck);
    assert.equal(ruck.type, "weighted_vest");
    assert.equal(ruck.actuals.length, 1);
    assert.equal(ruck.actuals[0].actual_id, "vest-walk-actual-1");
    assert.equal(applied.body.actual_links["vest-walk-actual-1"], ruck.activity_id);
  } finally {
    if (previousDataDir === undefined) delete process.env.COACH_LOOP_DATA_DIR;
    else process.env.COACH_LOOP_DATA_DIR = previousDataDir;
    if (previousApiToken === undefined) delete process.env.COACH_LOOP_API_TOKEN;
    else process.env.COACH_LOOP_API_TOKEN = previousApiToken;
  }
});

test("owner session cookie authorizes dashboard writes without a bearer API token", async () => {
  const previousDataDir = process.env.COACH_LOOP_DATA_DIR;
  const previousApiToken = process.env.COACH_LOOP_API_TOKEN;
  const previousOwnerPassword = process.env.COACH_LOOP_OAUTH_PASSWORD;
  process.env.COACH_LOOP_DATA_DIR = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/coach-loop-session-test-`);
  process.env.COACH_LOOP_API_TOKEN = "test-token";
  process.env.COACH_LOOP_OAUTH_PASSWORD = "owner-password";

  try {
    const state = await request(handleRequest, { path: "/api/state" });
    const activity = state.body.active_plan.activities[0];

    const locked = await request(handleRequest, {
      method: "PATCH",
      path: `/api/activities/${encodeURIComponent(activity.activity_id)}`,
      headers: { authorization: "" },
      body: { completed: true }
    });
    assert.equal(locked.statusCode, 401);

    const failedLogin = await request(handleRequest, {
      method: "POST",
      path: "/api/session/login",
      body: { password: "wrong-password" }
    });
    assert.equal(failedLogin.statusCode, 401);

    const login = await request(handleRequest, {
      method: "POST",
      path: "/api/session/login",
      body: { password: "owner-password" }
    });
    assert.equal(login.statusCode, 200);
    assert.equal(login.body.authenticated, true);
    assert.match(login.headers["set-cookie"], /coach_loop_session=/);
    assert.match(login.headers["set-cookie"], /Max-Age=31536000/);
    assert.doesNotMatch(login.headers["set-cookie"], /test-token/);

    const cookie = login.headers["set-cookie"].split(";")[0];
    const session = await request(handleRequest, {
      path: "/api/session",
      headers: { cookie }
    });
    assert.equal(session.body.authenticated, true);
    assert.equal(session.body.method, "owner_session");

    const updated = await request(handleRequest, {
      method: "PATCH",
      path: `/api/activities/${encodeURIComponent(activity.activity_id)}`,
      headers: { cookie },
      body: { completed: true }
    });
    assert.equal(updated.statusCode, 200);
    const updatedActivity = updated.body.active_plan.activities.find((item) => item.activity_id === activity.activity_id);
    assert.equal(updatedActivity.completion.completed, true);
    assert.ok(updated.body.revision > state.body.revision);
    assert.equal(updated.body.audit_events.at(-1).action, "activity.mark");

    const backups = await request(handleRequest, {
      path: "/api/backups",
      headers: { cookie }
    });
    assert.equal(backups.statusCode, 200);
    assert.ok(backups.body.backups.length >= 1);
    assert.equal(backups.body.backups[0].reason, "auto-write");

    const manualBackup = await request(handleRequest, {
      method: "POST",
      path: "/api/backups",
      headers: { cookie }
    });
    assert.equal(manualBackup.statusCode, 201);
    assert.equal(manualBackup.body.backup.reason, "manual");
  } finally {
    if (previousDataDir === undefined) delete process.env.COACH_LOOP_DATA_DIR;
    else process.env.COACH_LOOP_DATA_DIR = previousDataDir;
    if (previousApiToken === undefined) delete process.env.COACH_LOOP_API_TOKEN;
    else process.env.COACH_LOOP_API_TOKEN = previousApiToken;
    if (previousOwnerPassword === undefined) delete process.env.COACH_LOOP_OAUTH_PASSWORD;
    else process.env.COACH_LOOP_OAUTH_PASSWORD = previousOwnerPassword;
  }
});

test("owner session login rate limits repeated failed attempts", async () => {
  const previousDataDir = process.env.COACH_LOOP_DATA_DIR;
  const previousApiToken = process.env.COACH_LOOP_API_TOKEN;
  const previousOwnerPassword = process.env.COACH_LOOP_OAUTH_PASSWORD;
  process.env.COACH_LOOP_DATA_DIR = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/coach-loop-rate-test-`);
  process.env.COACH_LOOP_API_TOKEN = "test-token";
  process.env.COACH_LOOP_OAUTH_PASSWORD = "owner-password";

  try {
    for (let index = 0; index < 8; index += 1) {
      const failed = await request(handleRequest, {
        method: "POST",
        path: "/api/session/login",
        body: { password: `wrong-${index}` }
      });
      assert.equal(failed.statusCode, 401);
    }

    const limited = await request(handleRequest, {
      method: "POST",
      path: "/api/session/login",
      body: { password: "wrong-again" }
    });
    assert.equal(limited.statusCode, 429);
    assert.ok(limited.headers["retry-after"]);
  } finally {
    if (previousDataDir === undefined) delete process.env.COACH_LOOP_DATA_DIR;
    else process.env.COACH_LOOP_DATA_DIR = previousDataDir;
    if (previousApiToken === undefined) delete process.env.COACH_LOOP_API_TOKEN;
    else process.env.COACH_LOOP_API_TOKEN = previousApiToken;
    if (previousOwnerPassword === undefined) delete process.env.COACH_LOOP_OAUTH_PASSWORD;
    else process.env.COACH_LOOP_OAUTH_PASSWORD = previousOwnerPassword;
  }
});

test("day plan replacement clears stale actual links for removed activities", async () => {
  const previousDataDir = process.env.COACH_LOOP_DATA_DIR;
  const previousApiToken = process.env.COACH_LOOP_API_TOKEN;
  process.env.COACH_LOOP_DATA_DIR = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/coach-loop-stale-link-test-`);
  process.env.COACH_LOOP_API_TOKEN = "test-token";

  try {
    const before = await request(handleRequest, { path: "/api/state" });
    const activity = before.body.active_plan.activities[0];

    await request(handleRequest, {
      method: "POST",
      path: "/api/health/auto-export",
      headers: { authorization: "Bearer test-token" },
      body: {
        data: {
          workouts: [
            {
              id: "linked-actual-1",
              name: "Other",
              start: `${activity.date} 07:00:00 -0400`,
              duration: 1800
            }
          ]
        }
      }
    });

    const linked = await request(handleRequest, {
      method: "POST",
      path: `/api/activities/${encodeURIComponent(activity.activity_id)}/actual-link`,
      headers: { authorization: "Bearer test-token" },
      body: { actual_id: "linked-actual-1" }
    });
    assert.equal(linked.body.actual_links["linked-actual-1"], activity.activity_id);

    const replaced = await request(handleRequest, {
      method: "PUT",
      path: `/api/plans/current/days/${activity.date}`,
      headers: { authorization: "Bearer test-token" },
      body: {
        activities: [
          {
            title: "Replacement Session",
            type: "strength",
            required_or_optional: "required"
          }
        ]
      }
    });

    assert.equal(replaced.statusCode, 200);
    assert.equal(replaced.body.actual_links["linked-actual-1"], undefined);
    assert.equal(replaced.body.audit_events.at(-1).action, "plan.day.update");
  } finally {
    if (previousDataDir === undefined) delete process.env.COACH_LOOP_DATA_DIR;
    else process.env.COACH_LOOP_DATA_DIR = previousDataDir;
    if (previousApiToken === undefined) delete process.env.COACH_LOOP_API_TOKEN;
    else process.env.COACH_LOOP_API_TOKEN = previousApiToken;
  }
});

test("health raw debug capture is write-token protected", async () => {
  const previousDataDir = process.env.COACH_LOOP_DATA_DIR;
  const previousApiToken = process.env.COACH_LOOP_API_TOKEN;
  process.env.COACH_LOOP_DATA_DIR = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/coach-loop-raw-debug-test-`);
  process.env.COACH_LOOP_API_TOKEN = "test-token";

  try {
    const unauthenticated = await request(handleRequest, {
      path: "/api/health/raw-debug",
      headers: { authorization: "" }
    });
    assert.equal(unauthenticated.statusCode, 401);

    const response = await request(handleRequest, {
      method: "POST",
      path: "/api/health/auto-export?debug_raw=1",
      headers: { authorization: "Bearer test-token" },
      body: { data: { workouts: [] } }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.health.raw_debug.payload.data.workouts.length, 0);

    const raw = await request(handleRequest, {
      path: "/api/health/raw-debug",
      headers: { authorization: "Bearer test-token" }
    });
    assert.equal(raw.body.payload.data.workouts.length, 0);

    const sampleResponse = await request(handleRequest, {
      method: "POST",
      path: "/api/health/auto-export?debug_raw=sample",
      headers: { authorization: "Bearer test-token" },
      body: {
        data: {
          workouts: [
            {
              id: "sample-workout",
              name: "Outdoor Run",
              route: [
                { latitude: 42.1, longitude: -71.1, timestamp: "2026-06-30 08:00:00 -0400" },
                { latitude: 42.2, longitude: -71.2, timestamp: "2026-06-30 08:01:00 -0400" }
              ],
              heartRateData: [{ qty: 145, units: "count/min" }]
            }
          ]
        }
      }
    });
    assert.equal(sampleResponse.statusCode, 200);
    assert.equal(sampleResponse.body.health.raw_debug.mode, "sample");
    assert.equal(sampleResponse.body.health.raw_debug.payload.data.workouts.length, 1);
    assert.equal(sampleResponse.body.health.raw_debug.payload.data.workouts.first.route.length, 2);
    assert.equal(sampleResponse.body.health.raw_debug.payload.data.workouts.first.route.first.latitude, "[redacted]");
    assert.equal(sampleResponse.body.health.raw_debug.payload.data.workouts.first.heartRateData.first.qty, 145);
  } finally {
    if (previousDataDir === undefined) delete process.env.COACH_LOOP_DATA_DIR;
    else process.env.COACH_LOOP_DATA_DIR = previousDataDir;
    if (previousApiToken === undefined) delete process.env.COACH_LOOP_API_TOKEN;
    else process.env.COACH_LOOP_API_TOKEN = previousApiToken;
  }
});

test("health auto export computes mile splits from route points", async () => {
  const previousDataDir = process.env.COACH_LOOP_DATA_DIR;
  const previousApiToken = process.env.COACH_LOOP_API_TOKEN;
  process.env.COACH_LOOP_DATA_DIR = require("node:fs").mkdtempSync(`${require("node:os").tmpdir()}/coach-loop-splits-test-`);
  process.env.COACH_LOOP_API_TOKEN = "test-token";

  try {
    const response = await request(handleRequest, {
      method: "POST",
      path: "/api/health/auto-export",
      headers: { authorization: "Bearer test-token" },
      body: {
        data: {
          workouts: [
            {
              id: "split-workout-1",
              name: "Outdoor Run",
              start: "2026-06-30 08:00:00 -0400",
              end: "2026-06-30 08:20:00 -0400",
              duration: 1200,
              distance: { qty: 2, units: "mi" },
              route: [
                { latitude: 0, longitude: 0, timestamp: "2026-06-30 08:00:00 -0400" },
                { latitude: 0, longitude: 0.015, timestamp: "2026-06-30 08:10:00 -0400" },
                { latitude: 0, longitude: 0.03, timestamp: "2026-06-30 08:20:00 -0400" }
              ]
            }
          ]
        }
      }
    });

    assert.equal(response.statusCode, 200);
    const workout = response.body.health.actual_workouts[0];
    assert.ok(workout.splits.length >= 2);
    assert.equal(workout.splits[0].split, 1);
    assert.equal(workout.splits[0].distance_miles, 1);
    assert.ok(workout.splits[0].duration_seconds > 500);
    assert.equal(workout.route_point_count, 3);
    assert.equal(workout.route_shape.source_points, 3);
    assert.equal(workout.route_shape.points.length, 3);
    assert.deepEqual(Object.keys(workout.route_shape.points[0]).sort(), ["x", "y"]);
    assert.equal(workout.route_map.source_points, 3);
    assert.equal(workout.route_map.points.length, 3);
    assert.deepEqual(Object.keys(workout.route_map.points[0]).sort(), ["lat", "lon"]);
    assert.equal(workout.route_map.bounds.min_lat, 0);
  } finally {
    if (previousDataDir === undefined) delete process.env.COACH_LOOP_DATA_DIR;
    else process.env.COACH_LOOP_DATA_DIR = previousDataDir;
    if (previousApiToken === undefined) delete process.env.COACH_LOOP_API_TOKEN;
    else process.env.COACH_LOOP_API_TOKEN = previousApiToken;
  }
});

test("createCoachSummary includes completion and feedback context", () => {
  const store = createDefaultState(new Date("2026-06-19T12:00:00"));
  const activity = store.plans[0].activities[0];
  store.completions[activity.activity_id] = { completed: true, subtasks: {}, completed_at: "2026-06-19T12:00:00.000Z" };
  store.feedback[activity.activity_id] = { difficulty: 7, energy: 4, soreness: 2, back_pain: 1, notes: "Felt good" };
  store.coach_notes = "Prefer simple run prescriptions by distance.";

  const summary = createCoachSummary(store);

  assert.equal(summary.adherence.completed_required, 1);
  assert.equal(summary.coach_notes, "Prefer simple run prescriptions by distance.");
  assert.ok(summary.gear.length > 0);
  assert.match(summary.summary_text, /Available gear:/);
  assert.match(summary.summary_text, /Prefer simple run prescriptions by distance/);
  assert.match(summary.summary_text, /Felt good/);
  assert.equal(summary.planned_activities[0].feedback.difficulty, 7);
});

test("createCoachSummary includes logged exercise volume", () => {
  const store = createDefaultState(new Date("2026-06-19T12:00:00"));
  const activity = store.plans[0].activities.find((item) => item.subtasks.length);
  const exercise = activity.subtasks[0];
  store.exercise_logs = {
    [activity.activity_id]: {
      [exercise.subtask_id]: {
        exercise_id: exercise.subtask_id,
        title: exercise.title,
        weight_lbs: 45,
        sets: 3,
        reps: 10,
        total_weight_lbs: 1350
      }
    }
  };

  const summary = createCoachSummary(store);
  const loggedActivity = summary.planned_activities.find((item) => item.activity_id === activity.activity_id);

  assert.equal(loggedActivity.exercise_logs[exercise.subtask_id].total_weight_lbs, 1350);
  assert.match(summary.summary_text, /total weight moved 1350 lb/);
  assert.match(summary.summary_text, /45 lb x 3 x 10 = 1350 lb/);
});

test("createStreak uses logged dates instead of planned dates", () => {
  const store = createDefaultState(new Date("2026-06-19T12:00:00"));
  const [first, second] = store.plans[0].activities;
  store.completions[first.activity_id] = {
    completed: true,
    logged_date: "2026-06-18",
    completed_at: "2026-06-20T12:00:00.000Z",
    subtasks: {}
  };
  store.completions[second.activity_id] = {
    completed: true,
    logged_date: "2026-06-19",
    completed_at: "2026-06-20T12:00:00.000Z",
    subtasks: {}
  };

  const streak = createStreak(store, new Date("2026-06-19T12:00:00"));

  assert.equal(streak.current_streak_days, 2);
  assert.deepEqual(streak.completed_dates, ["2026-06-18", "2026-06-19"]);
});

test("createStreak reports days and weeks without a required miss", () => {
  const store = createDefaultState(new Date("2026-06-19T12:00:00"));
  store.plans[0].activities
    .filter((activity) => activity.required_or_optional === "required" && activity.date < "2026-06-19")
    .forEach((activity) => {
      store.completions[activity.activity_id] = {
        completed: true,
        logged_date: activity.date,
        completed_at: `${activity.date}T12:00:00.000Z`,
        subtasks: {}
      };
    });

  const clean = createStreak(store, new Date("2026-06-19T12:00:00"));
  assert.equal(clean.missed_required_count, 0);
  assert.equal(clean.days_without_miss, 4);
  assert.equal(clean.weeks_without_miss, 1);
  assert.equal(clean.current_week_on_track, true);

  const missedStore = createDefaultState(new Date("2026-06-19T12:00:00"));
  const monday = missedStore.plans[0].activities.find((activity) => activity.date === "2026-06-16" && activity.required_or_optional === "required");
  missedStore.plans[0].activities
    .filter((activity) => activity.required_or_optional === "required" && activity.date < "2026-06-19" && activity.activity_id !== monday.activity_id)
    .forEach((activity) => {
      missedStore.completions[activity.activity_id] = {
        completed: true,
        logged_date: activity.date,
        completed_at: `${activity.date}T12:00:00.000Z`,
        subtasks: {}
      };
    });

  const broken = createStreak(missedStore, new Date("2026-06-19T12:00:00"));
  assert.equal(broken.latest_missed_required_date, "2026-06-16");
  assert.equal(broken.days_without_miss, 3);
  assert.equal(broken.weeks_without_miss, 0);
  assert.equal(broken.current_week_on_track, false);
});
