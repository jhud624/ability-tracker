const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  createStoreBackup,
  listStoreBackups,
  restoreStoreBackup,
  storageMode,
  readStoreData,
  updateStoreData,
  writeStoreData
} = require("./storage");
const {
  authRateLimit,
  authorizeMcpRequest,
  clearAuthFailures,
  createOwnerSessionToken,
  handleAuthorize,
  handleClientRegistration,
  handleToken,
  mcpOAuthRequired,
  ownerSessionTtlSeconds,
  recordAuthFailure,
  sendAuthorizationServerMetadata,
  sendProtectedResourceMetadata,
  verifyOwnerPassword,
  verifyOwnerSessionToken
} = require("./oauth");

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const BODY_LIMIT_BYTES = 2 * 1024 * 1024;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

function nowIso() {
  return new Date().toISOString();
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function weekStartFor(date = new Date()) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const daysSinceMonday = (copy.getDay() + 6) % 7;
  copy.setDate(copy.getDate() - daysSinceMonday);
  return copy;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

function stableId(prefix, pieces) {
  const slug = slugify(pieces.filter(Boolean).join("-"));
  return `${prefix}-${slug || crypto.randomUUID()}`;
}

function arrayOfStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

const SUBTASK_LOG_MODES = new Set(["strength", "timed", "loaded-timed", "check"]);
// Workout groups whose sessions are logged as a single activity-level entry and
// therefore legitimately carry no movement subtasks. Everything else must break
// the session out into loggable exercise rows.
const NO_SUBTASK_ACTIVITY_GROUPS = new Set(["run", "weighted_vest", "other", "rest"]);
const ATG_REFERENCE_NOTES = "Use this reference as the canonical ATG/back-health movement catalog. Every movement selected for a workout must still be materialized as its own subtask so it appears as a loggable exercise row; references never expand automatically.";

function normalizeRequiredOrOptional(activity) {
  // An explicit required_or_optional always wins; target.optional is only the
  // legacy fallback for plans written before the field existed.
  const explicit = String(activity.required_or_optional || "").trim().toLowerCase();
  if (explicit === "optional" || explicit === "required") return explicit;
  return activity.target?.optional === true ? "optional" : "required";
}

function normalizeSubtaskLogMode(value) {
  const mode = String(value || "").toLowerCase();
  return SUBTASK_LOG_MODES.has(mode) ? mode : undefined;
}

function normalizeSubtasks(activityId, subtasks = []) {
  if (!Array.isArray(subtasks)) return [];
  return subtasks.map((subtask, index) => {
    if (typeof subtask === "string") {
      return {
        subtask_id: `${activityId}-task-${index + 1}`,
        title: subtask
      };
    }
    return {
      subtask_id: String(subtask.subtask_id || subtask.id || `${activityId}-task-${index + 1}`),
      title: String(subtask.title || subtask.name || subtask.description || `Task ${index + 1}`),
      kind: subtask.kind || subtask.type ? String(subtask.kind || subtask.type) : undefined,
      notes: subtask.notes ? String(subtask.notes) : undefined,
      log_mode: normalizeSubtaskLogMode(subtask.log_mode || subtask.tracking)
    };
  });
}

function buildDefaultReferences() {
  return [
    {
      reference_id: "ref-atg-back-ability",
      title: "ATG Back Ability reference set",
      category: "back_health",
      notes: ATG_REFERENCE_NOTES,
      movements: [
        "Backward walking",
        "Tibialis raise",
        "Split squat stretch / ATG split squat",
        "Back extension progression",
        "Seated good morning",
        "Pigeon stretch",
        "Hamstring stretch / elephant walk",
        "L-sit or hanging core",
        "QL extension",
        "Wall pullover",
        "Trap-3 raise",
        "Couch stretch"
      ]
    }
  ];
}

function buildDefaultGearInventory() {
  const items = [
    {
      gear_id: "gear-power-rack-cable-station",
      name: "Power rack with cable station",
      category: "strength",
      status: "available",
      quantity: 1,
      capabilities: ["squat", "bench press", "rack pulls", "cable rows", "lat pulldowns", "pull-ups"],
      notes: "Inferred from photos: rack, pull-up grips, cable/pulley attachments, safeties, and plate storage."
    },
    {
      gear_id: "gear-olympic-barbell",
      name: "Olympic barbell",
      category: "strength",
      status: "available",
      quantity: 1,
      capabilities: ["deadlift", "row", "press", "squat", "bench press", "hip hinge"],
      notes: "Use with rack and Olympic plates."
    },
    {
      gear_id: "gear-olympic-plates",
      name: "Olympic weight plates",
      category: "strength",
      status: "available",
      quantity: null,
      capabilities: ["progressive overload", "barbell lifting", "loaded carries"],
      notes: "Assorted plates visible, including 20 kg / 45 lb plates. Exact total load is unknown."
    },
    {
      gear_id: "gear-adjustable-bench-leg-attachment",
      name: "Adjustable bench with leg attachment",
      category: "strength",
      status: "available",
      quantity: 1,
      capabilities: ["bench press", "incline press", "supported rows", "leg extension", "leg curl"],
      notes: "Leg attachment visible in rack area."
    },
    {
      gear_id: "gear-wall-pull-up-bar",
      name: "Wall-mounted pull-up bar",
      category: "bodyweight",
      status: "available",
      quantity: 1,
      capabilities: ["pull-ups", "chin-ups", "hanging core work", "scapular strength"],
      notes: "Mounted near the sliding door."
    },
    {
      gear_id: "gear-treadmill",
      name: "Treadmill",
      category: "cardio",
      status: "available",
      quantity: 1,
      capabilities: ["easy runs", "intervals", "incline walking", "weather backup"],
      notes: "ProForm treadmill visible. Useful for run days and controlled incline walks."
    },
    {
      gear_id: "gear-fixed-dumbbells",
      name: "Fixed dumbbells",
      category: "strength",
      status: "available",
      quantity: null,
      capabilities: ["presses", "rows", "curls", "triceps work", "raises", "split squats"],
      notes: "Multiple pairs visible on rack. Exact weights are unknown."
    },
    {
      gear_id: "gear-adjustable-dumbbells",
      name: "Adjustable dumbbells",
      category: "strength",
      status: "available",
      quantity: 2,
      capabilities: ["space-efficient loading", "presses", "rows", "arm work", "goblet squats"],
      notes: "Dial-style adjustable dumbbells visible."
    },
    {
      gear_id: "gear-kettlebells",
      name: "Kettlebells",
      category: "strength",
      status: "available",
      quantity: 3,
      capabilities: ["swings", "goblet squats", "carries", "hinge patterning", "conditioning"],
      notes: "Three kettlebells visible. Exact weights are unknown."
    },
    {
      gear_id: "gear-weighted-vest",
      name: "Weighted vest",
      category: "conditioning",
      status: "available",
      quantity: 1,
      load: { current_lbs: 30, adjustable: true },
      capabilities: ["weighted walking", "incline walking", "step-ups", "push-ups", "hiking"],
      notes: "User reported adjustable vest currently around 30 lb. Apple Watch workouts are tracked as Hiking."
    },
    {
      gear_id: "gear-back-extension-bench",
      name: "Back extension bench",
      category: "back_health",
      status: "available",
      quantity: 1,
      capabilities: ["back extensions", "hip extensions", "posterior-chain endurance"],
      notes: "Inferred from the final photo; exact model unclear."
    },
    {
      gear_id: "gear-stability-balls-and-mats",
      name: "Stability balls and floor mats",
      category: "mobility",
      status: "available",
      quantity: null,
      capabilities: ["mobility", "core work", "warmups", "recovery work"],
      notes: "Visible in the rack/treadmill area."
    }
  ];

  return items.map((item) => normalizeGearItem(item));
}

function normalizeGearItem(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Gear item must be an object");
  }
  const name = String(input.name || "").trim();
  if (!name) throw new Error("Gear item name is required");
  const gearId = String(input.gear_id || input.id || stableId("gear", [name]));
  const status = ["available", "limited", "unavailable"].includes(input.status) ? input.status : "available";
  return {
    gear_id: gearId,
    name,
    category: String(input.category || "general").trim() || "general",
    status,
    quantity: input.quantity === undefined ? null : input.quantity,
    load: input.load && typeof input.load === "object" ? input.load : undefined,
    capabilities: arrayOfStrings(input.capabilities),
    notes: input.notes ? String(input.notes) : "",
    source: input.source ? String(input.source) : "user_inventory",
    updated_at: input.updated_at || nowIso()
  };
}

function buildDefaultPlan(referenceDate = new Date()) {
  const start = weekStartFor(referenceDate);
  const days = Array.from({ length: 7 }, (_, index) => dateKey(addDays(start, index)));
  const rawActivities = [
    {
      date: days[0],
      title: "Upper Body + Arms + Back Health",
      type: "lift",
      required_or_optional: "required",
      equipment: ["adjustable bench", "dumbbells", "cable station", "floor mat"],
      references: ["ref-atg-back-ability"],
      target: { duration_minutes: 55, intensity: "moderate", notes: "Keep reps crisp and leave 1-2 reps in reserve." },
      subtasks: [
        "Warm up shoulders and hips for 8 minutes",
        "Horizontal press 3x8-10",
        "Chest-supported row 3x10-12",
        "Biceps curl 3x10-15",
        "Triceps pressdown 3x10-15",
        "McGill curl-up 2x6",
        "Side plank 2x20 sec each side",
        "Bird dog 2x6 each side"
      ]
    },
    {
      date: days[1],
      title: "Easy Run",
      type: "run",
      required_or_optional: "required",
      equipment: ["treadmill or outdoor route"],
      target: { distance_miles: 3, intensity: "easy", notes: "Conversational pace." },
      subtasks: []
    },
    {
      date: days[2],
      title: "Lower Body Maintenance + Back Health",
      type: "lift",
      required_or_optional: "required",
      equipment: ["power rack", "barbell", "plates", "bench", "kettlebell"],
      references: ["ref-atg-back-ability"],
      target: { duration_minutes: 45, intensity: "moderate", notes: "Maintenance work only; avoid soreness that interferes with running." },
      subtasks: [
        "Backward walk or sled 5 minutes",
        "Split squat 3x8 each side",
        "Hip hinge pattern 3x8",
        "Calf raise 2x15",
        "Couch stretch 1 min each side",
        "Bird dog 2x6 each side"
      ]
    },
    {
      date: days[3],
      title: "Quality Run",
      type: "run",
      required_or_optional: "required",
      equipment: ["treadmill or outdoor route"],
      target: { duration_minutes: 40, intensity: "controlled", notes: "Use hills, short intervals, or steady tempo depending on the coaching phase." },
      subtasks: ["10 min easy warmup", "6x1 min comfortably hard with 2 min easy", "8-10 min easy cooldown"]
    },
    {
      date: days[4],
      title: "Upper Body + Arms",
      type: "lift",
      required_or_optional: "required",
      equipment: ["pull-up bar", "adjustable bench", "dumbbells", "cable station"],
      references: ["ref-atg-back-ability"],
      target: { duration_minutes: 50, intensity: "moderate", notes: "Arm-growth focus without beating up your back." },
      subtasks: [
        "Vertical pull 3x8-10",
        "Incline press 3x8-10",
        "Lateral raise 3x12-20",
        "Hammer curl 3x10-15",
        "Overhead triceps extension 3x10-15",
        "Easy back reset circuit 5 minutes"
      ]
    },
    {
      date: days[5],
      title: "Long Run",
      type: "run",
      required_or_optional: "required",
      equipment: ["treadmill or outdoor route"],
      target: { duration_minutes: 45, intensity: "easy", notes: "This is the progression anchor for the half marathon." },
      subtasks: ["5 min warmup walk", "45 min easy run", "Walk until breathing settles", "Log difficulty and back pain"]
    },
    {
      date: days[6],
      title: "Recovery + Mobility",
      type: "mobility",
      required_or_optional: "optional",
      equipment: ["floor mat", "stability ball"],
      target: { duration_minutes: 20, intensity: "easy", notes: "Move enough to feel better, not tired." },
      subtasks: ["Easy walk", "Couch stretch", "Pigeon stretch", "Breathing reset"]
    }
  ];

  const activities = rawActivities.map((activity) => {
    const activityId = stableId("act", [activity.date, activity.type, activity.title]);
    return {
      activity_id: activityId,
      ...activity,
      subtasks: normalizeSubtasks(activityId, activity.subtasks)
    };
  });

  return {
    plan_id: `plan-${dateKey(start)}`,
    week_start_date: dateKey(start),
    goals: [
      "Run a half marathon in October",
      "Run 3 days per week",
      "Maintain lower-body strength",
      "Improve back health",
      "Grow arms",
      "Balance fatigue and recovery"
    ],
    activities,
    created_at: nowIso(),
    updated_at: nowIso()
  };
}

