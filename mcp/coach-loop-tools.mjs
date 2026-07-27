import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const looseObject = z.object({}).passthrough();
const weeklySubtaskSchema = z.union([
  z.string().min(1),
  z.object({
    subtask_id: z.string().optional(),
    title: z.string().min(1),
    kind: z.string().optional(),
    notes: z.string().optional(),
    log_mode: z.enum(["strength", "timed", "loaded-timed", "check"]).optional()
  }).passthrough()
]);
const weeklyActivitySchema = z.object({
  activity_id: z.string().min(1),
  date: z.string(),
  title: z.string().min(1),
  type: z.string().min(1),
  required_or_optional: z.enum(["required", "optional"]),
  target: looseObject,
  equipment: z.array(z.string()),
  references: z.array(z.string()),
  subtasks: z.array(weeklySubtaskSchema)
}).passthrough();
const weeklyPlanSchema = z.object({
  plan_id: z.string().min(1),
  week_start_date: z.string(),
  goals: z.array(z.string().min(1)).min(1),
  activities: z.array(weeklyActivitySchema).min(1)
}).passthrough();

function dateKeyFromDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00`);
  date.setDate(date.getDate() + days);
  return dateKeyFromDate(date);
}

function todayKey() {
  return dateKeyFromDate(new Date());
}

function dateDaysApart(start, end) {
  const startDate = new Date(`${start}T12:00:00`);
  const endDate = new Date(`${end}T12:00:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return 0;
  return Math.round((endDate - startDate) / 86400000);
}

function weekKeyForDate(date) {
  const value = new Date(`${date}T12:00:00`);
  const day = value.getDay();
  value.setDate(value.getDate() - ((day + 6) % 7));
  return dateKeyFromDate(value);
}

