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
// Only the fields the server cannot infer are required. activity_id, target,
// equipment and references are all normalized server-side, and demanding them
// here just turns valid plans into tool-call failures. activity_id in particular
// is safer derived than supplied: a reused ID collides with an existing
// activity's completions and exercise logs.
const weeklyActivitySchema = z.object({
  activity_id: z.string().min(1).optional(),
  date: z.string(),
  title: z.string().min(1),
  type: z.string().min(1),
  required_or_optional: z.enum(["required", "optional"]).optional(),
  target: looseObject.optional(),
  equipment: z.array(z.string()).optional(),
  references: z.array(z.string()).optional(),
  blocks: z.array(z.object({ block_id: z.string(), mode: z.literal("alternating_sets"), rounds: z.number().int().min(2).max(20), primary_subtask_id: z.string(), active_rest_subtask_id: z.string(), active_rest_between_rounds_only: z.boolean().optional(), additional_rest_seconds: z.number().min(0).max(600).optional() })).optional(),
  preference_applications: z.array(z.object({ key: z.string(), version: z.number().int().positive(), exception_reason: z.string().optional() })).optional(),
  subtasks: z.array(weeklySubtaskSchema)
}).passthrough();
const weeklyPlanSchema = z.object({
  plan_id: z.string().min(1).optional(),
  week_start_date: z.string(),
  goals: z.array(z.string().min(1)).min(1),
  activities: z.array(weeklyActivitySchema).min(1),
  coaching_review: z.object({
    memory_applications: z.array(z.object({ key: z.string(), version: z.number().int().positive(), application: z.string().optional(), exception_reason: z.string().optional() })),
    run_plan_review: z.string().describe("Explain weekly run changes and their effect on the peak target; name unresolved conflicts.")
  }).optional()
}).passthrough();
const exerciseGlossaryEntrySchema = z.object({
  glossary_id: z.string().min(1).optional(),
  canonical_name: z.string().min(1),
  aliases: z.array(z.string().min(1)).optional(),
  description: z.string().min(1),
  instructions: z.array(z.string().min(1)).min(1),
  cues: z.array(z.string().min(1)).optional(),
  cautions: z.array(z.string().min(1)).optional(),
  equipment: z.array(z.string().min(1)).optional(),
  source_title: z.string().min(1),
  source_publisher: z.string().optional(),
  source_url: z.string().url(),
  video_url: z.string().url().optional()
}).passthrough();
const planningPeriodSchema = z.object({
  period_id: z.string().min(1).optional(),
  title: z.string().min(1),
  start_date: z.string().describe("Inclusive YYYY-MM-DD start date."),
  end_date: z.string().describe("Inclusive YYYY-MM-DD end date."),
  reason: z.enum(["vacation", "planned_deload", "other"]),
  training_load: z.enum(["full_deload", "reduced", "normal"]),
  notes: z.string().optional()
}).passthrough();
const coachMemorySchema = z.object({
  memory_id: z.string().min(1).optional().describe("Existing stable ID from get_coaching_memories. Include it when editing a known memory."),
  key: z.string().min(1).describe("Short stable semantic key, such as run-prescription-style or avoid-weighted-vest. Reuse the same key to update instead of duplicating."),
  kind: z.enum(["preference", "fact", "constraint"]),
  category: z.enum(["planning", "exercise", "running", "recovery", "health", "equipment", "communication", "other"]),
  text: z.string().min(1).describe("Concise durable statement written so a future coach can apply it without the original conversation."),
  expected_version: z.number().int().positive().optional(),
  source_quote: z.string().optional(),
  source_event_id: z.string().optional(),
  effective_from: z.string().nullable().optional(),
  expires_at: z.string().nullable().optional(),
  rule: z.object({ sequence: z.literal("alternate_sets") }).nullable().optional()
}).passthrough();

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
  if (Array.isArray(payload)) return payload;
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

  async function verifiedPlanWrite(path, options) {
    const saved = await request(path, options);
    try {
      const current = await request("/api/plans/current");
      const prescription = p => p && ({ plan_id: p.plan_id, week_start_date: p.week_start_date, goals: p.goals,
        coaching_review: p.coaching_review,
        activities: (p.activities || []).map(a => ({ activity_id: a.activity_id, date: a.date, title: a.title, type: a.type,
          required_or_optional: a.required_or_optional, target: a.target, subtasks: a.subtasks, blocks: a.blocks,
          preference_applications: a.preference_applications, equipment: a.equipment, references: a.references })) });
      const verified = Boolean(saved.active_plan) && JSON.stringify(prescription(saved.active_plan)) === JSON.stringify(prescription(current));
      return asText({ ...saved, receipt: { status: verified ? "verified" : "changed_after_save", verified_at: new Date().toISOString(),
        instruction: verified ? "Plan saved and read back. Report applied decisions and unresolved run-plan conflicts." : "Write completed but the plan changed. Read current plan before any retry." } });
    } catch (error) {
      return asText({ ...saved, receipt: { status: "saved_verification_pending", error: error.message,
        instruction: "Write completed; verify current plan before retrying. Do not tell the user the save failed." } });
    }
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
      description: "Read the authoritative coaching_brief, versioned active preferences, timing observations and duration suggestions, goals, constraints, gear and current plan. Read this before daily or weekly planning. Apply current preference versions through structured blocks and preference_applications; keep time budgets separate from forecasts."
    },
    async () => asText(await request("/api/planning-context"))
  );

  registerTool(
    "get_planning_periods",
    {
      title: "Get vacation and deload periods",
      description: "Read durable date ranges that constrain workout planning, including vacations and purposeful deloads."
    },
    async () => asText(await request("/api/planning-periods"))
  );

  registerTool(
    "upsert_planning_periods",
    {
      title: "Add or update vacation and deload periods",
      description: "Persist one or more inclusive planning windows. Use reason for why the window exists and training_load for how much training should occur. Full deload dates must not contain required workouts.",
      inputSchema: {
        planning_periods: z.array(planningPeriodSchema).min(1)
      }
    },
    async ({ planning_periods }) => asText(await request("/api/planning-periods/upsert", {
      method: "POST",
      body: JSON.stringify({ planning_periods })
    }))
  );

  registerTool(
    "remove_planning_period",
    {
      title: "Remove a vacation or deload period",
      description: "Remove one durable planning period by period_id.",
      inputSchema: {
        period_id: z.string().min(1)
      }
    },
    async ({ period_id }) => asText(await request(`/api/planning-periods/${encodeURIComponent(period_id)}`, {
      method: "DELETE"
    }))
  );

  registerTool(
    "get_run_plan",
    {
      title: "Get long-term run plan",
      description: "Read the generated half-marathon run plan from the current goals, race timing, run-plan assumptions, and imported run actuals."
    },
    async () => asText(await request("/api/run-plan"))
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
    "get_exercise_glossary",
    {
      title: "Get exercise glossary",
      description: "Read the durable, sourced movement glossary used by the Workout Library. Match planned movement names against canonical_name and aliases before adding entries."
    },
    async () => asText(await request("/api/exercise-glossary"))
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
    "upsert_exercise_glossary",
    {
      title: "Add or update sourced exercise glossary entries",
      description: "Add or update one or more durable Workout Library movement guides. Every entry requires a plain-language description, actionable instructions, and a direct authoritative source URL. Use aliases for prescribed title variants and read the glossary back after writing.",
      inputSchema: {
        entries: z.union([
          exerciseGlossaryEntrySchema,
          z.array(exerciseGlossaryEntrySchema).min(1)
        ])
      }
    },
    async ({ entries }) => asText(await request("/api/exercise-glossary/upsert", {
      method: "POST",
      body: JSON.stringify({ entries: Array.isArray(entries) ? entries : [entries] })
    }))
  );

  registerTool(
    "import_weekly_plan",
    {
      title: "Import weekly plan",
      description: "Import and activate a complete ChatGPT-generated weekly plan JSON object. Every activity needs movement-level subtasks except runs, weighted-vest work, rest, and other general activity, which log at the activity level and take an empty subtasks array. References are source catalogs and never expand into exercise rows. For an existing week, included dates are merged and untouched dates are preserved. Read planning context first. Include coaching_review describing each current memory version applied or excepted, and reconcile run changes with the peak target. Report the returned receipt and unresolved conflicts.",
      inputSchema: {
        plan: weeklyPlanSchema.describe("Weekly plan JSON with week_start_date, goals, and activities. Each activity needs date, title, type, and subtasks; IDs, targets, equipment, and references are optional and filled in server-side.")
      }
    },
    async ({ plan }) => verifiedPlanWrite("/api/plans/import", {
      method: "POST",
      body: JSON.stringify(plan)
    })
  );

  registerTool(
    "update_day_plan",
    {
      title: "Update one day of the current plan",
      description: "Replace only one date's activities in the active weekly plan without overwriting the rest of the week. Every activity needs movement-level subtasks except runs, weighted-vest work, rest, and other general activity, which take an empty subtasks array. References do not expand into exercise rows. The date must fall inside the active plan week. Use this for schedule changes, swaps, or day-specific edits.",
      inputSchema: {
        date: z.string().describe("YYYY-MM-DD date to replace in the current active plan."),
        activities: z.array(weeklyActivitySchema.omit({ date: true }).extend({
          date: z.string().optional()
        })).describe("Complete activities for this date; date may be omitted because the tool applies the requested date. Reuse an activity_id only to keep an existing activity's logs; omit it for new activities.")
      }
    },
    async ({ date, activities }) => verifiedPlanWrite(`/api/plans/current/days/${encodeURIComponent(date)}`, {
      method: "PUT",
      body: JSON.stringify({ activities })
    })
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
    "get_coaching_memories",
    {
      title: "Get coaching memories and preferences",
      description: "Read the user's durable Coach Loop preferences, facts, and constraints with stable IDs and keys. Use this before changing or forgetting an existing memory, or when the user asks what Coach Loop remembers.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async () => asText(await request("/api/coach-memories"))
  );

  registerTool(
    "upsert_coaching_memories",
    {
      title: "Remember coaching preferences or facts",
      description: "Add or update durable Coach Loop memory. Use for explicit preferences including I like, I prefer, or this works better, even without remember. Read existing memories first; use expected_version for corrections. Retain source_quote and source_event_id. Use rule: {sequence: alternate_sets} for between-set active-rest preferences. Temporary exceptions need effective_from/expires_at and must not become permanent rules. Persist only durable coaching context, not a temporary one-workout request. Reuse a stable key (and memory_id when known) so updates replace the intended item without overwriting unrelated memories.",
      inputSchema: {
        coach_memories: z.array(coachMemorySchema).min(1).max(20)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      }
    },
    async ({ coach_memories }) => {
      const saved = await request("/api/coach-memories/upsert", { method: "POST", body: JSON.stringify({ coach_memories }) });
      try {
        const current = await request("/api/coach-memories");
        const verified = saved.saved.every(m => current.coach_memories.some(c => c.memory_id === m.memory_id && JSON.stringify(c) === JSON.stringify(m)));
        return asText({ ...saved, receipt: { status: verified ? "verified" : "changed_after_save", verified_at: new Date().toISOString(), instruction: verified ? "Saved and read back. Tell the user which memories changed." : "Write completed but read-back differs. Read current memory before any retry." } });
      } catch (error) {
        return asText({ ...saved, receipt: { status: "saved_verification_pending", instruction: "Write completed. Do not repeat it blindly; read memory to verify.", error: error.message } });
      }
    }
  );

  registerTool(
    "remove_coaching_memory",
    {
      title: "Forget one coaching memory",
      description: "Delete one durable Coach Loop memory by its stable memory_id. Use only when the user explicitly asks to forget or remove it; call get_coaching_memories first if the ID is not already known.",
      inputSchema: {
        memory_id: z.string().min(1)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false
      }
    },
    async ({ memory_id }) => asText(await request(`/api/coach-memories/${encodeURIComponent(memory_id)}`, {
      method: "DELETE"
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
      description: "Save daily feedback and explicit durable preferences atomically using coach_memories. Read existing memories before correcting them. Save actual_duration_minutes when reported. Set timing_status complete only when the user confirms the full prescribed session; use exclude for partial, interrupted, or materially changed work. Do not infer full completion from a watch record.",
      inputSchema: {
        activity_id: z.string(),
        difficulty: z.number().min(1).max(10).optional(),
        energy: z.number().min(1).max(5).optional(),
        soreness: z.number().min(1).max(5).optional(),
        back_pain: z.number().min(0).max(10).optional(),
        notes: z.string().optional(),
        actual_duration_minutes: z.number().positive().nullable().optional(),
        timing_status: z.enum(["unknown", "complete", "exclude"]).optional(),
        coach_memories: z.array(coachMemorySchema).min(1).max(20).optional()
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