function createDefaultState(referenceDate = new Date()) {
  const plan = buildDefaultPlan(referenceDate);
  return {
    version: 1,
    revision: 1,
    created_at: nowIso(),
    updated_at: nowIso(),
    goals: {
      primary: "Half marathon in October",
      run_frequency_per_week: 3,
      strength_focus: ["Maintain lower-body strength", "Grow arms"],
      back_health: "Daily or near-daily spine-friendly work",
      recovery: "Adjust training based on fatigue, sleep, soreness, and back pain"
    },
    active_plan_id: plan.plan_id,
    plans: [plan],
    gear: buildDefaultGearInventory(),
    references: buildDefaultReferences(),
    coach_notes: "",
    completions: {},
    feedback: {},
    exercise_logs: {},
    actual_links: {},
    audit_events: [],
    health: {
      actual_workouts: [],
      daily_metrics: []
    }
  };
}

async function readStore() {
  const store = await readStoreData(createDefaultState);
  return migrateStore(store);
}

async function writeStore(store) {
  const nextStore = migrateStore({ ...store, updated_at: nowIso() });
  await writeStoreData(nextStore);
  return nextStore;
}

async function updateStore(mutator, audit = {}) {
  return updateStoreData(createDefaultState, async (current) => {
    const base = migrateStore(current);
    const mutated = await mutator(base);
    const nextRevision = Number(base.revision || 0) + 1;
    const event = audit.action ? {
      event_id: crypto.randomUUID(),
      action: audit.action,
      target: audit.target || null,
      source: audit.source || "web",
      created_at: nowIso()
    } : null;
    return migrateStore({
      ...mutated,
      revision: nextRevision,
      updated_at: nowIso(),
      audit_events: event ? [...(base.audit_events || []), event].slice(-100) : (base.audit_events || [])
    });
  });
}

function migrateStore(store) {
  const health = store.health || { actual_workouts: [], daily_metrics: [] };
  const references = Array.isArray(store.references) && store.references.length ? store.references : buildDefaultReferences();
  const nextStore = {
    ...store,
    plans: Array.isArray(store.plans) ? store.plans.map(normalizePlanForCurrentSchema) : [],
    gear: Array.isArray(store.gear) && store.gear.length ? store.gear.map((item) => normalizeGearItem(item)) : buildDefaultGearInventory(),
    references: references.map((reference) => reference.reference_id === "ref-atg-back-ability"
      ? { ...reference, notes: ATG_REFERENCE_NOTES }
      : reference),
    coach_notes: typeof store.coach_notes === "string" ? store.coach_notes : "",
    health: {
      actual_workouts: Array.isArray(health.actual_workouts) ? health.actual_workouts.map(normalizeActualWorkout) : [],
      daily_metrics: Array.isArray(health.daily_metrics) ? health.daily_metrics : [],
      imports: Array.isArray(health.imports) ? health.imports.slice(-20) : [],
      ...(health.raw_debug ? { raw_debug: health.raw_debug } : {})
    },
    completions: store.completions || {},
    feedback: store.feedback || {},
    exercise_logs: store.exercise_logs || {},
    actual_links: store.actual_links || {},
    audit_events: Array.isArray(store.audit_events) ? store.audit_events.slice(-100) : [],
    revision: Number(store.revision || 1)
  };
  return nextStore;
}

function normalizePlanForCurrentSchema(plan) {
  if (!plan || !Array.isArray(plan.activities)) return plan;
  return {
    ...plan,
    activities: plan.activities.map((activity) => {
      const title = String(activity.title || "").toLowerCase();
      const nextActivity = { ...activity };
      if (title === "easy run") {
        nextActivity.target = {
          ...(activity.target || {}),
          distance_miles: activity.target?.distance_miles || 3,
          intensity: activity.target?.intensity || "easy"
        };
        delete nextActivity.target.duration_minutes;
        nextActivity.subtasks = [];
      }
      if (title.includes("back health") || title.includes("back reset") || title.includes("upper body")) {
        nextActivity.references = Array.isArray(activity.references) && activity.references.length
          ? activity.references
          : ["ref-atg-back-ability"];
      }
      return nextActivity;
    })
  };
}

function validateDateKey(value, field) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) {
    throw new Error(`${field} must be a YYYY-MM-DD date`);
  }
}

function optionalDateKey(value, field) {
  if (value === undefined || value === null || value === "") return null;
  validateDateKey(value, field);
  return String(value);
}

function cleanOptionalNumber(value, min, max, field) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return number;
}

function normalizeActivityForPlan(activity, index, defaultDate = null) {
  if (!activity || typeof activity !== "object") {
    throw new Error(`Activity ${index + 1} must be an object`);
  }
  const date = activity.date || defaultDate;
  validateDateKey(date, `activities[${index}].date`);
  const title = String(activity.title || "").trim();
  const type = String(activity.type || "").trim().toLowerCase();
  if (!title) throw new Error(`activities[${index}].title is required`);
  if (!type) throw new Error(`activities[${index}].type is required`);
  const activityId = String(activity.activity_id || activity.id || stableId("act", [date, type, title]));
  const normalized = {
    activity_id: activityId,
    date,
    title,
    type,
    required_or_optional: normalizeRequiredOrOptional(activity),
    target: activity.target && typeof activity.target === "object" ? activity.target : {},
    equipment: arrayOfStrings(activity.equipment || activity.equipment_required || activity.gear),
    references: arrayOfStrings(activity.references || activity.reference_ids),
    notes: activity.notes ? String(activity.notes) : undefined,
    subtasks: normalizeSubtasks(activityId, activity.subtasks)
  };
  return normalized;
}

function validateDetailedPlanActivity(activity, index) {
  // Default to requiring movement rows. `type` is free-form, so an allowlist of
  // detailed types lets any unrecognized noun ("workout", "gym", "circuit")
  // reintroduce the skeletal-plan bug. Only the groups that genuinely log at the
  // activity level are exempt.
  const group = workoutTypeGroup(activity.type);
  if (!NO_SUBTASK_ACTIVITY_GROUPS.has(group) && activity.subtasks.length === 0) {
    throw new Error(`activities[${index}].subtasks must include movement-level rows for ${activity.type} activities`);
  }
  return activity;
}

function assertUniqueActivityIds(activities) {
  const activityIds = new Set();
  activities.forEach((activity, index) => {
    if (activityIds.has(activity.activity_id)) {
      throw new Error(`activities[${index}].activity_id must be unique`);
    }
    activityIds.add(activity.activity_id);
  });
  return activities;
}

function assertActivityDatesWithinWeek(activities, weekStartDate) {
  const lastDay = weekEndDateFor(weekStartDate);
  activities.forEach((activity, index) => {
    if (activity.date < weekStartDate || activity.date > lastDay) {
      throw new Error(`activities[${index}].date must fall within the plan week`);
    }
  });
  return activities;
}

function validatePlan(input) {
  const plan = input && input.plan ? input.plan : input;
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    throw new Error("Plan import must be a JSON object");
  }
  if (!Array.isArray(plan.activities) || plan.activities.length === 0) {
    throw new Error("Plan must include at least one activity");
  }
  if (!Array.isArray(plan.goals) || plan.goals.map((goal) => String(goal).trim()).filter(Boolean).length === 0) {
    throw new Error("Plan must include at least one weekly goal");
  }
  validateDateKey(plan.week_start_date, "week_start_date");

  const normalizedPlanId = String(plan.plan_id || `plan-${plan.week_start_date}`);
  const activities = plan.activities.map((activity, index) =>
    validateDetailedPlanActivity(normalizeActivityForPlan(activity, index), index)
  );
  assertActivityDatesWithinWeek(activities, plan.week_start_date);
  assertUniqueActivityIds(activities);

  return {
    plan_id: normalizedPlanId,
    week_start_date: plan.week_start_date,
    goals: plan.goals.map(String).map((goal) => goal.trim()).filter(Boolean),
    activities,
    created_at: plan.created_at || nowIso(),
    updated_at: nowIso()
  };
}

function mergePlanPreservingExisting(existingPlan, incomingPlan) {
  if (!existingPlan || existingPlan.week_start_date !== incomingPlan.week_start_date) return incomingPlan;
  const incomingDates = new Set(incomingPlan.activities.map((activity) => activity.date));
  // Uniqueness has to be re-checked here, not just on the incoming plan: an
  // incoming activity can reuse the ID of a preserved activity on an untouched
  // date, and completions/exercise_logs are keyed by activity_id.
  const activities = assertUniqueActivityIds([
    ...(existingPlan.activities || []).filter((activity) => !incomingDates.has(activity.date)),
    ...incomingPlan.activities
  ].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title)));
  return {
    ...existingPlan,
    ...incomingPlan,
    goals: incomingPlan.goals.length ? incomingPlan.goals : existingPlan.goals || [],
    activities,
    created_at: existingPlan.created_at || incomingPlan.created_at,
    updated_at: nowIso()
  };
}

function exerciseLogHasStoredData(log = {}) {
  return ["weight_lbs", "sets", "reps", "duration_seconds"].some((field) => Number(log[field]) > 0);
}

function clearBlankFallbackExerciseLogs(exerciseLogs = {}, plan) {
  const nextLogs = { ...exerciseLogs };
  (plan.activities || []).forEach((activity) => {
    if (!activity.subtasks?.length || !nextLogs[activity.activity_id]?.activity) return;
    const activityLogs = { ...nextLogs[activity.activity_id] };
    if (!exerciseLogHasStoredData(activityLogs.activity)) {
      delete activityLogs.activity;
      if (Object.keys(activityLogs).length) nextLogs[activity.activity_id] = activityLogs;
      else delete nextLogs[activity.activity_id];
    }
  });
  return nextLogs;
}

function activePlan(store) {
  return store.plans.find((plan) => plan.plan_id === store.active_plan_id) || store.plans[0] || null;
}

function allPlanActivities(store) {
  return (store.plans || [])
    .flatMap((plan) => (plan.activities || []).map((activity) => ({
      ...activity,
      plan_id: plan.plan_id,
      week_start_date: plan.week_start_date
    })));
}

function inferEquipmentForActivity(activity) {
  const title = String(activity.title || "").toLowerCase();
  if (Array.isArray(activity.equipment) && activity.equipment.length) return activity.equipment;
  if (activity.type === "run") return ["treadmill or outdoor route"];
  if (activity.type === "weighted_vest") return ["weighted vest", "outdoor route or treadmill incline"];
  if (activity.type === "mobility") return ["floor mat", "stability ball"];
  if (title.includes("lower")) return ["power rack", "barbell", "plates", "bench", "kettlebell"];
  if (title.includes("arms") || title.includes("upper")) return ["pull-up bar", "adjustable bench", "dumbbells", "cable station"];
  return [];
}

function weekEndDateFor(weekStartDate) {
  return dateKey(addDays(new Date(`${weekStartDate}T12:00:00`), 6));
}

function weekEndDate(plan) {
  return weekEndDateFor(plan.week_start_date);
}

function activityWithState(activity, store) {
  const completion = store.completions[activity.activity_id] || {};
  const subtaskCompletion = completion.subtasks || {};
  const exerciseLogs = store.exercise_logs?.[activity.activity_id] || {};
  const matchedActuals = actualsForActivity(activity, store);
  const actualCompletion = matchedActuals[0] || null;
  return {
    ...activity,
    equipment: inferEquipmentForActivity(activity),
    completion: {
      completed: Boolean(completion.completed) || Boolean(actualCompletion),
      completed_at: completion.completed_at || actualCompletion?.end_date || actualCompletion?.start_date || null,
      logged_date: completion.logged_date || actualCompletion?.date || null,
      subtasks: subtaskCompletion
    },
    exercise_logs: exerciseLogs,
    actuals: matchedActuals,
    actual_match_candidates: actualMatchCandidates(activity, store),
    feedback: store.feedback[activity.activity_id] || null
  };
}