function roundDistance(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function monthFromGoalText(text) {
  const months = [
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december"
  ];
  const lower = String(text || "").toLowerCase();
  const index = months.findIndex((month) => lower.includes(month));
  return index >= 0 ? index : null;
}

function raceTargetFromGoals(goals = {}) {
  const explicit = String(goals.race_date || goals.target_race_date || "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return { date: explicit, inferred: false };
  const goalText = [goals.primary, ...(Array.isArray(goals.goals) ? goals.goals : [])].filter(Boolean).join(" ");
  const iso = goalText.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) return { date: iso[1], inferred: true };
  const month = monthFromGoalText(goalText);
  if (month !== null) {
    const now = new Date(`${todayKey()}T12:00:00`);
    const year = month < now.getMonth() ? now.getFullYear() + 1 : now.getFullYear();
    return { date: dateKeyFromDate(new Date(year, month + 1, 0)), inferred: true };
  }
  return { date: addDays(todayKey(), 16 * 7), inferred: true };
}

function runDistancesForWeek(longRunDistance, runCount, raceWeek = false, targetDistance = 13.1) {
  const count = Math.max(1, Number(runCount || 3));
  if (raceWeek) {
    const tuneups = count <= 2 ? [3] : [3, 2];
    return [...tuneups.slice(0, Math.max(0, count - 1)), targetDistance].slice(-count);
  }
  if (count === 1) return [roundDistance(longRunDistance)];
  const easy = Math.max(2, longRunDistance * 0.6);
  if (count === 2) return [roundDistance(easy), roundDistance(longRunDistance)];
  const quality = Math.max(2.5, longRunDistance * 0.72);
  const extras = Array.from({ length: Math.max(0, count - 3) }, () => Math.max(2.5, longRunDistance * 0.5));
  return [easy, quality, ...extras, longRunDistance].map(roundDistance);
}

function buildRunPlanFromState(state = {}) {
  const goals = state.goals || {};
  const runPlan = goals.run_plan || {};
  const runs = (state.health?.actual_workouts || []).filter((actual) => String(actual.type || actual.name || "").toLowerCase().includes("run"));
  const race = raceTargetFromGoals(goals);
  const targetDistance = Number(runPlan.race_distance_miles || goals.race_distance_miles || 13.1);
  const targetRuns = Math.max(1, Number(runPlan.weekly_runs || goals.run_frequency_per_week || 3));
  const currentWeekStart = weekKeyForDate(todayKey());
  const raceWeekStart = weekKeyForDate(race.date);
  const longestActual = Math.max(0, ...runs.map((run) => Number(run.distance_miles || 0)));
  const plannedRunDistances = (state.active_plan?.activities || [])
    .filter((activity) => activity.type === "run")
    .map((activity) => Number(activity.target?.distance_miles || 0))
    .filter(Boolean);
  const plannedLong = Math.max(0, ...plannedRunDistances);
  const startLong = Number(runPlan.start_long_run_miles || Math.max(3, Math.min(6, longestActual || plannedLong || 3)));
  const peakLong = Number(runPlan.peak_long_run_miles || Math.max(10, targetDistance - 1.1));
  const cutbackEveryWeeks = Math.max(3, Number(runPlan.cutback_every_weeks || 4));
  const totalWeeks = Math.max(1, Math.floor(dateDaysApart(currentWeekStart, raceWeekStart) / 7) + 1);
  const peakIndex = Math.max(0, totalWeeks - 3);
  const weeks = [];
  let weekStart = currentWeekStart;
  let index = 0;
  while (weekStart <= raceWeekStart && weeks.length < 32) {
    const weeksToRace = Math.max(0, Math.round(dateDaysApart(weekStart, raceWeekStart) / 7));
    const isRaceWeek = weekStart === raceWeekStart;
    let longRun = targetDistance;
    if (!isRaceWeek && weeksToRace === 1) longRun = Math.max(6, peakLong * 0.65);
    else if (!isRaceWeek && weeksToRace === 2) longRun = peakLong;
    else if (!isRaceWeek) {
      const progress = peakIndex ? Math.min(1, index / peakIndex) : 1;
      longRun = startLong + (peakLong - startLong) * progress;
      if (index > 0 && index % cutbackEveryWeeks === cutbackEveryWeeks - 1) longRun *= 0.86;
    }
    longRun = roundDistance(longRun);
    const distances = runDistancesForWeek(longRun, targetRuns, isRaceWeek, targetDistance);
    const actualRuns = runs.filter((run) => run.date >= weekStart && run.date <= addDays(weekStart, 6));
    weeks.push({
      week_start: weekStart,
      week_end: addDays(weekStart, 6),
      target_runs: targetRuns,
      planned_distances_miles: distances,
      target_weekly_miles: roundDistance(distances.reduce((sum, distance) => sum + distance, 0)),
      target_long_run_miles: longRun,
      actual_runs: actualRuns.length,
      actual_miles: roundDistance(actualRuns.reduce((sum, run) => sum + Number(run.distance_miles || 0), 0)),
      weeks_to_race: weeksToRace,
      is_race_week: isRaceWeek
    });
    weekStart = addDays(weekStart, 7);
    index += 1;
  }
  return {
    race,
    assumptions: {
      weekly_runs: targetRuns,
      race_distance_miles: targetDistance,
      start_long_run_miles: startLong,
      peak_long_run_miles: peakLong,
      cutback_every_weeks: cutbackEveryWeeks
    },
    weeks
  };
}

function compactActual(actual = {}) {
  const {
    heart_rate_series,
    route_shape,
    route_map,
    ...rest
  } = actual;
  return rest;
}

function compactActivity(activity = {}) {
  return {
    ...activity,
    actuals: Array.isArray(activity.actuals) ? activity.actuals.map(compactActual) : activity.actuals
  };
}

function compactPlan(plan) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.activities)) return plan;
  return {
    ...plan,
    activities: plan.activities.map(compactActivity)
  };
}

function compactCoachPayload(payload) {
  if (!payload || typeof payload !== "object") return payload;
  const next = { ...payload };

  if (next.active_plan) next.active_plan = compactPlan(next.active_plan);
  if (Array.isArray(next.planned_activities)) next.planned_activities = next.planned_activities.map(compactActivity);
  if (Array.isArray(next.plans)) {
    delete next.plans;
  }

  if (next.health && typeof next.health === "object") {
    next.health = {
      ...next.health,
      actual_workouts: Array.isArray(next.health.actual_workouts)
        ? next.health.actual_workouts.map(compactActual)
        : next.health.actual_workouts,
      imports: Array.isArray(next.health.imports) ? next.health.imports.slice(-5) : next.health.imports
    };
  }

  return next;
}

function asText(payload, { compact = true } = {}) {
  const output = compact ? compactCoachPayload(payload) : payload;
  return {
    content: [
      {
        type: "text",
        text: typeof output === "string" ? output : JSON.stringify(output, null, 2)
      }
    ]
  };
}

export function createCoachLoopMcpServer({ apiUrl, apiToken } = {}) {
  const API_URL = (apiUrl || process.env.COACH_LOOP_API_URL || "http://127.0.0.1:4173").replace(/\/$/, "");
  const securitySchemes = [
    {
      type: "oauth2",
      scopes: ["coach:read", "coach:write"]
    }
  ];

  function registerTool(name, options, handler) {
    server.registerTool(
      name,
      {
        ...options,
        securitySchemes,
        _meta: {
          ...(options._meta || {}),
          securitySchemes
        }
      },
      handler
    );
  }

  async function request(path, options = {}) {
    const response = await fetch(`${API_URL}${path}`, {
      headers: {
        "content-type": "application/json",
        ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}),
        ...(options.headers || {})
      },
      ...options
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(payload?.error || `Coach Loop API returned ${response.status}`);
    }
    return payload;
  }

  const server = new McpServer({
    name: "coach-loop",
    version: "0.1.0"
  });

  registerTool(
    "get_state",
    {
      title: "Get Coach Loop state",
      description: "Read goals, active plan, completions, feedback, and imported health actuals."
    },
    async () => asText(await request("/api/state"))
  );

  registerTool(
    "get_current_plan",
    {
      title: "Get current plan",
      description: "Read the active weekly workout plan, including completion and feedback state."
    },
    async () => asText(await request("/api/plans/current"))
  );

  registerTool(
    "get_coach_summary",
    {
      title: "Get coach summary",
      description: "Generate the weekly coach summary that can be used to adjust the next plan."
    },
    async () => asText(await request("/api/coach-summary"))
  );

  registerTool(
    "get_planning_context",
    {
      title: "Get planning context",
      description: "Read goals, gear inventory, active plan, streak, and notes needed to generate gear-aware workouts."
    },
    async () => asText(await request("/api/planning-context"))
  );

  registerTool(
    "get_run_plan",
    {
      title: "Get long-term run plan",
      description: "Read the generated half-marathon run plan from the current goals, race timing, run-plan assumptions, and imported run actuals."
    },
    async () => {
      const state = await request("/api/state");
      return asText({
        goals: state.goals,
        run_plan: buildRunPlanFromState(state)
      });
    }
  );

  registerTool(
    "get_gear",
    {
      title: "Get gear inventory",
      description: "Read the available equipment inventory used for workout planning."
    },
    async () => asText(await request("/api/gear"))
  );

  registerTool(
    "get_audit_log",
    {
      title: "Get audit log",
      description: "Read recent Coach Loop write events, newest first."
    },
    async () => asText(await request("/api/audit"))
  );

  registerTool(
    "upsert_gear",
    {
      title: "Add or update gear",
      description: "Add or update one or more gear inventory items. Use a stable gear_id to update existing equipment.",
      inputSchema: {
        gear: z.union([
          looseObject,
          z.array(looseObject)
        ])
      }
    },
    async ({ gear }) => asText(await request("/api/gear/upsert", {
      method: "POST",
      body: JSON.stringify(Array.isArray(gear) ? { gear } : gear)
    }))
  );

  registerTool(
    "remove_gear",
    {
      title: "Remove gear",
      description: "Remove one gear inventory item by gear_id.",
      inputSchema: {
        gear_id: z.string()
      }
    },
    async ({ gear_id }) => asText(await request(`/api/gear/${encodeURIComponent(gear_id)}`, {
      method: "DELETE"
    }))
  );

  registerTool(
    "import_weekly_plan",
    {
      title: "Import weekly plan",
      description: "Import and activate a complete ChatGPT-generated weekly plan JSON object. Strength, lift, and mobility activities must contain movement-level subtasks; references are source catalogs and never expand into exercise rows. For an existing week, included dates are merged and untouched dates are preserved.",
      inputSchema: {
        plan: weeklyPlanSchema.describe("Complete weekly plan JSON. Include stable IDs, goals, dates, required/optional status, targets, equipment, references, and movement-level subtasks.")
      }
    },
    async ({ plan }) => asText(await request("/api/plans/import", {
      method: "POST",
      body: JSON.stringify(plan)
    }))
  );

  registerTool(
    "update_day_plan",
    {
      title: "Update one day of the current plan",
      description: "Replace only one date's activities in the active weekly plan without overwriting the rest of the week. Strength, lift, and mobility activities must contain movement-level subtasks; references do not expand into exercise rows. Use this for schedule changes, swaps, or day-specific edits.",
      inputSchema: {
        date: z.string().describe("YYYY-MM-DD date to replace in the current active plan."),
        activities: z.array(weeklyActivitySchema.omit({ date: true }).extend({
          date: z.string().optional()
        })).describe("Complete activities for this date; date may be omitted because the tool applies the requested date.")
      }
    },
    async ({ date, activities }) => asText(await request(`/api/plans/current/days/${encodeURIComponent(date)}`, {
      method: "PUT",
      body: JSON.stringify({ activities })
    }))
  );

  registerTool(
    "link_actual_to_activity",
    {
      title: "Link actual workout to activity",
      description: "Explicitly link an imported actual workout to a planned activity when automatic date/type matching is not correct. Pass an empty actual_id to clear the manual link.",
      inputSchema: {
        activity_id: z.string(),
        actual_id: z.string().optional()
      }
    },
    async ({ activity_id, actual_id }) => asText(await request(`/api/activities/${encodeURIComponent(activity_id)}/actual-link`, {
      method: "POST",
      body: JSON.stringify({ actual_id: actual_id || null })
    }))
  );

  registerTool(
    "apply_actual_workout",
    {
      title: "Apply actual workout",
      description: "Use an imported Health actual to complete the right same-day workout. If no compatible planned workout exists, this creates a same-day optional replacement activity and links the actual. Prefer this over mark_activity when the user reports a Health workout such as Hiking/rucking, running, walking, yard work, or strength training. If a wrong planned activity was already marked complete, pass clear_activity_id to undo that manual completion.",
      inputSchema: {
        actual_id: z.string(),
        title: z.string().optional(),
        type: z.string().optional(),
        date: z.string().optional(),
        notes: z.string().optional(),
        clear_activity_id: z.string().optional()
      }
    },
    async ({ actual_id, ...payload }) => asText(await request(`/api/health/actuals/${encodeURIComponent(actual_id)}/apply`, {
      method: "POST",
      body: JSON.stringify(payload)
    }))
  );

  registerTool(
    "update_goals",
    {
      title: "Update goals",
      description: "Replace the current coaching goals object.",
      inputSchema: {
        goals: looseObject.describe("Goals object for the coach loop.")
      }
    },
    async ({ goals }) => asText(await request("/api/goals", {
      method: "PUT",
      body: JSON.stringify({ goals })
    }))
  );

  registerTool(
    "patch_goals",
    {
      title: "Patch goals",
      description: "Safely update selected goal fields without replacing the whole goals object. Use this for conversational goal edits.",
      inputSchema: {
        goals: looseObject.describe("Partial goals object to merge into the current goals.")
      }
    },
    async ({ goals }) => asText(await request("/api/goals", {
      method: "PATCH",
      body: JSON.stringify({ goals })
    }))
  );

  registerTool(
    "update_run_plan",
    {
      title: "Update long-term run plan",
      description: "Update half-marathon run-plan settings without replacing other goals. Use race_date, weekly_runs, race_distance_miles, start_long_run_miles, peak_long_run_miles, and cutback_every_weeks.",
      inputSchema: {
        race_date: z.string().optional().describe("YYYY-MM-DD race date."),
        weekly_runs: z.number().min(1).max(7).optional(),
        race_distance_miles: z.number().min(1).max(100).optional(),
        start_long_run_miles: z.number().min(0).max(100).optional(),
        peak_long_run_miles: z.number().min(0).max(100).optional(),
        cutback_every_weeks: z.number().min(3).max(8).optional(),
        notes: z.string().optional()
      }
    },
    async ({ race_date, weekly_runs, ...runPlan }) => {
      const goals = {
        ...(race_date ? { race_date } : {}),
        ...(weekly_runs ? { run_frequency_per_week: weekly_runs } : {}),
        run_plan: {
          ...(weekly_runs ? { weekly_runs } : {}),
          ...Object.fromEntries(Object.entries(runPlan).filter(([, value]) => value !== undefined && value !== null && value !== ""))
        }
      };
      return asText(await request("/api/goals", {
        method: "PATCH",
        body: JSON.stringify({ goals })
      }));
    }
  );

  registerTool(
    "update_coach_notes",
    {
      title: "Update coach notes",
      description: "Replace the durable coach notes used as planning context instead of per-workout notes.",
      inputSchema: {
        coach_notes: z.string()
      }
    },
    async ({ coach_notes }) => asText(await request("/api/coach-notes", {
      method: "PUT",
      body: JSON.stringify({ coach_notes })
    }))
  );

  registerTool(
    "mark_activity",
    {
      title: "Mark activity",
      description: "Mark a planned activity complete/incomplete, optionally logging the date it was actually done. When subtask_id is provided, only that subtask is updated. Do not use this to log a Health actual or substitute workout; use apply_actual_workout so Coach Loop can link or create the correct activity type.",
      inputSchema: {
        activity_id: z.string(),
        completed: z.boolean(),
        subtask_id: z.string().optional(),
        logged_date: z.string().optional()
      }
    },
    async ({ activity_id, completed, subtask_id, logged_date }) => asText(await request(`/api/activities/${encodeURIComponent(activity_id)}`, {
      method: "PATCH",
      body: JSON.stringify({ completed, subtask_id, logged_date })
    }))
  );

  registerTool(
    "save_activity_feedback",
    {
      title: "Save activity feedback",
      description: "Save quick subjective workout feedback. Difficulty and back pain are the main UI fields; energy, soreness, and notes are still accepted for compatibility.",
      inputSchema: {
        activity_id: z.string(),
        difficulty: z.number().min(1).max(10).optional(),
        energy: z.number().min(1).max(5).optional(),
        soreness: z.number().min(1).max(5).optional(),
        back_pain: z.number().min(0).max(10).optional(),
        notes: z.string().optional()
      }
    },
    async ({ activity_id, ...feedback }) => asText(await request(`/api/activities/${encodeURIComponent(activity_id)}/feedback`, {
      method: "POST",
      body: JSON.stringify(feedback)
    }))
  );

  registerTool(
    "save_exercise_log",
    {
      title: "Save exercise log",
      description: "Save weight, sets, and reps for one exercise within a planned activity. The app calculates total weight moved as weight_lbs x sets x reps.",
      inputSchema: {
        activity_id: z.string(),
        exercise_id: z.string().describe("Use the subtask_id for a subtask exercise, or activity for an activity-level exercise."),
        title: z.string().optional(),
        weight_lbs: z.number().min(0).max(2000).optional(),
        sets: z.number().min(0).max(200).optional(),
        reps: z.number().min(0).max(1000).optional()
      }
    },
    async ({ activity_id, ...log }) => asText(await request(`/api/activities/${encodeURIComponent(activity_id)}/exercise-log`, {
      method: "POST",
      body: JSON.stringify(log)
    }))
  );

  registerTool(
    "import_health_actuals",
    {
      title: "Import health actuals",
      description: "Import HealthKit-style actual workouts and daily recovery metrics.",
      inputSchema: {
        actual_workouts: z.array(looseObject).optional(),
        daily_metrics: z.array(looseObject).optional()
      }
    },
    async ({ actual_workouts = [], daily_metrics = [] }) => asText(await request("/api/health/import", {
      method: "POST",
      body: JSON.stringify({ actual_workouts, daily_metrics })
    }))
  );

  return server;
}