function exerciseVolume(log) {
  const weight = Number(log?.weight_lbs || 0);
  const sets = Number(log?.sets || 0);
  const reps = Number(log?.reps || 0);
  return weight && sets && reps ? weight * sets * reps : 0;
}

function formatExerciseDuration(log) {
  const seconds = Number(log?.duration_seconds || 0);
  if (!seconds) return "";
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} sec`;
}

function numberFromHealthValue(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "object") {
    return numberFromHealthValue(value.qty ?? value.value ?? value.amount ?? value.quantity);
  }
  const number = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(number) ? number : null;
}

function textFromHealthValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") {
    return String(value.name ?? value.type ?? value.value ?? value.workoutActivityType ?? "");
  }
  return String(value);
}

function unitFromHealthValue(value, fallback = "") {
  if (value && typeof value === "object") return String(value.units ?? value.unit ?? fallback);
  return fallback;
}

function milesFromDistance(value) {
  const amount = numberFromHealthValue(value);
  if (amount === null) return null;
  const units = unitFromHealthValue(value).toLowerCase();
  if (units.includes("km")) return amount * 0.621371;
  if (units === "m" || units.includes("meter")) return amount * 0.000621371;
  return amount;
}

function minutesFromDuration(value) {
  const amount = numberFromHealthValue(value);
  if (amount === null) return null;
  const units = unitFromHealthValue(value).toLowerCase();
  if (units.includes("hour") || units === "hr") return amount * 60;
  if (units.includes("sec") || units === "s") return amount / 60;
  return amount;
}

function parseHealthTimestamp(value) {
  if (!value) return null;
  const parsed = new Date(String(value).replace(/ ([+-]\d{4})$/, "$1"));
  const time = parsed.getTime();
  return Number.isFinite(time) ? time : null;
}

function distanceMetersBetween(a, b) {
  const lat1 = Number(a?.latitude);
  const lon1 = Number(a?.longitude);
  const lat2 = Number(b?.latitude);
  const lon2 = Number(b?.longitude);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return 0;
  const toRad = (degrees) => degrees * Math.PI / 180;
  const earthMeters = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * earthMeters * Math.asin(Math.sqrt(h));
}

function formatPace(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  const remainder = String(rounded % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function roundTo(value, decimals = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function computeMileSplitsFromRoute(route = []) {
  if (!Array.isArray(route) || route.length < 2) return [];
  const mileMeters = 1609.344;
  const points = route
    .map((point) => ({ ...point, time: parseHealthTimestamp(point.timestamp || point.date) }))
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(Number(point.latitude)) && Number.isFinite(Number(point.longitude)))
    .sort((a, b) => a.time - b.time);
  if (points.length < 2) return [];

  let cumulativeMeters = 0;
  let nextThreshold = mileMeters;
  let previousThresholdTime = points[0].time;
  const splits = [];

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    const segmentMeters = distanceMetersBetween(previous, current);
    if (!segmentMeters) {
      continue;
    }
    const segmentStartMeters = cumulativeMeters;
    const segmentEndMeters = cumulativeMeters + segmentMeters;

    while (segmentEndMeters >= nextThreshold) {
      const ratio = segmentMeters ? (nextThreshold - segmentStartMeters) / segmentMeters : 0;
      const thresholdTime = previous.time + (current.time - previous.time) * Math.max(0, Math.min(1, ratio));
      const durationSeconds = (thresholdTime - previousThresholdTime) / 1000;
      splits.push({
        split: splits.length + 1,
        distance_miles: 1,
        duration_seconds: Math.round(durationSeconds),
        pace: formatPace(durationSeconds)
      });
      previousThresholdTime = thresholdTime;
      nextThreshold += mileMeters;
    }

    cumulativeMeters = segmentEndMeters;
  }

  const remainingMeters = cumulativeMeters - (splits.length * mileMeters);
  const lastTime = points[points.length - 1].time;
  if (remainingMeters > mileMeters * 0.1 && lastTime > previousThresholdTime) {
    const durationSeconds = (lastTime - previousThresholdTime) / 1000;
    const distanceMiles = remainingMeters / mileMeters;
    splits.push({
      split: splits.length + 1,
      distance_miles: Math.round(distanceMiles * 100) / 100,
      duration_seconds: Math.round(durationSeconds),
      pace: formatPace(durationSeconds / distanceMiles)
    });
  }

  return splits;
}

function compactQuantity(value) {
  const qty = numberFromHealthValue(value);
  if (qty === null) return undefined;
  return {
    qty: roundTo(qty, 2),
    units: unitFromHealthValue(value)
  };
}

function compactSpeedQuantity(value) {
  const quantity = compactQuantity(value);
  if (!quantity) return undefined;
  const units = String(quantity.units || "").toLowerCase();
  return {
    ...quantity,
    units: units === "mi" ? "mph" : quantity.units
  };
}

function healthSampleValue(sample) {
  return numberFromHealthValue(sample?.Avg ?? sample?.avg ?? sample?.average ?? sample?.qty ?? sample?.value ?? sample);
}

function sortedHealthSamples(samples = []) {
  if (!Array.isArray(samples)) return [];
  return samples
    .map((sample) => ({ ...sample, time: parseHealthTimestamp(sample.date || sample.start || sample.start_date || sample.timestamp) }))
    .filter((sample) => Number.isFinite(sample.time))
    .sort((a, b) => a.time - b.time);
}

function average(values) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function sumHealthSeries(samples = []) {
  if (!Array.isArray(samples)) return null;
  const values = samples.map(healthSampleValue).filter(Number.isFinite);
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function computeHeartRateRecovery(samples = []) {
  const ordered = sortedHealthSamples(samples)
    .map((sample) => ({ ...sample, bpm: healthSampleValue(sample) }))
    .filter((sample) => Number.isFinite(sample.bpm));
  if (ordered.length < 2) return undefined;
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const oneMinute = ordered.find((sample) => sample.time - first.time >= 60000) || last;
  return {
    start_bpm: roundTo(first.bpm, 1),
    end_bpm: roundTo(last.bpm, 1),
    drop_bpm: roundTo(first.bpm - last.bpm, 1),
    one_minute_drop_bpm: roundTo(first.bpm - oneMinute.bpm, 1),
    duration_seconds: Math.round((last.time - first.time) / 1000),
    sample_count: ordered.length
  };
}

function computeHeartRateDrift(samples = []) {
  const values = sortedHealthSamples(samples).map(healthSampleValue).filter(Number.isFinite);
  if (values.length < 4) return undefined;
  const midpoint = Math.floor(values.length / 2);
  const firstHalfAverage = average(values.slice(0, midpoint));
  const secondHalfAverage = average(values.slice(midpoint));
  if (!Number.isFinite(firstHalfAverage) || !Number.isFinite(secondHalfAverage)) return undefined;
  const drift = secondHalfAverage - firstHalfAverage;
  return {
    first_half_avg_bpm: roundTo(firstHalfAverage, 1),
    second_half_avg_bpm: roundTo(secondHalfAverage, 1),
    drift_bpm: roundTo(drift, 1),
    drift_percent: roundTo((drift / firstHalfAverage) * 100, 1)
  };
}

function computePaceDrift(distanceSamples = []) {
  const values = sortedHealthSamples(distanceSamples).map(healthSampleValue).filter(Number.isFinite);
  if (values.length < 4) return undefined;
  const midpoint = Math.floor(values.length / 2);
  const firstHalfDistancePerBucket = average(values.slice(0, midpoint));
  const secondHalfDistancePerBucket = average(values.slice(midpoint));
  if (!Number.isFinite(firstHalfDistancePerBucket) || !Number.isFinite(secondHalfDistancePerBucket) || firstHalfDistancePerBucket <= 0) return undefined;
  return {
    first_half_distance_per_bucket: roundTo(firstHalfDistancePerBucket, 4),
    second_half_distance_per_bucket: roundTo(secondHalfDistancePerBucket, 4),
    slowdown_percent: roundTo(((firstHalfDistancePerBucket - secondHalfDistancePerBucket) / firstHalfDistancePerBucket) * 100, 1),
    sample_count: values.length
  };
}

function downsampleEvenly(items, maxItems) {
  if (!Array.isArray(items) || items.length <= maxItems) return items;
  const result = [];
  for (let index = 0; index < maxItems; index += 1) {
    const sourceIndex = Math.round(index * (items.length - 1) / (maxItems - 1));
    result.push(items[sourceIndex]);
  }
  return result;
}

function compactHeartRateSeries(samples = []) {
  const ordered = sortedHealthSamples(samples)
    .map((sample) => ({
      time: sample.time,
      avg_bpm: healthSampleValue(sample),
      min_bpm: numberFromHealthValue(sample.Min ?? sample.min),
      max_bpm: numberFromHealthValue(sample.Max ?? sample.max)
    }))
    .filter((sample) => Number.isFinite(sample.avg_bpm));
  if (ordered.length < 2) return undefined;
  const firstTime = ordered[0].time;
  return downsampleEvenly(ordered, 120).map((sample) => ({
    offset_seconds: Math.round((sample.time - firstTime) / 1000),
    avg_bpm: roundTo(sample.avg_bpm, 1),
    min_bpm: roundTo(sample.min_bpm, 1),
    max_bpm: roundTo(sample.max_bpm, 1)
  }));
}

function compactRouteShape(route = []) {
  if (!Array.isArray(route) || route.length < 2) return undefined;
  const points = route
    .map((point) => ({
      latitude: Number(point.latitude),
      longitude: Number(point.longitude),
      time: parseHealthTimestamp(point.timestamp || point.date)
    }))
    .filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude))
    .sort((a, b) => (a.time || 0) - (b.time || 0));
  if (points.length < 2) return undefined;
  const latitudes = points.map((point) => point.latitude);
  const longitudes = points.map((point) => point.longitude);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLon = Math.min(...longitudes);
  const maxLon = Math.max(...longitudes);
  const latRange = maxLat - minLat || 1;
  const lonRange = maxLon - minLon || 1;
  const shapePoints = downsampleEvenly(points, 160).map((point) => ({
    x: roundTo((point.longitude - minLon) / lonRange, 4),
    y: roundTo(1 - ((point.latitude - minLat) / latRange), 4)
  }));
  return {
    source_points: points.length,
    points: shapePoints
  };
}

function compactRouteMap(route = []) {
  if (!Array.isArray(route) || route.length < 2) return undefined;
  const points = route
    .map((point) => ({
      lat: Number(point.latitude),
      lon: Number(point.longitude),
      time: parseHealthTimestamp(point.timestamp || point.date)
    }))
    .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon))
    .sort((a, b) => (a.time || 0) - (b.time || 0));
  if (points.length < 2) return undefined;
  const sampled = downsampleEvenly(points, 160).map((point) => ({
    lat: roundTo(point.lat, 6),
    lon: roundTo(point.lon, 6)
  }));
  const latitudes = points.map((point) => point.lat);
  const longitudes = points.map((point) => point.lon);
  return {
    source_points: points.length,
    bounds: {
      min_lat: roundTo(Math.min(...latitudes), 6),
      max_lat: roundTo(Math.max(...latitudes), 6),
      min_lon: roundTo(Math.min(...longitudes), 6),
      max_lon: roundTo(Math.max(...longitudes), 6)
    },
    points: sampled
  };
}

function sanitizeRouteShape(routeShape) {
  if (!routeShape || typeof routeShape !== "object" || !Array.isArray(routeShape.points)) return undefined;
  const points = routeShape.points
    .map((point) => ({
      x: roundTo(Number(point.x), 4),
      y: roundTo(Number(point.y), 4)
    }))
    .filter((point) => Number.isFinite(point.x) && point.x >= 0 && point.x <= 1 && Number.isFinite(point.y) && point.y >= 0 && point.y <= 1);
  if (points.length < 2) return undefined;
  const sourcePoints = Number(routeShape.source_points ?? routeShape.sourcePoints ?? points.length);
  return {
    source_points: Number.isFinite(sourcePoints) && sourcePoints > 0 ? Math.round(sourcePoints) : points.length,
    points: downsampleEvenly(points, 160)
  };
}

function sanitizeRouteMap(routeMap) {
  if (!routeMap || typeof routeMap !== "object" || !Array.isArray(routeMap.points)) return undefined;
  const points = routeMap.points
    .map((point) => ({
      lat: roundTo(Number(point.lat ?? point.latitude), 6),
      lon: roundTo(Number(point.lon ?? point.longitude), 6)
    }))
    .filter((point) => Number.isFinite(point.lat) && point.lat >= -90 && point.lat <= 90 && Number.isFinite(point.lon) && point.lon >= -180 && point.lon <= 180);
  if (points.length < 2) return undefined;
  const latitudes = points.map((point) => point.lat);
  const longitudes = points.map((point) => point.lon);
  const bounds = routeMap.bounds && typeof routeMap.bounds === "object" ? {
    min_lat: Number(routeMap.bounds.min_lat),
    max_lat: Number(routeMap.bounds.max_lat),
    min_lon: Number(routeMap.bounds.min_lon),
    max_lon: Number(routeMap.bounds.max_lon)
  } : null;
  const validBounds = bounds
    && Number.isFinite(bounds.min_lat)
    && Number.isFinite(bounds.max_lat)
    && Number.isFinite(bounds.min_lon)
    && Number.isFinite(bounds.max_lon)
    && bounds.min_lat >= -90
    && bounds.max_lat <= 90
    && bounds.min_lon >= -180
    && bounds.max_lon <= 180
    && bounds.min_lat <= bounds.max_lat
    && bounds.min_lon <= bounds.max_lon;
  const sourcePoints = Number(routeMap.source_points ?? routeMap.sourcePoints ?? points.length);
  return {
    source_points: Number.isFinite(sourcePoints) && sourcePoints > 0 ? Math.round(sourcePoints) : points.length,
    bounds: validBounds ? {
      min_lat: roundTo(bounds.min_lat, 6),
      max_lat: roundTo(bounds.max_lat, 6),
      min_lon: roundTo(bounds.min_lon, 6),
      max_lon: roundTo(bounds.max_lon, 6)
    } : {
      min_lat: roundTo(Math.min(...latitudes), 6),
      max_lat: roundTo(Math.max(...latitudes), 6),
      min_lon: roundTo(Math.min(...longitudes), 6),
      max_lon: roundTo(Math.max(...longitudes), 6)
    },
    points: downsampleEvenly(points, 160)
  };
}

function workoutDurationMinutes(actual) {
  if (actual.duration_minutes !== undefined || actual.durationMinutes !== undefined) {
    const value = minutesFromDuration(actual.duration_minutes ?? actual.durationMinutes);
    return value && value > 600 ? value / 60 : value;
  }
  const value = actual.duration ?? actual.totalTime;
  if (typeof value === "number") return value / 60;
  return minutesFromDuration(value);
}

function normalizeWorkoutType(value) {
  const text = textFromHealthValue(value).toLowerCase();
  if (text.includes("run")) return "run";
  if (text.includes("hike") || text.includes("hiking")) return "hiking";
  if (text.includes("walk")) return "walk";
  if (text.includes("strength") || text.includes("traditional")) return "strength";
  return slugify(text || "workout").replace(/-/g, "_");
}

function normalizeActualWorkout(actual) {
  const start = actual.start_date || actual.startDate || actual.start || actual.date;
  const date = actual.date || String(start || "").slice(0, 10);
  const distanceMiles = milesFromDistance(actual.distance_miles ?? actual.distanceMiles ?? actual.distance ?? actual.totalDistance);
  const durationMinutes = workoutDurationMinutes(actual);
  const activeEnergy = numberFromHealthValue(actual.active_energy_kcal ?? actual.activeEnergyBurned) ?? roundTo(sumHealthSeries(actual.activeEnergy), 1);
  const averageHeartRate = numberFromHealthValue(actual.average_heart_rate ?? actual.averageHeartRate ?? actual.avgHeartRate ?? actual.heartRateAverage ?? actual.avgHeartRate ?? actual.heartRate?.avg ?? actual.avgHeartRate);
  const maxHeartRate = numberFromHealthValue(actual.max_heart_rate ?? actual.maxHeartRate ?? actual.heartRate?.max);
  const totalSteps = numberFromHealthValue(actual.total_steps ?? actual.totalSteps) ?? roundTo(sumHealthSeries(actual.stepCount), 0);
  const totalEnergy = numberFromHealthValue(actual.total_energy_kcal ?? actual.totalEnergy);
  const basalEnergy = numberFromHealthValue(actual.basal_energy_kcal ?? actual.basalEnergyBurned) ?? roundTo(sumHealthSeries(actual.basalEnergy), 1);
  return {
    actual_id: String(actual.actual_id || actual.id || actual.uuid || stableId("actual", [date, actual.type || actual.workoutActivityType || actual.name || "workout"])),
    date,
    name: actual.name || actual.title || "",
    type: normalizeWorkoutType(actual.type || actual.workout_type || actual.workoutActivityType || actual.name),
    duration_minutes: durationMinutes,
    distance_miles: distanceMiles,
    average_heart_rate: averageHeartRate,
    max_heart_rate: maxHeartRate,
    active_energy_kcal: activeEnergy,
    basal_energy_kcal: basalEnergy,
    total_energy_kcal: totalEnergy,
    splits: Array.isArray(actual.splits) ? actual.splits : computeMileSplitsFromRoute(actual.route),
    route_point_count: actual.route_point_count ?? actual.routePointCount ?? (Array.isArray(actual.route) ? actual.route.length : undefined),
    heart_rate_series: Array.isArray(actual.heart_rate_series) ? actual.heart_rate_series : compactHeartRateSeries(actual.heartRateData),
    route_shape: sanitizeRouteShape(actual.route_shape || actual.routeShape) || compactRouteShape(actual.route),
    route_map: sanitizeRouteMap(actual.route_map || actual.routeMap) || compactRouteMap(actual.route),
    heart_rate_recovery: actual.heart_rate_recovery || actual.heartRateRecoverySummary || computeHeartRateRecovery(actual.heartRateRecovery),
    heart_rate_drift: actual.heart_rate_drift || actual.heartRateDrift || computeHeartRateDrift(actual.heartRateData),
    pace_drift: actual.pace_drift || actual.paceDrift || computePaceDrift(actual.walkingAndRunningDistance),
    elevation_gain: actual.elevation_gain || actual.elevationGain || compactQuantity(actual.elevationUp),
    flights_climbed: numberFromHealthValue(actual.flights_climbed ?? actual.flightsClimbed),
    temperature: actual.temperature ? compactQuantity(actual.temperature) : undefined,
    humidity: actual.humidity ? compactQuantity(actual.humidity) : undefined,
    avg_speed: actual.avg_speed || actual.avgSpeed ? compactSpeedQuantity(actual.avg_speed || actual.avgSpeed) : undefined,
    max_speed: actual.max_speed || actual.maxSpeed ? compactSpeedQuantity(actual.max_speed || actual.maxSpeed) : undefined,
    step_cadence: actual.step_cadence || actual.stepCadence ? compactQuantity(actual.step_cadence || actual.stepCadence) : undefined,
    total_steps: totalSteps,
    avg_steps_per_minute: totalSteps && durationMinutes ? roundTo(totalSteps / durationMinutes, 1) : undefined,
    location: actual.location || "",
    start_date: start || "",
    end_date: actual.end_date || actual.endDate || actual.end || "",
    source: actual.source || "health_auto_export"
  };
}

function dateFromMetricSample(sample) {
  const value = sample.date || sample.start_date || sample.startDate || sample.start || sample.end_date || sample.endDate || "";
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = parseHealthTimestamp(value);
  return parsed ? dateKey(new Date(parsed)) : "";
}

function metricSamplesFromBody(body) {
  if (Array.isArray(body.metrics)) return body.metrics;
  if (body.data && typeof body.data === "object") {
    return Object.entries(body.data)
      .filter(([name]) => !String(name).toLowerCase().includes("workout"))
      .map(([name, data]) => ({ name, data }));
  }
  return [];
}

function arrayFromHealthExportValue(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== "object") return [];
  if (Array.isArray(value.data)) return value.data;
  if (Array.isArray(value.items)) return value.items;
  if (Array.isArray(value.values)) return value.values;
  return Object.values(value).filter((item) => item && typeof item === "object");
}

function aggregateMetric(metricsByDate, date, field, value, mode = "last") {
  if (!date || value === null || value === undefined) return;
  const metric = metricsByDate.get(date) || { metric_id: date, date };
  if (mode === "sum") {
    metric[field] = Number(metric[field] || 0) + Number(value);
  } else if (mode === "avg") {
    const key = `_${field}_samples`;
    const samples = metric[key] || [];
    samples.push(Number(value));
    metric[key] = samples;
    metric[field] = Math.round((samples.reduce((sum, item) => sum + item, 0) / samples.length) * 10) / 10;
  } else {
    metric[field] = value;
  }
  metricsByDate.set(date, metric);
}

function normalizeHealthPayload(body) {
  const actualWorkouts = [
    ...(Array.isArray(body.actual_workouts) ? body.actual_workouts : []),
    ...arrayFromHealthExportValue(body.workouts),
    ...arrayFromHealthExportValue(body.data?.workouts)
  ];
  const normalizedActuals = actualWorkouts
    .map(normalizeActualWorkout)
    .filter((actual) => /^\d{4}-\d{2}-\d{2}$/.test(actual.date));

  const metricsByDate = new Map();
  (Array.isArray(body.daily_metrics) ? body.daily_metrics : []).forEach((metric) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(metric.date || ""))) {
      metricsByDate.set(metric.date, {
        ...metric,
        metric_id: String(metric.metric_id || metric.id || metric.date)
      });
    }
  });

  metricSamplesFromBody(body).forEach((metricGroup) => {
    const name = String(metricGroup.name || metricGroup.type || metricGroup.metric || "").toLowerCase();
    const samples = Array.isArray(metricGroup.data) ? metricGroup.data : Array.isArray(metricGroup.samples) ? metricGroup.samples : [];
    samples.forEach((sample) => {
      const date = dateFromMetricSample(sample);
      const value = numberFromHealthValue(sample.value ?? sample.qty ?? sample.quantity ?? sample.amount ?? sample);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return;
      if (name.includes("step")) aggregateMetric(metricsByDate, date, "steps", value, "sum");
      if (name.includes("resting") && name.includes("heart")) aggregateMetric(metricsByDate, date, "resting_heart_rate", value, "avg");
      if (name.includes("variability") || name.includes("hrv")) aggregateMetric(metricsByDate, date, "hrv_ms", value, "avg");
      if (name.includes("sleep")) aggregateMetric(metricsByDate, date, "sleep_hours", minutesFromDuration(sample.value ?? sample.duration ?? sample) / 60, "sum");
      if (name.includes("active") && name.includes("energy")) aggregateMetric(metricsByDate, date, "active_energy_kcal", value, "sum");
    });
  });

  const normalizedMetrics = Array.from(metricsByDate.values()).map((metric) => {
    const cleaned = { ...metric, metric_id: String(metric.metric_id || metric.id || metric.date || crypto.randomUUID()) };
    Object.keys(cleaned).forEach((key) => {
      if (key.startsWith("_")) delete cleaned[key];
    });
    return cleaned;
  }).filter((metric) => /^\d{4}-\d{2}-\d{2}$/.test(metric.date));

  return { normalizedActuals, normalizedMetrics };
}

function describeHealthPayload(body) {
  const topLevelKeys = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).slice(0, 40) : [];
  const valueShape = (value) => {
    if (Array.isArray(value)) return { type: "array", length: value.length, first_keys: value[0] && typeof value[0] === "object" ? Object.keys(value[0]).slice(0, 20) : [] };
    if (value && typeof value === "object") return { type: "object", keys: Object.keys(value).slice(0, 20) };
    return { type: typeof value };
  };
  const shapes = Object.fromEntries(topLevelKeys.map((key) => [key, valueShape(body[key])]));
  return { top_level_keys: topLevelKeys, shapes };
}

function safeRawDebugPayload(body) {
  const text = JSON.stringify(body);
  return {
    captured_at: nowIso(),
    bytes: Buffer.byteLength(text),
    mode: "full",
    payload: body
  };
}

function redactedRawSample(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      first: value.length ? redactedRawSample(value[0], depth + 1) : null,
      last: value.length > 1 ? redactedRawSample(value[value.length - 1], depth + 1) : null
    };
  }
  const result = {};
  Object.entries(value).slice(0, 80).forEach(([key, item]) => {
    const lowerKey = key.toLowerCase();
    if (["latitude", "longitude"].includes(lowerKey)) {
      result[key] = "[redacted]";
    } else if (depth >= 3 && item && typeof item === "object" && !Array.isArray(item)) {
      result[key] = { type: "object", keys: Object.keys(item).slice(0, 40) };
    } else {
      result[key] = redactedRawSample(item, depth + 1);
    }
  });
  return result;
}

function safeRawSamplePayload(body) {
  const text = JSON.stringify(body);
  return {
    captured_at: nowIso(),
    bytes: Buffer.byteLength(text),
    mode: "sample",
    payload: redactedRawSample(body)
  };
}

function mergeHealth(store, body, source = "manual") {
  const { normalizedActuals, normalizedMetrics } = normalizeHealthPayload(body);
  const importRecord = {
    import_id: crypto.randomUUID(),
    source,
    received_at: nowIso(),
    payload: describeHealthPayload(body),
    normalized_actual_workouts: normalizedActuals.length,
    normalized_daily_metrics: normalizedMetrics.length
  };
  return {
    actual_workouts: upsertById(store.health.actual_workouts || [], normalizedActuals, "actual_id"),
    daily_metrics: upsertById(store.health.daily_metrics || [], normalizedMetrics, "metric_id"),
    imports: [...(store.health.imports || []), importRecord].slice(-20)
  };
}

function completedLogDates(store) {
  const activities = allPlanActivities(store);
  const planActivitiesById = new Map(activities.map((activity) => [activity.activity_id, activity]));
  const manualDates = Object.entries(store.completions || {})
    .filter(([, completion]) => completion && completion.completed)
    .map(([activityId, completion]) => {
      const plannedActivity = planActivitiesById.get(activityId);
      return completion.logged_date || (completion.completed_at || "").slice(0, 10) || plannedActivity?.date;
    });
  const actualDates = activities
    .map((activity) => {
      const actual = actualsForActivity(activity, store)[0];
      return actual?.date || (actual?.start_date || "").slice(0, 10);
    });
  return [...manualDates, ...actualDates].filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")));
}

function daysBetween(startDateKey, endDateKey) {
  const start = new Date(`${startDateKey}T12:00:00`);
  const end = new Date(`${endDateKey}T12:00:00`);
  return Math.max(0, Math.round((end - start) / 86400000));
}

function requiredActivitiesByDate(store) {
  return allPlanActivities(store)
    .filter((activity) => activity.required_or_optional === "required" && /^\d{4}-\d{2}-\d{2}$/.test(activity.date))
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

function missedRequiredActivities(store, today) {
  return requiredActivitiesByDate(store)
    .filter((activity) => activity.date < today)
    .filter((activity) => !activityIsComplete(store, activity));
}

function createMissStreak(store, referenceDate = new Date()) {
  const today = dateKey(referenceDate);
  const required = requiredActivitiesByDate(store);
  const dueRequired = required.filter((activity) => activity.date < today);
  const missed = missedRequiredActivities(store, today);
  const latestMissDate = missed.length ? missed[missed.length - 1].date : null;
  const earliestDueDate = dueRequired.length ? dueRequired[0].date : today;
  const daysWithoutMiss = latestMissDate ? daysBetween(latestMissDate, today) : daysBetween(earliestDueDate, today);

  const weeks = new Map();
  required.forEach((activity) => {
    const key = activity.week_start_date || dateKey(weekStartFor(new Date(`${activity.date}T12:00:00`)));
    if (!weeks.has(key)) weeks.set(key, []);
    weeks.get(key).push(activity);
  });

  const currentWeekStart = dateKey(weekStartFor(referenceDate));
  let weeksWithoutMiss = 0;
  [...weeks.entries()]
    .filter(([weekStart]) => weekStart <= currentWeekStart)
    .sort(([a], [b]) => b.localeCompare(a))
    .some(([, weekActivities]) => {
      const dueInWeek = weekActivities.filter((activity) => activity.date < today);
      if (!dueInWeek.length) return false;
      const weekHasMiss = dueInWeek.some((activity) => !activityIsComplete(store, activity));
      if (weekHasMiss) return true;
      weeksWithoutMiss += 1;
      return false;
    });

  return {
    days_without_miss: daysWithoutMiss,
    weeks_without_miss: weeksWithoutMiss,
    latest_missed_required_date: latestMissDate,
    missed_required_count: missed.length,
    overdue_required_count: missed.length,
    current_week_on_track: !missed.some((activity) => {
      const weekStart = activity.week_start_date || dateKey(weekStartFor(new Date(`${activity.date}T12:00:00`)));
      return weekStart === currentWeekStart;
    })
  };
}

function createStreak(store, referenceDate = new Date()) {
  const completedDates = [...new Set(completedLogDates(store))].sort();
  const completedSet = new Set(completedDates);
  const today = dateKey(referenceDate);
  const yesterday = dateKey(addDays(referenceDate, -1));
  const anchor = completedSet.has(today) ? today : completedSet.has(yesterday) ? yesterday : today;

  let current = 0;
  let cursor = new Date(`${anchor}T12:00:00`);
  while (completedSet.has(dateKey(cursor))) {
    current += 1;
    cursor = addDays(cursor, -1);
  }

  let longest = 0;
  let run = 0;
  let previous = null;
  completedDates.forEach((value) => {
    if (!previous) {
      run = 1;
    } else {
      const expected = dateKey(addDays(new Date(`${previous}T12:00:00`), 1));
      run = value === expected ? run + 1 : 1;
    }
    longest = Math.max(longest, run);
    previous = value;
  });

  return {
    current_streak_days: current,
    longest_streak_days: longest,
    completed_dates: completedDates,
    ...createMissStreak(store, referenceDate)
  };
}

function workoutTypeGroup(value) {
  const type = String(value || "").toLowerCase();
  if (type.includes("run")) return "run";
  if (type.includes("hiking") || type.includes("hike") || type.includes("ruck") || type.includes("weighted_vest")) return "weighted_vest";
  if (type.includes("strength") || type.includes("functional") || type.includes("traditional") || type.includes("lift")) return "lift";
  if (type.includes("other") || type.includes("yard") || type.includes("walk")) return "other";
  if (type.includes("mobility") || type.includes("stretch") || type.includes("yoga")) return "mobility";
  return type || "";
}

function actualWorkoutTypeGroup(actual) {
  const text = [
    actual.type,
    actual.workout_type,
    actual.workoutActivityType,
    actual.name
  ].filter(Boolean).join(" ");
  return workoutTypeGroup(text);
}

function actualDateMatchesActivity(actual, activity) {
  return actual.date === activity.date || (actual.start_date || "").slice(0, 10) === activity.date;
}

function actualTypeCompatibleWithActivity(actual, activity) {
  const activityGroup = workoutTypeGroup(activity.type);
  const actualGroup = actualWorkoutTypeGroup(actual);
  if (!actualGroup) return true;
  if (activityGroup === actualGroup) return true;
  return activity.type === "weighted_vest" && actualGroup === "weighted_vest";
}

function activityTypeFromActual(actual) {
  const group = actualWorkoutTypeGroup(actual);
  if (["run", "weighted_vest", "lift", "mobility", "other"].includes(group)) return group;
  return "other";
}

function titleFromActual(actual) {
  const group = activityTypeFromActual(actual);
  if (group === "weighted_vest") return "Weighted Vest Ruck";
  if (group === "run") return actual.name || "Run";
  if (group === "lift") return actual.name || "Strength Training";
  if (group === "mobility") return actual.name || "Mobility";
  return actual.name || "Other";
}

function activityDraftFromActual(actual, body = {}) {
  return {
    date: body.date || actual.date || (actual.start_date || "").slice(0, 10),
    title: body.title || titleFromActual(actual),
    type: body.type || activityTypeFromActual(actual),
    required_or_optional: body.required_or_optional || "optional",
    target: {
      ...(actual.duration_minutes ? { duration_minutes: actual.duration_minutes } : {}),
      ...(actual.distance_miles ? { distance_miles: actual.distance_miles } : {}),
      notes: body.notes || "Created from imported Health actual."
    },
    equipment: body.equipment || (activityTypeFromActual(actual) === "weighted_vest" ? ["weighted vest"] : []),
    subtasks: []
  };
}

function compatibleSameDayActivitiesForActual(actual, store) {
  return allPlanActivities(store)
    .filter((activity) => actualDateMatchesActivity(actual, activity))
    .filter((activity) => actualTypeCompatibleWithActivity(actual, activity));
}

function actualNaturallyMatchesActivity(actual, activity, store = null) {
  const sameDate = actual.date === activity.date || (actual.start_date || "").slice(0, 10) === activity.date;
  if (!sameDate || !actualTypeCompatibleWithActivity(actual, activity)) return false;
  if (!store) return true;
  const compatible = compatibleSameDayActivitiesForActual(actual, store);
  return compatible[0]?.activity_id === activity.activity_id;
}

function actualNaturalMatchInfo(actual, activity, store = null) {
  const naturalMatch = actualNaturallyMatchesActivity(actual, activity, store);
  if (!naturalMatch || !store) {
    return {
      natural_match: naturalMatch,
      natural_match_multiple: false,
      natural_match_compatible_count: naturalMatch ? 1 : 0
    };
  }

  const compatible = compatibleSameDayActivitiesForActual(actual, store);
  return {
    natural_match: true,
    natural_match_multiple: compatible.length > 1,
    natural_match_compatible_count: compatible.length
  };
}

function actualsForActivity(activity, store) {
  const links = store.actual_links || {};
  return (store.health.actual_workouts || [])
    .filter((actual) => {
      const linkedActivityId = links[actual.actual_id];
      if (linkedActivityId) return linkedActivityId === activity.activity_id;
      return actualNaturallyMatchesActivity(actual, activity, store);
    })
    .map((actual) => {
      const linked = links[actual.actual_id] === activity.activity_id;
      const matchInfo = actualNaturalMatchInfo(actual, activity, store);
      return {
        ...actual,
        linked,
        ...matchInfo
      };
    });
}

function activityIsComplete(store, activity) {
  return Boolean(store.completions?.[activity.activity_id]?.completed) || actualsForActivity(activity, store).length > 0;
}

function actualMatchCandidates(activity, store) {
  const links = store.actual_links || {};
  return (store.health.actual_workouts || [])
    .filter((actual) => actual.date === activity.date || (actual.start_date || "").slice(0, 10) === activity.date)
    .filter((actual) => !links[actual.actual_id] || links[actual.actual_id] === activity.activity_id)
    .sort((a, b) => String(a.start_date || a.date).localeCompare(String(b.start_date || b.date)))
    .map((actual) => {
      const matchInfo = actualNaturalMatchInfo(actual, activity, store);
      return {
        actual_id: actual.actual_id,
        name: actual.name,
        type: actual.type,
        start_date: actual.start_date,
        duration_minutes: actual.duration_minutes,
        distance_miles: actual.distance_miles,
        average_heart_rate: actual.average_heart_rate,
        linked: links[actual.actual_id] === activity.activity_id,
        ...matchInfo
      };
    });
}

function formatCompactQuantity(quantity, fallbackUnits = "") {
  if (!quantity || !Number.isFinite(Number(quantity.qty))) return "";
  return `${quantity.qty}${quantity.units || fallbackUnits ? ` ${quantity.units || fallbackUnits}` : ""}`.trim();
}

function actualDetailLines(actual) {
  const lines = [];
  const overview = [
    actual.distance_miles ? `${roundTo(actual.distance_miles, 2)} mi` : null,
    actual.duration_minutes ? `${roundTo(actual.duration_minutes, 1)} min` : null,
    actual.average_heart_rate ? `avg HR ${roundTo(actual.average_heart_rate, 1)}` : null,
    actual.max_heart_rate ? `max HR ${roundTo(actual.max_heart_rate, 1)}` : null,
    actual.active_energy_kcal ? `${roundTo(actual.active_energy_kcal, 1)} active kcal` : null
  ].filter(Boolean);
  if (overview.length) lines.push(`  Actual: ${overview.join(", ")}`);

  const context = [
    actual.elevation_gain ? `elevation ${formatCompactQuantity(actual.elevation_gain)}` : null,
    actual.temperature ? `temp ${formatCompactQuantity(actual.temperature)}` : null,
    actual.humidity ? `humidity ${formatCompactQuantity(actual.humidity)}` : null,
    actual.step_cadence ? `cadence ${formatCompactQuantity(actual.step_cadence)}` : null,
    actual.total_steps ? `${Math.round(actual.total_steps)} steps` : null
  ].filter(Boolean);
  if (context.length) lines.push(`  Context: ${context.join(", ")}`);

  const trends = [
    actual.heart_rate_recovery?.drop_bpm !== undefined ? `HR recovery ${actual.heart_rate_recovery.drop_bpm} bpm over ${actual.heart_rate_recovery.duration_seconds}s` : null,
    actual.heart_rate_drift?.drift_bpm !== undefined ? `HR drift ${actual.heart_rate_drift.drift_bpm} bpm (${actual.heart_rate_drift.drift_percent}%)` : null,
    actual.pace_drift?.slowdown_percent !== undefined ? `pace drift ${actual.pace_drift.slowdown_percent}%` : null
  ].filter(Boolean);
  if (trends.length) lines.push(`  Trends: ${trends.join(", ")}`);

  return lines;
}

function createCoachSummary(store) {
  const plan = activePlan(store);
  if (!plan) {
    return {
      generated_at: nowIso(),
      goals: store.goals,
      active_plan: null,
      summary_text: "No active plan is available yet."
    };
  }

  const planned_activities = plan.activities.map((activity) => ({
    ...activityWithState(activity, store),
    actuals: actualsForActivity(activity, store)
  }));

  const start = plan.week_start_date;
  const end = weekEndDate(plan);
  const daily_metrics = (store.health.daily_metrics || []).filter((metric) => metric.date >= start && metric.date <= end);
  const completedRequired = planned_activities.filter((activity) => (
    activity.required_or_optional === "required" && activity.completion.completed
  )).length;
  const totalRequired = planned_activities.filter((activity) => activity.required_or_optional === "required").length;
  const runActuals = planned_activities.flatMap((activity) => activity.type === "run" ? activity.actuals : []);
  const totalRunDistance = runActuals.reduce((sum, actual) => sum + Number(actual.distance_miles || actual.distance_km || 0), 0);

  const summaryJson = {
    generated_at: nowIso(),
    goals: store.goals,
    coach_notes: store.coach_notes || "",
    streak: createStreak(store),
    gear: store.gear || [],
    references: store.references || [],
    active_plan: {
      plan_id: plan.plan_id,
      week_start_date: plan.week_start_date,
      week_end_date: end,
      goals: plan.goals
    },
    adherence: {
      completed_required: completedRequired,
      total_required: totalRequired,
      completed_required_percent: totalRequired ? Math.round((completedRequired / totalRequired) * 100) : 0
    },
    planned_activities,
    health: {
      actual_workouts: store.health.actual_workouts || [],
      daily_metrics
    }
  };

  const lines = [
    `Coach summary for ${start} to ${end}`,
    "",
    `Primary goal: ${store.goals.primary || "Not set"}`,
    store.coach_notes ? `Coach notes: ${store.coach_notes}` : "Coach notes: none",
    `Days without a required miss: ${summaryJson.streak.days_without_miss}`,
    `Weeks without a required miss: ${summaryJson.streak.weeks_without_miss}`,
    `Logged workout date streak: ${summaryJson.streak.current_streak_days} day(s)`,
    `Available gear: ${(store.gear || []).filter((item) => item.status === "available").map((item) => item.name).join(", ") || "none recorded"}`,
    `Required sessions completed: ${completedRequired}/${totalRequired}`,
    runActuals.length ? `Logged run actuals: ${runActuals.length} (${totalRunDistance.toFixed(2)} total distance units from import)` : "Logged run actuals: none imported",
    "",
    "Planned work:"
  ];

  planned_activities.forEach((activity) => {
    const status = activity.completion.completed ? "done" : "not done";
    const loggedText = activity.completion.logged_date && activity.completion.logged_date !== activity.date ? `, logged ${activity.completion.logged_date}` : "";
    const feedbackPieces = [];
    const difficulty = activity.feedback?.difficulty ?? activity.feedback?.rpe;
    if (difficulty !== undefined) feedbackPieces.push(`difficulty ${difficulty}`);
    if (activity.feedback?.energy !== undefined) feedbackPieces.push(`energy ${activity.feedback.energy}`);
    if (activity.feedback?.soreness !== undefined) feedbackPieces.push(`soreness ${activity.feedback.soreness}`);
    if (activity.feedback?.back_pain !== undefined) feedbackPieces.push(`back pain ${activity.feedback.back_pain}`);
    const feedback = feedbackPieces.length ? ` | ${feedbackPieces.join(", ")}` : "";
    const activityVolume = Object.values(activity.exercise_logs || {}).reduce((sum, log) => sum + exerciseVolume(log), 0);
    const volume = activityVolume ? ` | total weight moved ${activityVolume} lb` : "";
    lines.push(`- ${activity.date}: ${activity.title} (${activity.type}, ${activity.required_or_optional}) - ${status}${loggedText}${feedback}${volume}`);
    Object.entries(activity.exercise_logs || {}).forEach(([exerciseId, log]) => {
      const total = exerciseVolume(log);
      const duration = formatExerciseDuration(log);
      if (total) lines.push(`  - ${log.title || exerciseId}: ${log.weight_lbs} lb x ${log.sets} x ${log.reps} = ${total} lb`);
      else if (duration) lines.push(`  - ${log.title || exerciseId}: ${duration}`);
    });
    activity.actuals.forEach((actual) => {
      actualDetailLines(actual).forEach((line) => lines.push(line));
      if (Array.isArray(actual.splits) && actual.splits.length) {
        const splitText = actual.splits
          .map((split) => `${split.split}: ${split.pace}${split.distance_miles !== 1 ? ` (${split.distance_miles} mi)` : ""}`)
          .join(", ");
        lines.push(`  Splits: ${splitText}`);
      }
    });
    if (activity.feedback?.notes) lines.push(`  Notes: ${activity.feedback.notes}`);
  });

  const references = store.references || [];
  if (references.length) {
    lines.push("", "References:");
    references.forEach((reference) => {
      lines.push(`- ${reference.reference_id}: ${reference.title}`);
    });
  }

  if (daily_metrics.length) {
    lines.push("", "Recovery metrics:");
    daily_metrics.forEach((metric) => {
      lines.push(`- ${metric.date}: sleep ${metric.sleep_hours ?? "-"}h, RHR ${metric.resting_heart_rate ?? "-"}, HRV ${metric.hrv_ms ?? "-"}, steps ${metric.steps ?? "-"}`);
    });
  }

  return {
    ...summaryJson,
    summary_text: lines.join("\n")
  };
}

function sendJson(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers
  });
  res.end(body);
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function cleanSecret(value) {
  const text = String(value || "").trim();
  if (!text || text === "\"\"" || text === "''") return "";
  return text;
}

function cookieValue(req, name) {
  const cookies = String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const prefix = `${name}=`;
  const cookie = cookies.find((part) => part.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : "";
}

function cookieAttributes(req, maxAge) {
  const secure = originFor(req).startsWith("https://") ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function hasOwnerSession(req) {
  try {
    verifyOwnerSessionToken(cookieValue(req, "coach_loop_session"));
    return true;
  } catch {
    return false;
  }
}

function isAuthorized(req) {
  const expected = cleanSecret(process.env.COACH_LOOP_API_TOKEN);
  if (!expected) return true;
  return bearerToken(req) === expected || hasOwnerSession(req);
}

function requireWriteAuth(req, res) {
  if (isAuthorized(req)) return true;
  sendError(res, 401, "Sign in to Coach Loop to save changes");
  return false;
}

function requireReadAuth(req, res) {
  if (isAuthorized(req)) return true;
  sendError(res, 401, "Sign in to Coach Loop to view your data");
  return false;
}

function isCronAuthorized(req) {
  const secret = cleanSecret(process.env.COACH_LOOP_CRON_SECRET || process.env.CRON_SECRET);
  if (!secret) return true;
  return bearerToken(req) === secret;
}

function originFor(req) {
  const proto = req.headers["x-forwarded-proto"] || (req.headers.host?.startsWith("127.0.0.1") ? "http" : "https");
  const host = req.headers["x-forwarded-host"] || req.headers.host || `127.0.0.1:${PORT}`;
  return `${proto}://${host}`;
}

const MCP_WRITE_TOOLS = new Set([
  "upsert_gear",
  "remove_gear",
  "import_weekly_plan",
  "update_day_plan",
  "link_actual_to_activity",
  "apply_actual_workout",
  "update_goals",
  "patch_goals",
  "update_run_plan",
  "update_coach_notes",
  "mark_activity",
  "save_activity_feedback",
  "save_exercise_log",
  "import_health_actuals"
]);

function mcpRequiredScopes(body) {
  const messages = Array.isArray(body) ? body : [body].filter(Boolean);
  const hasWriteToolCall = messages.some((message) => (
    message?.method === "tools/call" && MCP_WRITE_TOOLS.has(message.params?.name)
  ));
  return hasWriteToolCall ? ["coach:read", "coach:write"] : ["coach:read"];
}

async function handleMcpRequest(req, res) {
  let parsedBody = req.body;
  if (req.method === "POST" && parsedBody === undefined) {
    parsedBody = await readJsonBody(req);
  }

  if (!authorizeMcpRequest(req, res, mcpRequiredScopes(parsedBody))) return;

  if (req.method === "GET") {
    sendJson(
      res,
      405,
      {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Standalone MCP SSE streams are not supported by this hosted endpoint. Use POST."
        },
        id: null
      },
      { allow: "POST, DELETE, OPTIONS" }
    );
    return;
  }

  try {
    const [{ StreamableHTTPServerTransport }, { createCoachLoopMcpServer }] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/streamableHttp.js"),
      import("./mcp/coach-loop-tools.mjs")
    ]);
    const server = createCoachLoopMcpServer({
      apiUrl: process.env.COACH_LOOP_API_URL || originFor(req),
      apiToken: cleanSecret(process.env.COACH_LOOP_API_TOKEN)
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (error) {
    console.error("MCP request failed", error);
    if (!res.headersSent) {
      sendJson(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null
      });
    }
  }
}

function readJsonBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") return Promise.resolve(req.body.trim() ? JSON.parse(req.body) : {});
    if (Buffer.isBuffer(req.body)) {
      const text = req.body.toString("utf8");
      return Promise.resolve(text.trim() ? JSON.parse(text) : {});
    }
    if (typeof req.body === "object") return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > BODY_LIMIT_BYTES) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Request body must be valid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function publicState(store) {
  const plan = activePlan(store);
  return {
    ...store,
    streak: createStreak(store),
    gear: store.gear || [],
    references: store.references || [],
    coach_notes: store.coach_notes || "",
    active_plan: plan ? {
      ...plan,
      activities: plan.activities.map((activity) => activityWithState(activity, store))
    } : null
  };
}

function cleanNumber(value, min, max, field) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${field} must be between ${min} and ${max}`);
  }
  return number;
}

function upsertById(existing, incoming, idField) {
  const map = new Map(existing.map((item) => [item[idField], item]));
  incoming.forEach((item) => {
    const id = item[idField] || crypto.randomUUID();
    map.set(id, { ...map.get(id), ...item, [idField]: id, updated_at: nowIso() });
  });
  return Array.from(map.values());
}

async function handleApi(req, res, pathname) {
  const store = await readStore();

  if (req.method === "GET" && pathname === "/api/session") {
    sendJson(res, 200, {
      authenticated: isAuthorized(req),
      auth_required: Boolean(cleanSecret(process.env.COACH_LOOP_API_TOKEN)),
      method: hasOwnerSession(req) ? "owner_session" : null
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/session/login") {
    const body = await readJsonBody(req);
    const limit = authRateLimit(req, "owner_session");
    if (limit.limited) {
      sendJson(res, 429, { error: "Too many failed attempts. Try again in a few minutes." }, {
        "retry-after": String(limit.retry_after_seconds)
      });
      return;
    }
    if (!verifyOwnerPassword(body.password)) {
      recordAuthFailure(req, "owner_session");
      sendError(res, 401, "That owner password did not match");
      return;
    }
    clearAuthFailures(req, "owner_session");
    const token = createOwnerSessionToken();
    sendJson(
      res,
      200,
      { authenticated: true, method: "owner_session" },
      { "set-cookie": `coach_loop_session=${encodeURIComponent(token)}; ${cookieAttributes(req, ownerSessionTtlSeconds())}` }
    );
    return;
  }

  if (req.method === "POST" && pathname === "/api/session/logout") {
    sendJson(
      res,
      200,
      { authenticated: false },
      { "set-cookie": `coach_loop_session=; ${cookieAttributes(req, 0)}` }
    );
    return;
  }

  if (req.method === "GET" && pathname === "/api/backups") {
    if (!requireWriteAuth(req, res)) return;
    const backups = await listStoreBackups(Number(new URL(req.url, originFor(req)).searchParams.get("limit") || 30));
    sendJson(res, 200, { backups });
    return;
  }

  if (req.method === "POST" && pathname === "/api/backups") {
    if (!requireWriteAuth(req, res)) return;
    const backup = await createStoreBackup(store, "manual");
    sendJson(res, 201, { backup });
    return;
  }

  if (req.method === "GET" && pathname === "/api/backups/create") {
    if (!isCronAuthorized(req)) {
      sendError(res, 401, "Backup cron is not authorized");
      return;
    }
    const backup = await createStoreBackup(store, "scheduled");
    sendJson(res, 201, { backup });
    return;
  }

  const backupRestoreMatch = pathname.match(/^\/api\/backups\/([^/]+)\/restore$/);
  if (req.method === "POST" && backupRestoreMatch) {
    if (!requireWriteAuth(req, res)) return;
    await createStoreBackup(store, "pre-restore");
    const restored = await restoreStoreBackup(decodeURIComponent(backupRestoreMatch[1]));
    sendJson(res, 200, publicState(migrateStore(restored)));
    return;
  }

  if (req.method === "GET" && pathname === "/api/state") {
    if (!requireReadAuth(req, res)) return;
    sendJson(res, 200, publicState(store));
    return;
  }

  if (req.method === "GET" && pathname === "/api/healthz") {
    sendJson(res, 200, {
      ok: true,
      storage: storageMode(),
      auth_required_for_writes: Boolean(cleanSecret(process.env.COACH_LOOP_API_TOKEN)),
      mcp_oauth_required: mcpOAuthRequired()
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/plans/current") {
    if (!requireReadAuth(req, res)) return;
    const plan = activePlan(store);
    sendJson(res, 200, plan ? { ...plan, activities: plan.activities.map((activity) => activityWithState(activity, store)) } : null);
    return;
  }

  if (req.method === "GET" && pathname === "/api/planning-context") {
    if (!requireReadAuth(req, res)) return;
    sendJson(res, 200, {
      goals: store.goals,
      coach_notes: store.coach_notes || "",
      gear: store.gear || [],
      references: store.references || [],
      active_plan: publicState(store).active_plan,
      streak: createStreak(store),
      health_tracking_notes: [
        "Weighted vest workouts are tracked on Apple Watch as Hiking.",
        "Use gear.status to avoid unavailable or limited equipment when generating plans."
      ]
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/gear") {
    if (!requireReadAuth(req, res)) return;
    sendJson(res, 200, store.gear || []);
    return;
  }

  if (req.method === "GET" && pathname === "/api/audit") {
    if (!requireReadAuth(req, res)) return;
    sendJson(res, 200, (store.audit_events || []).slice(-100).reverse());
    return;
  }

  if (req.method === "GET" && pathname === "/api/health/import-status") {
    if (!requireReadAuth(req, res)) return;
    sendJson(res, 200, {
      actual_workouts_count: store.health.actual_workouts?.length || 0,
      daily_metrics_count: store.health.daily_metrics?.length || 0,
      raw_debug: store.health.raw_debug ? {
        captured_at: store.health.raw_debug.captured_at,
        bytes: store.health.raw_debug.bytes
      } : null,
      latest_imports: (store.health.imports || []).slice(-10)
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/health/raw-debug") {
    if (!requireWriteAuth(req, res)) return;
    sendJson(res, 200, store.health.raw_debug || null);
    return;
  }

  if (req.method === "DELETE" && pathname === "/api/health/raw-debug") {
    if (!requireWriteAuth(req, res)) return;
    const nextStore = await updateStore((current) => {
      const health = { ...(current.health || {}) };
      delete health.raw_debug;
      return { ...current, health };
    }, { action: "health.raw_debug.delete", target: "raw_debug" });
    sendJson(res, 200, publicState(nextStore));
    return;
  }

  const healthActualMatch = pathname.match(/^\/api\/health\/actuals\/([^/]+)$/);
  if (req.method === "DELETE" && healthActualMatch) {
    if (!requireWriteAuth(req, res)) return;
    const actualId = decodeURIComponent(healthActualMatch[1]);
    const nextStore = await updateStore((current) => {
      const health = {
        ...(current.health || {}),
        actual_workouts: (current.health.actual_workouts || []).filter((actual) => actual.actual_id !== actualId)
      };
      const actual_links = { ...(current.actual_links || {}) };
      delete actual_links[actualId];
      return { ...current, health, actual_links };
    }, { action: "health.actual.delete", target: actualId });
    sendJson(res, 200, publicState(nextStore));
    return;
  }

  const healthActualApplyMatch = pathname.match(/^\/api\/health\/actuals\/([^/]+)\/apply$/);
  if (req.method === "POST" && healthActualApplyMatch) {
    if (!requireWriteAuth(req, res)) return;
    const actualId = decodeURIComponent(healthActualApplyMatch[1]);
    const body = await readJsonBody(req);
    try {
      const nextStore = await updateStore((current) => {
        const actual = (current.health.actual_workouts || []).find((item) => item.actual_id === actualId);
        if (!actual) throw Object.assign(new Error("Actual workout not found"), { statusCode: 404 });
        const currentPlan = activePlan(current);
        if (!currentPlan) throw Object.assign(new Error("No active plan is available"), { statusCode: 404 });
        const compatible = compatibleSameDayActivitiesForActual(actual, current);
        const selectedActivity = compatible[0];
        let targetActivityId = selectedActivity?.activity_id;
        let plans = current.plans;
        if (!targetActivityId) {
          const sameDateActivities = currentPlan.activities.filter((activity) => activity.date === (body.date || actual.date));
          const activity = normalizeActivityForPlan(
            activityDraftFromActual(actual, body),
            sameDateActivities.length,
            body.date || actual.date
          );
          targetActivityId = activity.activity_id;
          const updatedPlan = {
            ...currentPlan,
            activities: [...currentPlan.activities, activity].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title)),
            updated_at: nowIso()
          };
          plans = current.plans.map((plan) => plan.plan_id === currentPlan.plan_id ? updatedPlan : plan);
        }

        const completions = { ...(current.completions || {}) };
        const feedback = { ...(current.feedback || {}) };
        const exercise_logs = { ...(current.exercise_logs || {}) };
        const clearActivityId = body.clear_activity_id ? String(body.clear_activity_id) : "";
        if (clearActivityId) {
          delete completions[clearActivityId];
          delete feedback[clearActivityId];
          delete exercise_logs[clearActivityId];
        }

        const actual_links = { ...(current.actual_links || {}) };
        Object.entries(actual_links).forEach(([linkedActualId, linkedActivityId]) => {
          if (linkedActualId === actualId || linkedActivityId === targetActivityId || (clearActivityId && linkedActivityId === clearActivityId)) {
            delete actual_links[linkedActualId];
          }
        });
        actual_links[actualId] = targetActivityId;

        return { ...current, plans, completions, feedback, exercise_logs, actual_links };
      }, { action: "actual.apply", target: actualId });
      sendJson(res, 200, publicState(nextStore));
    } catch (error) {
      sendError(res, error.statusCode || 400, error.message || "Unable to apply actual workout");
    }
    return;
  }

  const healthMetricMatch = pathname.match(/^\/api\/health\/metrics\/([^/]+)$/);
  if (req.method === "DELETE" && healthMetricMatch) {
    if (!requireWriteAuth(req, res)) return;
    const metricId = decodeURIComponent(healthMetricMatch[1]);
    const nextStore = await updateStore((current) => {
      const health = {
        ...(current.health || {}),
        daily_metrics: (current.health.daily_metrics || []).filter((metric) => metric.metric_id !== metricId)
      };
      return { ...current, health };
    }, { action: "health.metric.delete", target: metricId });
    sendJson(res, 200, publicState(nextStore));
    return;
  }

  if (req.method === "POST" && pathname === "/api/gear/upsert") {
    if (!requireWriteAuth(req, res)) return;
    const body = await readJsonBody(req);
    const incoming = Array.isArray(body.gear) ? body.gear : Array.isArray(body.items) ? body.items : [body.gear || body.item || body];
    const normalizedIncoming = incoming.map((item) => normalizeGearItem({ ...item, updated_at: nowIso() }));
    const nextStore = await updateStore((current) => {
      const gear = upsertById(current.gear || [], normalizedIncoming, "gear_id");
      return { ...current, gear };
    }, { action: "gear.upsert", target: normalizedIncoming.map((item) => item.gear_id).join(",") });
    sendJson(res, 200, publicState(nextStore));
    return;
  }

  const gearMatch = pathname.match(/^\/api\/gear\/([^/]+)$/);
  if (req.method === "DELETE" && gearMatch) {
    if (!requireWriteAuth(req, res)) return;
    const gearId = decodeURIComponent(gearMatch[1]);
    const nextStore = await updateStore((current) => ({
      ...current,
      gear: (current.gear || []).filter((item) => item.gear_id !== gearId)
    }), { action: "gear.delete", target: gearId });
    sendJson(res, 200, publicState(nextStore));
    return;
  }

  if (req.method === "PUT" && pathname === "/api/goals") {
    if (!requireWriteAuth(req, res)) return;
    const body = await readJsonBody(req);
    const goals = body.goals && typeof body.goals === "object" ? body.goals : body;
    sendJson(res, 200, publicState(await updateStore((current) => ({ ...current, goals }), { action: "goals.update", target: "goals" })));
    return;
  }

  if (req.method === "PATCH" && pathname === "/api/goals") {
    if (!requireWriteAuth(req, res)) return;
    const body = await readJsonBody(req);
    const patch = body.goals && typeof body.goals === "object" ? body.goals : body;
    sendJson(res, 200, publicState(await updateStore((current) => {
      const currentGoals = current.goals || {};
      const nextRunPlan = patch.run_plan && typeof patch.run_plan === "object"
        ? { ...(currentGoals.run_plan || {}), ...patch.run_plan }
        : currentGoals.run_plan;
      const goals = { ...currentGoals, ...patch };
      if (nextRunPlan !== undefined) goals.run_plan = nextRunPlan;
      return { ...current, goals };
    }, { action: "goals.patch", target: "goals" })));
    return;
  }

  if (req.method === "PUT" && pathname === "/api/coach-notes") {
    if (!requireWriteAuth(req, res)) return;
    const body = await readJsonBody(req);
    const coach_notes = String(body.coach_notes ?? body.notes ?? "");
    sendJson(res, 200, publicState(await updateStore((current) => ({ ...current, coach_notes }), { action: "coach_notes.update", target: "coach_notes" })));
    return;
  }

  if (req.method === "POST" && pathname === "/api/plans/import") {
    if (!requireWriteAuth(req, res)) return;
    const body = await readJsonBody(req);
    const incomingPlan = validatePlan(body);
    const nextStore = await updateStore((current) => {
      const existingPlan = current.plans.find((item) => item.plan_id === incomingPlan.plan_id || item.week_start_date === incomingPlan.week_start_date);
      const plan = mergePlanPreservingExisting(existingPlan, incomingPlan);
      const plans = [
        ...current.plans.filter((item) => item.plan_id !== plan.plan_id && item.week_start_date !== plan.week_start_date),
        plan
      ];
      const exercise_logs = clearBlankFallbackExerciseLogs(current.exercise_logs, plan);
      return { ...current, plans, exercise_logs, active_plan_id: plan.plan_id };
    }, { action: "plan.import", target: incomingPlan.week_start_date });
    sendJson(res, 201, publicState(nextStore));
    return;
  }

  const actualLinkMatch = pathname.match(/^\/api\/activities\/([^/]+)\/actual-link$/);
  if (req.method === "POST" && actualLinkMatch) {
    if (!requireWriteAuth(req, res)) return;
    const activityId = decodeURIComponent(actualLinkMatch[1]);
    const body = await readJsonBody(req);
    const actualId = body.actual_id ? String(body.actual_id) : "";
    try {
      const nextStore = await updateStore((current) => {
        const plan = activePlan(current);
        const activity = plan?.activities.find((item) => item.activity_id === activityId);
        if (!activity) throw Object.assign(new Error("Activity not found"), { statusCode: 404 });
        const actualLinks = { ...(current.actual_links || {}) };
        Object.entries(actualLinks).forEach(([linkedActualId, linkedActivityId]) => {
          if (linkedActivityId === activityId) delete actualLinks[linkedActualId];
        });
        if (actualId) {
          const actual = (current.health.actual_workouts || []).find((item) => item.actual_id === actualId);
          if (!actual) throw Object.assign(new Error("Actual workout not found"), { statusCode: 404 });
          actualLinks[actualId] = activityId;
        }
        return { ...current, actual_links: actualLinks };
      }, { action: actualId ? "actual.link" : "actual.unlink", target: `${activityId}:${actualId || "auto"}` });
      sendJson(res, 200, publicState(nextStore));
    } catch (error) {
      sendError(res, error.statusCode || 400, error.message || "Unable to link actual");
      return;
    }
    return;
  }

  const dayPlanMatch = pathname.match(/^\/api\/plans\/current\/days\/(\d{4}-\d{2}-\d{2})$/);
  if ((req.method === "PUT" || req.method === "PATCH") && dayPlanMatch) {
    if (!requireWriteAuth(req, res)) return;
    const date = dayPlanMatch[1];
    const plan = activePlan(store);
    if (!plan) {
      sendError(res, 404, "No active plan is available");
      return;
    }
    const body = await readJsonBody(req);
    const incomingActivities = Array.isArray(body.activities) ? body.activities : [];
    const normalizedActivities = assertUniqueActivityIds(incomingActivities.map((activity, index) =>
      validateDetailedPlanActivity(normalizeActivityForPlan({ ...activity, date }, index, date), index)
    ));
    assertActivityDatesWithinWeek(normalizedActivities, plan.week_start_date);
    const nextStore = await updateStore((current) => {
      const currentPlan = activePlan(current);
      if (!currentPlan) throw Object.assign(new Error("No active plan is available"), { statusCode: 404 });
      const previousActivitiesForDate = currentPlan.activities.filter((activity) => activity.date === date);
      const removedActivityIds = previousActivitiesForDate
        .map((activity) => activity.activity_id)
        .filter((activityId) => !normalizedActivities.some((activity) => activity.activity_id === activityId));
      const removed = new Set(removedActivityIds);
      const updatedPlan = {
        ...currentPlan,
        // Re-check across the whole week: a replacement day can reuse the ID of
        // an activity that lives on an untouched date.
        activities: assertUniqueActivityIds([
          ...currentPlan.activities.filter((activity) => activity.date !== date),
          ...normalizedActivities
        ].sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title))),
        updated_at: nowIso()
      };
      const plans = current.plans.map((item) => item.plan_id === currentPlan.plan_id ? updatedPlan : item);
      const completions = { ...(current.completions || {}) };
      const feedback = { ...(current.feedback || {}) };
      const exercise_logs = { ...(current.exercise_logs || {}) };
      const actual_links = Object.fromEntries(
        Object.entries(current.actual_links || {}).filter(([, linkedActivityId]) => !removed.has(linkedActivityId))
      );
      removedActivityIds.forEach((activityId) => {
        delete completions[activityId];
        delete feedback[activityId];
        delete exercise_logs[activityId];
      });
      return {
        ...current,
        plans,
        completions,
        feedback,
        exercise_logs: clearBlankFallbackExerciseLogs(exercise_logs, updatedPlan),
        actual_links
      };
    }, { action: "plan.day.update", target: date });
    sendJson(res, 200, publicState(nextStore));
    return;
  }

  const activityMatch = pathname.match(/^\/api\/activities\/([^/]+)$/);
  if (req.method === "PATCH" && activityMatch) {
    if (!requireWriteAuth(req, res)) return;
    const activityId = decodeURIComponent(activityMatch[1]);
    const body = await readJsonBody(req);
    const loggedDate = body.completed ? (optionalDateKey(body.logged_date, "logged_date") || dateKey(new Date())) : null;
    const nextStore = await updateStore((currentStore) => {
      const current = currentStore.completions[activityId] || { subtasks: {} };
      const next = {
        ...current,
        subtasks: { ...(current.subtasks || {}) },
        updated_at: nowIso()
      };
      if (!body.subtask_id && typeof body.completed === "boolean") {
        next.completed = body.completed;
        next.completed_at = body.completed ? nowIso() : null;
        next.logged_date = loggedDate;
      }
      if (body.subtasks && typeof body.subtasks === "object") {
        Object.entries(body.subtasks).forEach(([subtaskId, completed]) => {
          next.subtasks[subtaskId] = Boolean(completed);
        });
      }
      if (body.subtask_id) {
        next.subtasks[String(body.subtask_id)] = Boolean(body.completed);
      }
      return {
        ...currentStore,
        completions: { ...currentStore.completions, [activityId]: next }
      };
    }, { action: "activity.mark", target: activityId });
    sendJson(res, 200, publicState(nextStore));
    return;
  }

  const feedbackMatch = pathname.match(/^\/api\/activities\/([^/]+)\/feedback$/);
  if (req.method === "POST" && feedbackMatch) {
    if (!requireWriteAuth(req, res)) return;
    const activityId = decodeURIComponent(feedbackMatch[1]);
    const body = await readJsonBody(req);
    const feedback = {
      ...(store.feedback[activityId] || {}),
      difficulty: cleanNumber(body.difficulty ?? body.rpe, 1, 10, "difficulty"),
      energy: cleanNumber(body.energy, 1, 5, "energy"),
      soreness: cleanNumber(body.soreness, 1, 5, "soreness"),
      back_pain: cleanNumber(body.back_pain, 0, 10, "back_pain"),
      notes: body.notes ? String(body.notes) : "",
      updated_at: nowIso()
    };
    Object.keys(feedback).forEach((key) => feedback[key] === undefined && delete feedback[key]);
    const nextStore = await updateStore((current) => ({
      ...current,
      feedback: { ...current.feedback, [activityId]: { ...(current.feedback[activityId] || {}), ...feedback } }
    }), { action: "activity.feedback.save", target: activityId });
    sendJson(res, 200, publicState(nextStore));
    return;
  }

  const exerciseLogMatch = pathname.match(/^\/api\/activities\/([^/]+)\/exercise-log$/);
  if (req.method === "POST" && exerciseLogMatch) {
    if (!requireWriteAuth(req, res)) return;
    const activityId = decodeURIComponent(exerciseLogMatch[1]);
    const body = await readJsonBody(req);
    const exerciseId = String(body.exercise_id || body.subtask_id || "activity");
    const log = {
      exercise_id: exerciseId,
      title: String(body.title || exerciseId),
      weight_lbs: cleanOptionalNumber(body.weight_lbs ?? body.weight, 0, 2000, "weight_lbs"),
      sets: cleanOptionalNumber(body.sets, 0, 200, "sets"),
      reps: cleanOptionalNumber(body.reps, 0, 1000, "reps"),
      duration_seconds: cleanOptionalNumber(body.duration_seconds ?? body.seconds, 0, 86400, "duration_seconds"),
      updated_at: nowIso()
    };
    log.total_weight_lbs = exerciseVolume(log);
    const nextStore = await updateStore((current) => {
      const activityLogs = {
        ...(current.exercise_logs?.[activityId] || {}),
        [exerciseId]: log
      };
      return {
        ...current,
        exercise_logs: {
          ...(current.exercise_logs || {}),
          [activityId]: activityLogs
        }
      };
    }, { action: "exercise_log.save", target: `${activityId}:${exerciseId}` });
    sendJson(res, 200, publicState(nextStore));
    return;
  }

  if (req.method === "POST" && pathname === "/api/health/import") {
    if (!requireWriteAuth(req, res)) return;
    const body = await readJsonBody(req);
    const nextStore = await updateStore((current) => ({
      ...current,
      health: mergeHealth(current, body, "manual")
    }), { action: "health.import", target: "manual" });
    sendJson(res, 200, publicState(nextStore));
    return;
  }

  if (req.method === "POST" && pathname === "/api/health/auto-export") {
    if (!requireWriteAuth(req, res)) return;
    const body = await readJsonBody(req);
    const requestUrl = new URL(req.url, originFor(req));
    const rawDebugMode = requestUrl.searchParams.get("debug_raw");
    const nextStore = await updateStore((current) => ({
      ...current,
      health: {
        ...mergeHealth(current, body, "health_auto_export"),
        ...(rawDebugMode === "1" ? { raw_debug: safeRawDebugPayload(body) } : {}),
        ...(rawDebugMode === "sample" ? { raw_debug: safeRawSamplePayload(body) } : {})
      }
    }), { action: "health.auto_export", target: rawDebugMode ? `debug_${rawDebugMode}` : "default" });
    sendJson(res, 200, publicState(nextStore));
    return;
  }

  if (req.method === "GET" && pathname === "/api/coach-summary") {
    if (!requireReadAuth(req, res)) return;
    sendJson(res, 200, createCoachSummary(store));
    return;
  }

  sendError(res, 404, "API route not found");
}

function serveStatic(res, pathname) {
  const relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const requestedPath = path.normalize(path.join(ROOT, relativePath));
  if (!requestedPath.startsWith(ROOT)) {
    sendError(res, 403, "Forbidden");
    return;
  }
  fs.readFile(requestedPath, (error, content) => {
    if (error) {
      if (!path.extname(requestedPath)) {
        serveStatic(res, "/");
        return;
      }
      sendError(res, 404, "File not found");
      return;
    }
    const ext = path.extname(requestedPath).toLowerCase();
    res.writeHead(200, { "content-type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(content);
  });
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-methods": "GET,POST,PUT,PATCH,OPTIONS",
        "access-control-allow-headers": "content-type, authorization, mcp-session-id"
      });
      res.end();
      return;
    }
    if (url.pathname === "/.well-known/oauth-protected-resource") {
      sendProtectedResourceMetadata(req, res);
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      sendAuthorizationServerMetadata(req, res);
      return;
    }
    if (url.pathname === "/.well-known/openid-configuration") {
      sendAuthorizationServerMetadata(req, res);
      return;
    }
    if (url.pathname === "/oauth/register") {
      await handleClientRegistration(req, res);
      return;
    }
    if (url.pathname === "/oauth/authorize") {
      await handleAuthorize(req, res);
      return;
    }
    if (url.pathname === "/oauth/token") {
      await handleToken(req, res);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }
    if (url.pathname === "/mcp") {
      await handleMcpRequest(req, res);
      return;
    }
    serveStatic(res, url.pathname);
  } catch (error) {
    sendError(res, 400, error.message || "Bad request");
  }
}

function startServer(port = PORT) {
  const server = http.createServer(handleRequest);
  server.listen(port, () => {
    const address = server.address();
    const actualPort = typeof address === "object" && address ? address.port : port;
    console.log(`Coach Loop running at http://127.0.0.1:${actualPort}`);
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = {
  buildDefaultPlan,
  createCoachSummary,
  createDefaultState,
  createStreak,
  handleRequest,
  startServer,
  validatePlan
};
