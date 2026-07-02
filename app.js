const state = {
  data: null,
  activeView: "today-view",
  todayOverrideActivityId: null,
  writeAccess: false
};

const elements = {
  backendStatus: document.querySelector("#backend-status"),
  writeAccessButton: document.querySelector("#write-access-button"),
  dateLabel: document.querySelector("#date-label"),
  goalSummary: document.querySelector("#goal-summary"),
  metricRequired: document.querySelector("#metric-required"),
  metricRuns: document.querySelector("#metric-runs"),
  metricStreak: document.querySelector("#metric-streak"),
  metricWeek: document.querySelector("#metric-week"),
  tabButtons: [...document.querySelectorAll(".tab-button")],
  views: [...document.querySelectorAll(".view")],
  refreshButton: document.querySelector("#refresh-button"),
  todaySwitchForm: document.querySelector("#today-switch-form"),
  todaySwitchSelect: document.querySelector("#today-switch-select"),
  clearSwitchButton: document.querySelector("#clear-switch-button"),
  todayList: document.querySelector("#today-list"),
  weekGrid: document.querySelector("#week-grid"),
  runDashboard: document.querySelector("#run-dashboard"),
  runHistory: document.querySelector("#run-history"),
  libraryGrid: document.querySelector("#library-grid"),
  activityTemplate: document.querySelector("#activity-template"),
  planImportForm: document.querySelector("#plan-import-form"),
  planJson: document.querySelector("#plan-json"),
  goalsForm: document.querySelector("#goals-form"),
  goalPrimary: document.querySelector("#goal-primary"),
  goalRaceDate: document.querySelector("#goal-race-date"),
  goalRunFrequency: document.querySelector("#goal-run-frequency"),
  goalStrengthFocus: document.querySelector("#goal-strength-focus"),
  goalBackHealth: document.querySelector("#goal-back-health"),
  goalRecovery: document.querySelector("#goal-recovery"),
  coachNotesForm: document.querySelector("#coach-notes-form"),
  coachNotes: document.querySelector("#coach-notes"),
  actualsForm: document.querySelector("#actuals-form"),
  actualsJson: document.querySelector("#actuals-json"),
  actualsList: document.querySelector("#actuals-list"),
  gearGrid: document.querySelector("#gear-grid"),
  gearForm: document.querySelector("#gear-form"),
  gearJson: document.querySelector("#gear-json"),
  coachSummary: document.querySelector("#coach-summary"),
  copySummaryButton: document.querySelector("#copy-summary-button"),
  unlockModal: document.querySelector("#unlock-modal"),
  unlockForm: document.querySelector("#unlock-form"),
  unlockPassword: document.querySelector("#unlock-password"),
  unlockError: document.querySelector("#unlock-error"),
  unlockCancel: document.querySelector("#unlock-cancel"),
  message: document.querySelector("#message")
};

let unlockResolver = null;
const EXERCISE_DRAFT_PREFIX = "coach_loop_exercise_log_draft:";
const activeAutosaveFlushers = new Set();

const movementCatalog = [
  {
    match: /split squat|atg split/i,
    title: "Split squat",
    description: "A loaded or bodyweight single-leg pattern for hip, knee, and ankle range. Keep the movement controlled, use support as needed, and treat it as quality range work rather than a max-effort lift.",
    videoId: "qfpkwZlG-cs",
    alternatives: ["ATG split squat", "Split squat stretch", "Supported split squat", "Rear-foot elevated split squat"]
  },
  {
    match: /couch stretch/i,
    title: "Couch stretch",
    description: "A hip-flexor and quad mobility drill that supports stride mechanics and back-friendly posture. Start gently and keep the ribs stacked instead of arching through the low back.",
    videoId: "7bW0dBwB7Dc",
    alternatives: ["Couch stretch", "Active couch stretch", "Hip flexor stretch"]
  },
  {
    match: /bird dog/i,
    title: "Bird dog",
    description: "A low-back-friendly trunk control drill. Move slowly, keep the pelvis quiet, and prioritize crisp reps over range.",
    videoId: "",
    alternatives: ["Bird dog", "Dead bug", "McGill curl-up", "Side plank"]
  },
  {
    match: /backward walk|sled/i,
    title: "Backward walk or sled",
    description: "A knee- and lower-body warmup that can build quad and tendon capacity with low joint impact. Keep steps smooth and posture tall.",
    videoId: "",
    alternatives: ["Backward walk", "Backward sled", "Treadmill backward walk", "Bike warmup"]
  },
  {
    match: /hip hinge|deadlift|rdl/i,
    title: "Hip hinge",
    description: "A posterior-chain strength pattern. The key is moving from the hips with a stable trunk, not chasing depth through the back.",
    videoId: "",
    alternatives: ["Hip hinge", "Romanian deadlift", "Kettlebell deadlift", "Cable pull-through"]
  },
  {
    match: /calf raise/i,
    title: "Calf raise",
    description: "A lower-leg strength drill that supports running durability. Use full control at the top and bottom rather than bouncing.",
    videoId: "",
    alternatives: ["Calf raise", "Single-leg calf raise", "Seated calf raise"]
  },
  {
    match: /curl|biceps|hammer/i,
    title: "Curl",
    description: "An arm-growth accessory. Keep the shoulder quiet, control the lowering phase, and choose a load that lets the target muscle do the work.",
    videoId: "",
    alternatives: ["Curl", "Dumbbell curl", "Barbell curl", "EZ-bar curl", "Hammer curl", "Incline dumbbell curl"]
  },
  {
    match: /press|bench|triceps|extension/i,
    title: "Pressing or triceps work",
    description: "Upper-body strength work. Keep the setup stable and avoid turning accessory work into a back-extension exercise.",
    videoId: "",
    alternatives: ["Bench press", "Dumbbell bench press", "Incline press", "Push-up", "Overhead press", "Triceps pressdown", "Overhead triceps extension"]
  },
  {
    match: /row|pull|chin|pull-up/i,
    title: "Pulling work",
    description: "Back and arm strength work. Keep the torso supported when possible and finish reps with control rather than momentum.",
    videoId: "",
    alternatives: ["Chest-supported row", "Dumbbell row", "Cable row", "Lat pulldown", "Pull-up", "Chin-up"]
  },
  {
    match: /run|warmup|cooldown|interval|tempo/i,
    title: "Run session",
    description: "A running workout in the half-marathon build. The critical movement is relaxed, repeatable mechanics: easy effort on easy days, controlled effort on quality days, and restraint on long runs.",
    videoId: ""
  }
];

function formatDate(value, options = {}) {
  if (!value) return "-";
  const date = new Date(`${value}T12:00:00`);
  return new Intl.DateTimeFormat(undefined, {
    weekday: options.weekday || "short",
    month: "short",
    day: "numeric"
  }).format(date);
}

function todayKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function dateKeyFromDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00`);
  date.setDate(date.getDate() + days);
  return dateKeyFromDate(date);
}

function updateWriteAccessUi() {
  elements.writeAccessButton.textContent = state.writeAccess ? "Saves unlocked" : "Unlock saves";
  elements.writeAccessButton.classList.toggle("is-active", state.writeAccess);
  elements.writeAccessButton.title = state.writeAccess
    ? "This browser has an active Coach Loop owner session."
    : "Unlock saves with your Coach Loop owner password.";
}

async function refreshWriteSession() {
  const session = await api("/api/session");
  state.writeAccess = Boolean(session.authenticated);
  updateWriteAccessUi();
}

async function requestWriteAccess() {
  if (state.writeAccess) return true;
  elements.unlockError.textContent = "";
  elements.unlockPassword.value = "";
  elements.unlockModal.hidden = false;
  window.setTimeout(() => elements.unlockPassword.focus(), 0);
  return new Promise((resolve) => {
    unlockResolver = resolve;
  });
}

function closeUnlockModal(success = false) {
  elements.unlockModal.hidden = true;
  elements.unlockPassword.value = "";
  if (unlockResolver) unlockResolver(success);
  unlockResolver = null;
}

async function submitUnlockPassword(password) {
  const response = await fetch("/api/session/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Unable to unlock saves");
  state.writeAccess = true;
  updateWriteAccessUi();
  setMessage("Saves unlocked.");
  return true;
}

async function lockWriteAccess(message = "Saves locked.", isError = false) {
  try {
    await fetch("/api/session/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
  } finally {
    state.writeAccess = false;
    updateWriteAccessUi();
    setMessage(message, isError);
  }
}

async function api(path, options = {}) {
  const { headers = {}, ...fetchOptions } = options;
  const method = String(fetchOptions.method || "GET").toUpperCase();
  const isWrite = !["GET", "HEAD"].includes(method);
  if (isWrite && !state.writeAccess) {
    const unlocked = await requestWriteAccess();
    if (!unlocked) throw new Error("Saves are locked.");
  }
  const response = await fetch(path, {
    ...fetchOptions,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...headers
    }
  });
  const payload = await response.json();
  if (response.status === 401 && isWrite) {
    state.writeAccess = false;
    updateWriteAccessUi();
    setMessage("Your save session expired. Unlock saves and retry.", true);
  }
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

function setMessage(message, isError = false) {
  elements.message.textContent = message;
  elements.message.classList.toggle("is-error", isError);
  if (message) {
    window.clearTimeout(setMessage.timer);
    setMessage.timer = window.setTimeout(() => {
      elements.message.textContent = "";
      elements.message.classList.remove("is-error");
    }, 4500);
  }
}

function setBackendStatus(connected) {
  elements.backendStatus.classList.toggle("is-connected", connected);
  elements.backendStatus.lastChild.textContent = connected ? " Connected" : " Offline";
}

function activePlan() {
  return state.data?.active_plan || null;
}

function activities() {
  return activePlan()?.activities || [];
}

function summarizeGoals(goals) {
  if (!goals) return "No goals set yet.";
  const pieces = [
    goals.primary,
    goals.run_frequency_per_week ? `${goals.run_frequency_per_week} runs/week` : null,
    Array.isArray(goals.strength_focus) ? goals.strength_focus.join(", ") : goals.strength_focus,
    goals.back_health
  ].filter(Boolean);
  return pieces.join(" · ");
}

function updateOverview() {
  const plan = activePlan();
  const items = activities();
  const required = items.filter((activity) => activity.required_or_optional === "required");
  const completed = required.filter((activity) => activity.completion?.completed);
  const runs = items.filter((activity) => activity.type === "run");

  elements.dateLabel.textContent = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric"
  }).format(new Date());
  elements.goalSummary.textContent = summarizeGoals(state.data?.goals);
  elements.metricRequired.textContent = `${completed.length}/${required.length}`;
  elements.metricRuns.textContent = String(runs.length);
  elements.metricStreak.textContent = String(state.data?.streak?.days_without_miss || 0);
  elements.metricWeek.textContent = String(state.data?.streak?.weeks_without_miss || 0);
}

function activityDescription(activity) {
  const target = activity.target || {};
  const pieces = [
    target.distance_miles ? `${target.distance_miles} mi` : null,
    target.distance_km ? `${target.distance_km} km` : null,
    target.duration_minutes ? `${target.duration_minutes} min` : null,
    target.intensity,
    target.notes || activity.notes
  ].filter(Boolean);
  return pieces.join(" · ");
}

function youtubeSearchUrl(query) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${query} exercise form`)}`;
}

function movementReference(title) {
  return movementCatalog.find((item) => item.match.test(title)) || {
    title,
    description: "Use controlled reps, a setup that respects your back, and a load or pace that matches the day’s intent.",
    videoId: "",
    alternatives: [title]
  };
}

function baseExerciseTitle(title) {
  return String(title || "")
    .split(/\s+[—-]\s+/)[0]
    .replace(/\b\d+\s*[xX]\s*\d+.*$/g, "")
    .replace(/\b\d+\s*(min|minute|minutes|sec|second|seconds)\b.*$/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedExerciseKey(title) {
  const reference = movementReference(title);
  return reference.title.toLowerCase();
}

function subtaskIsNote(subtask) {
  const kind = String(subtask.kind || subtask.type || "").toLowerCase();
  const title = String(subtask.title || "");
  return kind === "note" || /^timer\s*:/i.test(title) || /^note\s*:/i.test(title);
}

function exerciseSupportsDuration(title) {
  return /\b(timer|hold|stretch|plank|walk|warmup|warm-up|cooldown|cool-down|reset|circuit|breathing|mobility|sec|second|seconds|min|minute|minutes)\b/i.test(title);
}

function formatDuration(seconds) {
  const value = Number(seconds || 0);
  if (!value) return "";
  return value % 60 === 0 ? `${value / 60} min` : `${value} sec`;
}

function movementOptions(title) {
  const base = baseExerciseTitle(title);
  const reference = movementReference(title);
  return [...new Set([base, ...(reference.alternatives || []), reference.title].filter(Boolean))];
}

function lastExerciseLogFor(activity, exercise) {
  const key = normalizedExerciseKey(exercise.title);
  return activities()
    .filter((item) => item.activity_id !== activity.activity_id && item.date <= activity.date)
    .flatMap((item) => Object.values(item.exercise_logs || {}).map((log) => ({ ...log, date: item.date })))
    .filter((log) => Number(log.weight_lbs || 0) && normalizedExerciseKey(log.title) === key)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(b.updated_at || "").localeCompare(String(a.updated_at || "")))[0] || null;
}

function lastExerciseLogText(log) {
  if (!log) return "";
  const pieces = [
    `${compactNumber(log.weight_lbs, 1)} lb`,
    log.sets ? `${log.sets} sets` : null,
    log.reps ? `${log.reps} reps` : null
  ].filter(Boolean);
  return pieces.length ? `Last: ${pieces.join(" · ")}` : "";
}

function workoutLibraryDescription(activity) {
  const title = String(activity.title || "").toLowerCase();
  const type = String(activity.type || "").toLowerCase();
  if (type === "run" && title.includes("long")) {
    return "The long run is the anchor workout for the half-marathon build. Keep the effort easy enough to finish feeling like you could continue, and use the imported HR, pace, and splits afterward to check whether endurance is building without excess strain.";
  }
  if (type === "run" && title.includes("quality")) {
    return "The quality run adds controlled faster work without turning the week into a race. The goal is to touch speed or hills while keeping form relaxed and recovery intact for the next run.";
  }
  if (type === "run") {
    return "Easy runs build aerobic volume and running durability. The useful signal is consistency: distance completed, conversational effort, stable heart rate, and no back flare afterward.";
  }
  if (type === "lift" && title.includes("lower")) {
    return "Lower-body maintenance keeps strength and tissue capacity online while the running volume grows. Keep it crisp and submaximal so it supports the half-marathon goal instead of competing with it.";
  }
  if (type === "lift" && (title.includes("upper") || title.includes("arms"))) {
    return "Upper-body and arm work gives you strength and hypertrophy stimulus with limited interference to running. Use stable positions, controlled tempo, and stop short of reps that make your back compensate.";
  }
  if (title.includes("back")) {
    return "Back-health work is there to keep movement quality high and symptoms quiet. Treat it as daily capacity practice: controlled, repeatable, and never forced through pain.";
  }
  return "This workout supports the broader plan by filling a specific role in the week. Use the target, equipment, and key movements below to understand what matters most before you start.";
}

function uniqueWorkoutLibraryItems() {
  const map = new Map();
  activities().forEach((activity) => {
    const key = `${activity.type}:${activity.title}`.toLowerCase();
    const existing = map.get(key);
    const subtasks = activity.subtasks || [];
    if (!existing) {
      map.set(key, {
        ...activity,
        dates: [activity.date],
        subtasks: [...subtasks]
      });
      return;
    }
    existing.dates.push(activity.date);
    subtasks.forEach((subtask) => {
      if (!existing.subtasks.some((item) => item.title === subtask.title)) existing.subtasks.push(subtask);
    });
  });
  return [...map.values()].sort((a, b) => a.type.localeCompare(b.type) || a.title.localeCompare(b.title));
}

function compactNumber(value, decimals = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Number(number.toFixed(decimals)).toLocaleString();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function average(values) {
  const usable = values.map(Number).filter(Number.isFinite);
  if (!usable.length) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function dateDaysApart(start, end) {
  const startDate = new Date(`${start}T12:00:00`);
  const endDate = new Date(`${end}T12:00:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return 0;
  return Math.round((endDate - startDate) / 86400000);
}

function formatPaceFromActual(actual) {
  const distance = Number(actual?.distance_miles || 0);
  const duration = Number(actual?.duration_minutes || 0);
  if (!distance || !duration) return null;
  const paceMinutes = duration / distance;
  const minutes = Math.floor(paceMinutes);
  const seconds = Math.round((paceMinutes - minutes) * 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}/mi`;
}

function compactQuantity(quantity) {
  if (!quantity || quantity.qty === undefined || quantity.qty === null) return null;
  const value = compactNumber(quantity.qty, 2);
  return value ? `${value}${quantity.units ? ` ${quantity.units}` : ""}` : null;
}

function exerciseLogTotal(log) {
  const weight = Number(log?.weight_lbs || 0);
  const sets = Number(log?.sets || 0);
  const reps = Number(log?.reps || 0);
  return weight && sets && reps ? weight * sets * reps : 0;
}

function activityUsesExerciseVolume(activity) {
  return ["lift", "strength"].includes(String(activity.type || "").toLowerCase());
}

function exerciseLogSignature(payload) {
  return JSON.stringify({
    title: String(payload.title ?? ""),
    weight_lbs: String(payload.weight_lbs ?? ""),
    sets: String(payload.sets ?? ""),
    reps: String(payload.reps ?? ""),
    duration_seconds: String(payload.duration_seconds ?? "")
  });
}

function exerciseDraftKey(activityId, exerciseId) {
  return `${EXERCISE_DRAFT_PREFIX}${activityId}:${exerciseId}`;
}

function readExerciseDraft(activityId, exerciseId) {
  try {
    const raw = window.localStorage.getItem(exerciseDraftKey(activityId, exerciseId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeExerciseDraft(activityId, payload) {
  try {
    window.localStorage.setItem(exerciseDraftKey(activityId, payload.exercise_id), JSON.stringify(payload));
  } catch {
    // Drafting is a fallback for flaky mobile saves; failed storage should not block entry.
  }
}

function clearExerciseDraft(activityId, exerciseId) {
  try {
    window.localStorage.removeItem(exerciseDraftKey(activityId, exerciseId));
  } catch {
    // Ignore local storage cleanup failures.
  }
}

function feedbackSignature(payload) {
  return JSON.stringify({
    difficulty: payload.difficulty ?? "",
    back_pain: payload.back_pain ?? ""
  });
}

function setAutosaveStatus(status, text, className = "") {
  status.textContent = text;
  status.className = `autosave-status${className ? ` ${className}` : ""}`;
}

function createExerciseNumberField(exercise, name, labelText, options = {}) {
  const label = document.createElement("label");
  label.textContent = labelText;
  if (options.title) label.title = options.title;

  const input = document.createElement("input");
  input.name = name;
  input.type = "number";
  input.min = "0";
  input.step = options.step || "1";
  input.inputMode = options.inputMode || "numeric";
  if (options.placeholder) input.placeholder = options.placeholder;
  input.setAttribute("aria-label", options.ariaLabel);
  input.value = options.value ?? "";
  label.append(input);

  return { label, input };
}

function createExerciseLogControls(activity, exercise, log = {}) {
  const selectedTitle = log.title || exercise.title;
  const swapLabel = document.createElement("label");
  swapLabel.className = "exercise-swap-label";
  swapLabel.textContent = "exercise";
  const swap = document.createElement("select");
  swap.name = "title";
  movementOptions(selectedTitle).forEach((optionTitle) => {
    const option = document.createElement("option");
    option.value = optionTitle;
    option.textContent = optionTitle;
    option.selected = optionTitle === selectedTitle;
    swap.append(option);
  });
  if (![...swap.options].some((option) => option.value === selectedTitle)) {
    const option = document.createElement("option");
    option.value = selectedTitle;
    option.textContent = selectedTitle;
    option.selected = true;
    swap.prepend(option);
  }
  swapLabel.append(swap);

  const weight = createExerciseNumberField(exercise, "weight_lbs", "total lb", {
    title: "Total weight used per rep, including both sides or both dumbbells.",
    step: "0.5",
    inputMode: "decimal",
    placeholder: "lb",
    ariaLabel: `Total weight used in pounds for ${selectedTitle}`,
    value: log.weight_lbs
  });
  const sets = createExerciseNumberField(exercise, "sets", "sets", {
    ariaLabel: `Sets for ${selectedTitle}`,
    value: log.sets
  });
  const reps = createExerciseNumberField(exercise, "reps", "reps", {
    ariaLabel: `Reps per set for ${selectedTitle}`,
    value: log.reps
  });
  const duration = createExerciseNumberField(exercise, "duration_seconds", "time sec", {
    ariaLabel: `Time in seconds for ${selectedTitle}`,
    value: log.duration_seconds
  });
  duration.label.classList.add("duration-field");

  const total = document.createElement("output");
  total.className = "exercise-total";
  total.title = "Total weight moved: total weight x sets x reps.";

  const last = document.createElement("span");
  last.className = "exercise-last";
  last.textContent = lastExerciseLogText(lastExerciseLogFor(activity, { ...exercise, title: selectedTitle }));

  const status = document.createElement("span");
  setAutosaveStatus(status, "Autosaves");

  function payload() {
    return {
      exercise_id: exercise.exercise_id,
      title: swap.value || selectedTitle,
      weight_lbs: weight.input.value,
      sets: sets.input.value,
      reps: reps.input.value,
      duration_seconds: duration.input.value
    };
  }

  function updateTotal() {
    const current = payload();
    const value = exerciseLogTotal(current);
    const time = formatDuration(current.duration_seconds);
    total.value = value ? `${value.toLocaleString()} lb` : time || "0 lb";
    total.textContent = total.value;
    last.textContent = lastExerciseLogText(lastExerciseLogFor(activity, { ...exercise, title: current.title }));
  }

  const durationElements = exerciseSupportsDuration(selectedTitle) ? [duration.label] : [];

  return {
    elements: [swapLabel, weight.label, sets.label, reps.label, ...durationElements, total, last, status],
    inputs: [swap, weight.input, sets.input, reps.input, duration.input],
    payload,
    status,
    updateTotal
  };
}

function attachExerciseLogAutosave(row, activity, controls, savedLog = {}) {
  let timer = null;
  let lastSaved = exerciseLogSignature(savedLog);

  async function flushAutosave() {
    const payload = controls.payload();
    const signature = exerciseLogSignature(payload);
    if (signature === lastSaved) return;
    setAutosaveStatus(controls.status, "Saving...", "is-saving");
    try {
      await saveExerciseLog(activity.activity_id, payload, { silent: true, rerender: false });
      lastSaved = signature;
      clearExerciseDraft(activity.activity_id, payload.exercise_id);
      setAutosaveStatus(controls.status, "Saved", "is-saved");
    } catch (error) {
      setAutosaveStatus(controls.status, "Not saved", "is-error");
    }
  }

  function saveDraftAndUpdate() {
    writeExerciseDraft(activity.activity_id, controls.payload());
    controls.updateTotal();
  }

  function scheduleAutosave(delay = 650) {
    window.clearTimeout(timer);
    timer = window.setTimeout(flushAutosave, delay);
  }

  async function flushNow() {
    window.clearTimeout(timer);
    await flushAutosave();
  }

  activeAutosaveFlushers.add(flushNow);
  controls.inputs.forEach((input) => {
    input.addEventListener("input", () => {
      saveDraftAndUpdate();
      scheduleAutosave();
    });
    input.addEventListener("change", () => scheduleAutosave(0));
    input.addEventListener("blur", () => scheduleAutosave(0));
  });

  row.addEventListener("submit", async (event) => {
    event.preventDefault();
    await flushNow();
  });
}

function attachFeedbackAutosave(form, activity) {
  const button = form.querySelector("button");
  const status = document.createElement("span");
  setAutosaveStatus(status, "Autosaves");
  if (button) button.replaceWith(status);

  function payload() {
    const formData = new FormData(form);
    return Object.fromEntries(formData.entries());
  }

  let timer = null;
  let lastSaved = feedbackSignature(payload());

  async function flushAutosave() {
    const currentPayload = payload();
    const signature = feedbackSignature(currentPayload);
    if (signature === lastSaved) return;
    setAutosaveStatus(status, "Saving...", "is-saving");
    try {
      await saveFeedback(activity.activity_id, currentPayload, { silent: true, rerender: false });
      lastSaved = signature;
      setAutosaveStatus(status, "Saved", "is-saved");
    } catch {
      setAutosaveStatus(status, "Not saved", "is-error");
    }
  }

  function scheduleAutosave(delay = 650) {
    window.clearTimeout(timer);
    timer = window.setTimeout(flushAutosave, delay);
  }

  ["difficulty", "back_pain"].forEach((field) => {
    const input = form.elements[field];
    if (!input) return;
    input.addEventListener("input", () => scheduleAutosave());
    input.addEventListener("change", () => scheduleAutosave(0));
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    window.clearTimeout(timer);
    await flushAutosave();
  });
}

async function flushActiveAutosaves() {
  const flushers = [...activeAutosaveFlushers];
  if (!flushers.length) return;
  await Promise.allSettled(flushers.map((flush) => flush()));
}

function exerciseRows(activity) {
  const subtasks = activity.subtasks || [];
  if (subtasks.length) {
    return subtasks
      .filter((subtask) => !subtaskIsNote(subtask))
      .map((subtask) => ({
        exercise_id: subtask.subtask_id,
        title: subtask.title
      }));
  }
  return [{
    exercise_id: "activity",
    title: activity.title
  }];
}

function renderExerciseLogs(activity, container) {
  if (!activityUsesExerciseVolume(activity)) {
    container.innerHTML = "";
    return;
  }
  const logs = activity.exercise_logs || {};
  container.innerHTML = "";
  const hint = document.createElement("p");
  hint.className = "exercise-log-hint";
  hint.textContent = "Enter total weight used per rep, not weight per side.";
  container.append(hint);
  exerciseRows(activity).forEach((exercise) => {
    const savedLog = logs[exercise.exercise_id] || {};
    const draft = readExerciseDraft(activity.activity_id, exercise.exercise_id);
    const log = { ...savedLog, ...(draft || {}) };
    const row = document.createElement("form");
    row.className = "exercise-log-row";
    row.dataset.exerciseId = exercise.exercise_id;

    const title = document.createElement("div");
    title.className = "exercise-log-title";
    title.textContent = exercise.title;

    const controls = createExerciseLogControls(activity, exercise, log);
    attachExerciseLogAutosave(row, activity, controls, savedLog);
    row.append(title, ...controls.elements);
    container.append(row);
    controls.updateTotal();
    if (draft) setAutosaveStatus(controls.status, "Draft", "is-saving");
  });
}

function appendExerciseLogControls(row, activity, exercise) {
  const draft = readExerciseDraft(activity.activity_id, exercise.exercise_id);
  const savedLog = activity.exercise_logs?.[exercise.exercise_id] || {};
  const log = {
    ...savedLog,
    ...(draft || {})
  };
  const controls = createExerciseLogControls(activity, exercise, log);
  attachExerciseLogAutosave(row, activity, controls, savedLog);
  row.append(...controls.elements);
  controls.updateTotal();
  if (draft) setAutosaveStatus(controls.status, "Draft", "is-saving");
}

function actualLabel(actual) {
  const pieces = [
    actual.name || actual.type || "Workout",
    actual.distance_miles ? `${compactNumber(actual.distance_miles, 2)} mi` : null,
    actual.duration_minutes ? `${compactNumber(actual.duration_minutes, 1)} min` : null,
    actual.average_heart_rate ? `HR ${compactNumber(actual.average_heart_rate, 0)}` : null
  ].filter(Boolean);
  return pieces.join(" · ");
}

function renderActivityActuals(activity) {
  const block = document.createElement("div");
  block.className = "activity-actuals";
  const actuals = activity.actuals || [];
  const candidates = activity.actual_match_candidates || [];
  const defaultedMultiple = actuals.some((actual) => actual.natural_match_multiple && !actual.linked);

  if (actuals.length) {
    if (defaultedMultiple) {
      const warning = document.createElement("div");
      warning.className = "match-warning";
      warning.textContent = "Multiple possible matches today. This was linked to the first scheduled compatible workout; double-check it.";
      block.append(warning);
    }
    const list = document.createElement("div");
    list.className = "activity-actual-list";
    actuals.forEach((actual) => {
      const details = document.createElement("details");
      details.className = "actual-details";
      details.open = false;
      const summary = document.createElement("summary");
      summary.textContent = `Completed with ${actualLabel(actual)}`;
      details.append(summary, renderActualCard(actual, { compact: true }));
      list.append(details);
    });
    block.append(list);
  }

  if (candidates.length) {
    const form = document.createElement("form");
    form.className = "actual-link-form";
    const label = document.createElement("label");
    label.textContent = "Match actual";
    const select = document.createElement("select");
    select.name = "actual_id";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = actuals.length ? "Automatic match" : "Pick same-day actual";
    select.append(blank);
    candidates.forEach((actual) => {
      const option = document.createElement("option");
      option.value = actual.actual_id;
      const matchType = actual.linked
        ? "Linked"
        : actual.natural_match_multiple
          ? "Auto, check"
          : actual.natural_match
            ? "Auto"
            : "Other";
      option.textContent = `${matchType} · ${actualLabel(actual)}`;
      option.selected = actual.linked;
      select.append(option);
    });
    label.append(select);
    const button = document.createElement("button");
    button.className = "ghost-button";
    button.type = "submit";
    button.textContent = "Link";
    form.append(label, button);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await linkActivityActual(activity.activity_id, select.value);
    });
    block.append(form);
  }

  return block.children.length ? block : null;
}

function renderActivity(activity, options = {}) {
  const node = elements.activityTemplate.content.firstElementChild.cloneNode(true);
  const activityMain = node.querySelector(".activity-main");
  const checkButton = node.querySelector(".check-button");
  const title = node.querySelector("h3");
  const description = node.querySelector("p");
  const meta = node.querySelector(".activity-meta");
  const equipmentTags = node.querySelector(".equipment-tags");
  const subtaskList = node.querySelector(".subtask-list");
  const exerciseLogList = node.querySelector(".exercise-log-list");
  const form = node.querySelector(".feedback-grid");
  const completed = Boolean(activity.completion?.completed);

  node.classList.toggle("is-done", completed);
  node.dataset.activityId = activity.activity_id;
  checkButton.setAttribute("aria-label", `${completed ? "Mark incomplete" : "Mark complete"}: ${activity.title}`);
  checkButton.setAttribute("aria-pressed", String(completed));
  const loggedDate = activity.completion?.logged_date;
  const loggedText = loggedDate && loggedDate !== activity.date ? ` · logged ${formatDate(loggedDate)}` : "";
  meta.textContent = `${formatDate(activity.date)} · ${activity.type} · ${activity.required_or_optional}${loggedText}`;
  title.textContent = activity.title;
  description.textContent = activityDescription(activity);
  equipmentTags.innerHTML = "";
  (activity.equipment || []).forEach((item) => {
    const tag = document.createElement("span");
    tag.textContent = item;
    equipmentTags.append(tag);
  });
  (activity.references || []).forEach((reference) => {
    const tag = document.createElement("span");
    tag.textContent = reference === "ref-atg-back-ability" ? "ATG Back Ability" : reference;
    equipmentTags.append(tag);
  });

  subtaskList.innerHTML = "";
  const usesExerciseVolume = activityUsesExerciseVolume(activity);
  if (usesExerciseVolume && (activity.subtasks || []).length) {
    const hint = document.createElement("p");
    hint.className = "exercise-log-hint";
    hint.textContent = "Enter total weight used per rep, not weight per side.";
    subtaskList.append(hint);
  }
  (activity.subtasks || []).forEach((subtask) => {
    if (subtaskIsNote(subtask)) {
      const note = document.createElement("p");
      note.className = "workout-note";
      note.textContent = subtask.title;
      subtaskList.append(note);
      return;
    }
    const row = usesExerciseVolume ? document.createElement("form") : document.createElement("label");
    row.className = usesExerciseVolume ? "subtask-row exercise-entry-row" : "subtask-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(activity.completion?.subtasks?.[subtask.subtask_id]);
    checkbox.dataset.subtaskId = subtask.subtask_id;
    const span = document.createElement("span");
    span.className = "subtask-title";
    span.textContent = subtask.title;
    row.append(checkbox, span);
    if (usesExerciseVolume) {
      appendExerciseLogControls(row, activity, {
        exercise_id: subtask.subtask_id,
        title: subtask.title
      });
    }
    subtaskList.append(row);
  });
  if (usesExerciseVolume && (activity.subtasks || []).length) {
    exerciseLogList.innerHTML = "";
  } else {
    renderExerciseLogs(activity, exerciseLogList);
  }
  const actualsBlock = renderActivityActuals(activity);
  if (actualsBlock) activityMain.after(actualsBlock);

  const feedback = activity.feedback || {};
  ["difficulty", "back_pain"].forEach((field) => {
    const input = form.elements[field];
    if (input) input.value = field === "difficulty" ? (feedback.difficulty ?? feedback.rpe ?? "") : (feedback[field] ?? "");
  });
  attachFeedbackAutosave(form, activity);

  checkButton.addEventListener("click", async () => {
    await flushActiveAutosaves();
    await updateActivity(activity.activity_id, {
      completed: !completed,
      logged_date: !completed ? options.loggedDate : null
    });
  });

  subtaskList.addEventListener("change", async (event) => {
    const checkbox = event.target.closest("[data-subtask-id]");
    if (!checkbox) return;
    await flushActiveAutosaves();
    await updateActivity(activity.activity_id, {
      subtask_id: checkbox.dataset.subtaskId,
      completed: checkbox.checked
    });
  });

  return node;
}

function renderToday() {
  const key = todayKey();
  const todaysActivities = activities().filter((activity) => activity.date === key);
  const overrideActivity = activities().find((activity) => activity.activity_id === state.todayOverrideActivityId);
  const fallback = activities().find((activity) => !activity.completion?.completed);
  const list = overrideActivity ? [overrideActivity] : todaysActivities.length ? todaysActivities : fallback ? [fallback] : [];

  elements.todayList.innerHTML = "";
  renderTodaySwitcher();
  if (!list.length) {
    elements.todayList.innerHTML = `<div class="empty-state">No activities are scheduled yet. Import a weekly plan to get started.</div>`;
    return;
  }
  list.forEach((activity) => elements.todayList.append(renderActivity(activity, { loggedDate: key })));
}

function renderTodaySwitcher() {
  const key = todayKey();
  const switchableActivities = activities()
    .filter((activity) => !activity.completion?.completed && activity.date !== key)
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));

  elements.todaySwitchSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = switchableActivities.length ? "Pick a scheduled workout" : "No other scheduled workouts";
  elements.todaySwitchSelect.append(placeholder);

  switchableActivities.forEach((activity) => {
    const option = document.createElement("option");
    option.value = activity.activity_id;
    option.textContent = `${formatDate(activity.date)} · ${activity.title}`;
    option.selected = activity.activity_id === state.todayOverrideActivityId;
    elements.todaySwitchSelect.append(option);
  });

  elements.todaySwitchSelect.disabled = !switchableActivities.length;
}

function renderWeek() {
  const byDate = new Map();
  activities().forEach((activity) => {
    if (!byDate.has(activity.date)) byDate.set(activity.date, []);
    byDate.get(activity.date).push(activity);
  });

  elements.weekGrid.innerHTML = "";
  if (!byDate.size) {
    elements.weekGrid.innerHTML = `<div class="empty-state">No week plan loaded.</div>`;
    return;
  }

  [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([date, dateActivities]) => {
    const column = document.createElement("section");
    column.className = "day-column";
    const heading = document.createElement("h3");
    heading.textContent = formatDate(date, { weekday: "long" });
    column.append(heading);
    dateActivities.forEach((activity) => column.append(renderActivity(activity)));
    elements.weekGrid.append(column);
  });
}

function renderLibrary() {
  const items = uniqueWorkoutLibraryItems();
  elements.libraryGrid.innerHTML = "";
  if (!items.length) {
    elements.libraryGrid.innerHTML = `<div class="empty-state">No workouts in the active plan yet. Import a plan to build the library.</div>`;
    return;
  }

  items.forEach((activity) => {
    const card = document.createElement("article");
    card.className = "library-card";

    const meta = document.createElement("div");
    meta.className = "activity-meta";
    meta.textContent = `${activity.type || "workout"} · ${activity.dates.map((date) => formatDate(date)).join(", ")}`;

    const title = document.createElement("h3");
    title.textContent = activity.title;

    const description = document.createElement("p");
    description.className = "library-description";
    description.textContent = workoutLibraryDescription(activity);

    const tags = document.createElement("div");
    tags.className = "equipment-tags";
    [...(activity.equipment || []), ...(activity.references || [])].forEach((item) => {
      const tag = document.createElement("span");
      tag.textContent = item === "ref-atg-back-ability" ? "ATG Back Ability" : item;
      tags.append(tag);
    });

    const movementList = document.createElement("div");
    movementList.className = "movement-list";
    const sourceMovements = (activity.subtasks && activity.subtasks.length ? activity.subtasks : [{ title: activity.title }]).slice(0, 5);
    sourceMovements.forEach((movement) => {
      const reference = movementReference(movement.title);
      const link = document.createElement("a");
      link.className = "movement-card";
      link.href = reference.videoId ? `https://www.youtube.com/watch?v=${reference.videoId}` : youtubeSearchUrl(movement.title);
      link.target = "_blank";
      link.rel = "noreferrer";

      const visual = document.createElement("span");
      visual.className = "movement-visual";
      if (reference.videoId) {
        const image = document.createElement("img");
        image.alt = "";
        image.loading = "lazy";
        image.src = `https://img.youtube.com/vi/${reference.videoId}/hqdefault.jpg`;
        visual.append(image);
      } else {
        visual.textContent = reference.title.split(/\s+/).slice(0, 2).map((word) => word[0]).join("").toUpperCase();
      }

      const copy = document.createElement("span");
      copy.className = "movement-copy";
      const movementTitle = document.createElement("strong");
      movementTitle.textContent = movement.title;
      const movementDescription = document.createElement("span");
      movementDescription.textContent = reference.description;
      copy.append(movementTitle, movementDescription);
      link.append(visual, copy);
      movementList.append(link);
    });

    card.append(meta, title, description);
    if (tags.children.length) card.append(tags);
    card.append(movementList);
    elements.libraryGrid.append(card);
  });
}

function renderGear() {
  const gear = state.data?.gear || [];
  elements.gearGrid.innerHTML = "";
  if (!gear.length) {
    elements.gearGrid.innerHTML = `<div class="empty-state">No gear recorded yet.</div>`;
    return;
  }

  gear
    .slice()
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
    .forEach((item) => {
      const card = document.createElement("article");
      card.className = "gear-card";
      const top = document.createElement("div");
      top.className = "gear-card-top";
      const copy = document.createElement("div");
      const meta = document.createElement("div");
      meta.className = "activity-meta";
      meta.textContent = `${item.category} · ${item.status}`;
      const title = document.createElement("h3");
      title.textContent = item.name;
      const button = document.createElement("button");
      button.className = "ghost-button";
      button.type = "button";
      button.dataset.copyGear = item.gear_id;
      button.textContent = "Edit JSON";
      copy.append(meta, title);
      top.append(copy, button);
      const notes = document.createElement("p");
      notes.textContent = item.notes || "No notes yet.";
      const capabilities = document.createElement("div");
      capabilities.className = "equipment-tags";
      (item.capabilities || []).forEach((capability) => {
        const tag = document.createElement("span");
        tag.textContent = capability;
        capabilities.append(tag);
      });
      card.append(top, notes, capabilities);
      elements.gearGrid.append(card);
    });
}

function appendMetricChip(container, text) {
  if (!text) return;
  const chip = document.createElement("span");
  chip.textContent = text;
  container.append(chip);
}

function svgPointPath(points, width, height, padding = 8) {
  if (!Array.isArray(points) || points.length < 2) return "";
  return points.map((point, index) => {
    const x = padding + Number(point.x) * (width - padding * 2);
    const y = padding + Number(point.y) * (height - padding * 2);
    return `${index ? "L" : "M"} ${compactNumber(x, 2)} ${compactNumber(y, 2)}`;
  }).join(" ");
}

function renderHeartRateChart(series) {
  if (!Array.isArray(series) || series.length < 2) return null;
  const values = series.map((point) => Number(point.avg_bpm)).filter(Number.isFinite);
  if (values.length < 2) return null;
  const width = 420;
  const height = 120;
  const padding = 12;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const lastOffset = Math.max(...series.map((point) => Number(point.offset_seconds || 0))) || 1;
  const path = series.map((point, index) => {
    const x = padding + (Number(point.offset_seconds || 0) / lastOffset) * (width - padding * 2);
    const y = height - padding - ((Number(point.avg_bpm) - min) / range) * (height - padding * 2);
    return `${index ? "L" : "M"} ${compactNumber(x, 2)} ${compactNumber(y, 2)}`;
  }).join(" ");

  const chart = document.createElement("div");
  chart.className = "actual-chart";
  chart.innerHTML = `
    <div class="actual-chart-label">
      <span>Heart rate</span>
      <span>${compactNumber(min, 0)}-${compactNumber(max, 0)} bpm</span>
    </div>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Heart rate over time">
      <path class="chart-grid" d="M ${padding} ${height - padding} H ${width - padding} M ${padding} ${padding} H ${width - padding}"></path>
      <path class="chart-line" d="${path}"></path>
    </svg>
  `;
  return chart;
}

function lonToTileX(lon, zoom) {
  return ((Number(lon) + 180) / 360) * (2 ** zoom);
}

function latToTileY(lat, zoom) {
  const rad = Number(lat) * Math.PI / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * (2 ** zoom);
}

function chooseMapZoom(routeMap, width, height) {
  const bounds = routeMap.bounds || {};
  for (let zoom = 17; zoom >= 3; zoom -= 1) {
    const xRange = Math.abs(lonToTileX(bounds.max_lon, zoom) - lonToTileX(bounds.min_lon, zoom)) * 256;
    const yRange = Math.abs(latToTileY(bounds.max_lat, zoom) - latToTileY(bounds.min_lat, zoom)) * 256;
    if (xRange <= width * 0.65 && yRange <= height * 0.65) return zoom;
  }
  return 3;
}

function renderRouteMapPreview(routeMap) {
  if (!routeMap?.points || routeMap.points.length < 2 || !routeMap.bounds) return null;
  const width = 260;
  const height = 160;
  const zoom = chooseMapZoom(routeMap, width, height);
  const centerLat = (Number(routeMap.bounds.min_lat) + Number(routeMap.bounds.max_lat)) / 2;
  const centerLon = (Number(routeMap.bounds.min_lon) + Number(routeMap.bounds.max_lon)) / 2;
  const centerX = lonToTileX(centerLon, zoom);
  const centerY = latToTileY(centerLat, zoom);
  const tileMinX = Math.floor(centerX - width / 512) - 1;
  const tileMaxX = Math.floor(centerX + width / 512) + 1;
  const tileMinY = Math.floor(centerY - height / 512) - 1;
  const tileMaxY = Math.floor(centerY + height / 512) + 1;
  const tiles = [];
  const maxTile = 2 ** zoom;
  for (let x = tileMinX; x <= tileMaxX; x += 1) {
    for (let y = tileMinY; y <= tileMaxY; y += 1) {
      if (y < 0 || y >= maxTile) continue;
      const wrappedX = ((x % maxTile) + maxTile) % maxTile;
      tiles.push({ x, y, wrappedX });
    }
  }
  const path = routeMap.points.map((point, index) => {
    const x = (lonToTileX(point.lon, zoom) - centerX) * 256 + width / 2;
    const y = (latToTileY(point.lat, zoom) - centerY) * 256 + height / 2;
    return `${index ? "L" : "M"} ${compactNumber(x, 2)} ${compactNumber(y, 2)}`;
  }).join(" ");

  const preview = document.createElement("div");
  preview.className = "route-preview route-preview-map";
  const tileHtml = tiles.map((tile) => {
    const left = (tile.x - centerX) * 256 + width / 2;
    const top = (tile.y - centerY) * 256 + height / 2;
    return `<img alt="" src="https://tile.openstreetmap.org/${zoom}/${tile.wrappedX}/${tile.y}.png" style="left:${left}px;top:${top}px">`;
  }).join("");
  preview.innerHTML = `
    <div class="actual-chart-label">
      <span>Map</span>
      <span>${routeMap.source_points || routeMap.points.length} pts</span>
    </div>
    <div class="map-thumb" style="--map-width:${width}px;--map-height:${height}px">
      <div class="map-tiles">${tileHtml}</div>
      <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Run route on map">
        <path class="route-line" d="${path}"></path>
      </svg>
      <span class="map-attribution">&copy; OSM</span>
    </div>
  `;
  return preview;
}

function renderRoutePreview(routeShape) {
  if (!routeShape?.points || routeShape.points.length < 2) return null;
  const width = 180;
  const height = 120;
  const path = svgPointPath(routeShape.points, width, height, 10);
  const preview = document.createElement("div");
  preview.className = "route-preview";
  preview.innerHTML = `
    <div class="actual-chart-label">
      <span>Route shape</span>
      <span>${routeShape.source_points || routeShape.points.length} pts</span>
    </div>
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Simplified route shape">
      <path class="route-line" d="${path}"></path>
    </svg>
  `;
  return preview;
}

function renderActualCard(actual, options = {}) {
  const card = document.createElement("article");
  card.className = `actual-card${options.compact ? " actual-card-compact" : ""}`;

  const meta = document.createElement("div");
  meta.className = "activity-meta";
  meta.textContent = `${formatDate(actual.date)} · ${actual.type || "workout"}${actual.location ? ` · ${actual.location}` : ""}`;

  const title = document.createElement("h3");
  title.textContent = actual.name || "Workout";

  const chips = document.createElement("div");
  chips.className = "metric-chips";
  appendMetricChip(chips, actual.distance_miles ? `${compactNumber(actual.distance_miles, 2)} mi` : null);
  appendMetricChip(chips, actual.duration_minutes ? `${compactNumber(actual.duration_minutes, 1)} min` : null);
  appendMetricChip(chips, actual.average_heart_rate ? `avg HR ${compactNumber(actual.average_heart_rate, 1)}` : null);
  appendMetricChip(chips, actual.max_heart_rate ? `max HR ${compactNumber(actual.max_heart_rate, 0)}` : null);
  appendMetricChip(chips, actual.active_energy_kcal ? `${compactNumber(actual.active_energy_kcal, 0)} active kcal` : null);
  appendMetricChip(chips, actual.elevation_gain ? `elev ${compactQuantity(actual.elevation_gain)}` : null);
  appendMetricChip(chips, actual.temperature ? `temp ${compactQuantity(actual.temperature)}` : null);
  appendMetricChip(chips, actual.humidity ? `humidity ${compactQuantity(actual.humidity)}` : null);
  appendMetricChip(chips, actual.step_cadence ? `cadence ${compactQuantity(actual.step_cadence)}` : null);
  appendMetricChip(chips, actual.total_steps ? `${compactNumber(actual.total_steps, 0)} steps` : null);

  const trends = document.createElement("div");
  trends.className = "actual-trends";
  appendMetricChip(trends, actual.heart_rate_recovery?.drop_bpm !== undefined ? `HR recovery ${actual.heart_rate_recovery.drop_bpm} bpm / ${actual.heart_rate_recovery.duration_seconds}s` : null);
  appendMetricChip(trends, actual.heart_rate_drift?.drift_bpm !== undefined ? `HR drift ${actual.heart_rate_drift.drift_bpm} bpm (${actual.heart_rate_drift.drift_percent}%)` : null);
  appendMetricChip(trends, actual.pace_drift?.slowdown_percent !== undefined ? `pace drift ${actual.pace_drift.slowdown_percent}%` : null);

  const splits = document.createElement("p");
  splits.className = "actual-splits";
  if (Array.isArray(actual.splits) && actual.splits.length) {
    splits.textContent = `Splits: ${actual.splits.map((split) => `${split.split}: ${split.pace}`).join(", ")}`;
  }

  const visuals = document.createElement("div");
  visuals.className = "actual-visuals";
  const hrChart = renderHeartRateChart(actual.heart_rate_series);
  const routePreview = renderRouteMapPreview(actual.route_map) || renderRoutePreview(actual.route_shape);
  if (hrChart) visuals.append(hrChart);
  if (routePreview) visuals.append(routePreview);

  card.append(meta, title, chips);
  if (trends.children.length) card.append(trends);
  if (visuals.children.length) card.append(visuals);
  if (splits.textContent) card.append(splits);
  return card;
}

function renderActuals() {
  const actuals = state.data?.health?.actual_workouts || [];
  elements.actualsList.innerHTML = "";
  if (!actuals.length) {
    elements.actualsList.innerHTML = `<div class="empty-state">No imported workouts yet.</div>`;
    return;
  }

  actuals
    .slice()
    .sort((a, b) => String(b.start_date || b.date).localeCompare(String(a.start_date || a.date)))
    .forEach((actual) => {
      elements.actualsList.append(renderActualCard(actual));
    });
}

function runActuals() {
  return (state.data?.health?.actual_workouts || [])
    .filter((actual) => String(actual.type || actual.name || "").toLowerCase().includes("run"))
    .slice()
    .sort((a, b) => String(b.start_date || b.date).localeCompare(String(a.start_date || a.date)));
}

function weekKeyForDate(date) {
  const value = new Date(`${date}T12:00:00`);
  const day = value.getDay();
  value.setDate(value.getDate() - ((day + 6) % 7));
  return dateKeyFromDate(value);
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
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) {
    return { date: explicit, inferred: false, label: formatDate(explicit) };
  }

  const goalText = [goals.primary, ...(Array.isArray(goals.goals) ? goals.goals : [])].filter(Boolean).join(" ");
  const iso = goalText.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) return { date: iso[1], inferred: true, label: formatDate(iso[1]) };

  const month = monthFromGoalText(goalText);
  if (month !== null) {
    const now = new Date(`${todayKey()}T12:00:00`);
    const year = month < now.getMonth() ? now.getFullYear() + 1 : now.getFullYear();
    const lastDay = new Date(year, month + 1, 0);
    const date = dateKeyFromDate(lastDay);
    return { date, inferred: true, label: `end of ${lastDay.toLocaleString(undefined, { month: "long" })}` };
  }

  const fallback = addDays(todayKey(), 16 * 7);
  return { date: fallback, inferred: true, label: formatDate(fallback) };
}

function roundDistance(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function runDistancesForWeek(longRunDistance, runCount, raceWeek = false) {
  const count = Math.max(1, Number(runCount || 3));
  if (raceWeek) {
    const tuneups = count <= 2 ? [3] : [3, 2];
    return [...tuneups.slice(0, Math.max(0, count - 1)), 13.1].slice(-count);
  }
  if (count === 1) return [roundDistance(longRunDistance)];
  const easy = Math.max(2, longRunDistance * 0.6);
  if (count === 2) return [roundDistance(easy), roundDistance(longRunDistance)];
  const quality = Math.max(2.5, longRunDistance * 0.72);
  const extras = Array.from({ length: Math.max(0, count - 3) }, () => Math.max(2.5, longRunDistance * 0.5));
  return [easy, quality, ...extras, longRunDistance].map(roundDistance);
}

function buildHalfMarathonRunPlan(runs) {
  const goals = state.data?.goals || {};
  const runPlan = goals.run_plan || {};
  const race = raceTargetFromGoals(goals);
  const targetDistance = Number(runPlan.race_distance_miles || goals.race_distance_miles || 13.1);
  const targetRuns = Math.max(1, Number(runPlan.weekly_runs || goals.run_frequency_per_week || 3));
  const currentWeekStart = weekKeyForDate(todayKey());
  const raceWeekStart = weekKeyForDate(race.date);
  const longestActual = Math.max(0, ...runs.map((run) => Number(run.distance_miles || 0)));
  const plannedRunDistances = activities()
    .filter((activity) => activity.type === "run")
    .map((activity) => Number(activity.target?.distance_miles || 0))
    .filter(Boolean);
  const plannedLong = Math.max(0, ...plannedRunDistances);
  const startLong = Number(runPlan.start_long_run_miles || Math.max(3, Math.min(6, longestActual || plannedLong || 3)));
  const peakLong = Number(runPlan.peak_long_run_miles || Math.max(10, targetDistance - 1.1));
  const cutbackEveryWeeks = Math.max(3, Number(runPlan.cutback_every_weeks || 4));
  const weeks = [];
  let weekStart = currentWeekStart;
  let index = 0;
  const totalWeeks = Math.max(1, Math.floor(dateDaysApart(currentWeekStart, raceWeekStart) / 7) + 1);
  const peakIndex = Math.max(0, totalWeeks - 3);

  while (weekStart <= raceWeekStart && weeks.length < 32) {
    const weeksToRace = Math.max(0, Math.round(dateDaysApart(weekStart, raceWeekStart) / 7));
    const isRaceWeek = weekStart === raceWeekStart;
    let longRun;
    if (isRaceWeek) {
      longRun = targetDistance;
    } else if (weeksToRace === 1) {
      longRun = Math.max(6, peakLong * 0.65);
    } else if (weeksToRace === 2) {
      longRun = peakLong;
    } else {
      const progress = peakIndex ? Math.min(1, index / peakIndex) : 1;
      longRun = startLong + (peakLong - startLong) * progress;
      if (index > 0 && index % cutbackEveryWeeks === cutbackEveryWeeks - 1) longRun *= 0.86;
    }
    longRun = roundDistance(longRun);
    const distances = runDistancesForWeek(longRun, targetRuns, isRaceWeek);
    const weeklyDistance = roundDistance(distances.reduce((sum, distance) => sum + distance, 0));
    weeks.push({
      weekStart,
      weekEnd: addDays(weekStart, 6),
      index,
      targetRuns,
      distances,
      longRun,
      weeklyDistance,
      weeksToRace,
      isRaceWeek
    });
    weekStart = addDays(weekStart, 7);
    index += 1;
  }

  return {
    race,
    targetRuns,
    targetDistance,
    assumptions: {
      weekly_runs: targetRuns,
      race_distance_miles: targetDistance,
      start_long_run_miles: startLong,
      peak_long_run_miles: peakLong,
      cutback_every_weeks: cutbackEveryWeeks
    },
    currentWeek: weeks[0] || null,
    weeks
  };
}

function runWeekSummary(runs, weekStart) {
  const end = new Date(`${weekStart}T12:00:00`);
  end.setDate(end.getDate() + 6);
  const weekEnd = dateKeyFromDate(end);
  const weekRuns = runs.filter((run) => run.date >= weekStart && run.date <= weekEnd);
  const distance = weekRuns.reduce((sum, run) => sum + Number(run.distance_miles || 0), 0);
  return { weekStart, weekEnd, runs: weekRuns, distance };
}

function runPlanStatus(runs) {
  const plan = buildHalfMarathonRunPlan(runs);
  const plannedRuns = plan.currentWeek ? Array.from({ length: plan.currentWeek.targetRuns }, (_, index) => index) : [];
  const weekStart = plan.currentWeek?.weekStart || weekKeyForDate(todayKey());
  const week = runWeekSummary(runs, weekStart);
  const targetRuns = plan.currentWeek?.targetRuns || Number(state.data?.goals?.run_frequency_per_week || 3);
  const completedThisWeek = week.runs.length;
  const plannedDistance = plan.currentWeek?.weeklyDistance || 0;
  const longest = runs.reduce((best, run) => Number(run.distance_miles || 0) > Number(best?.distance_miles || 0) ? run : best, null);
  const latest = runs[0] || null;
  const daysSinceRun = latest?.date ? dateDaysApart(latest.date, todayKey()) : null;
  const longRunPercent = longest?.distance_miles ? Math.min(100, Math.round((Number(longest.distance_miles) / plan.targetDistance) * 100)) : 0;
  const recent = runs.slice(0, 6);
  const averageHr = average(recent.map((run) => run.average_heart_rate));
  const averageDistance = average(recent.map((run) => run.distance_miles));
  const daysElapsedThisWeek = Math.min(7, Math.max(1, dateDaysApart(weekStart, todayKey()) + 1));
  const expectedRunsByToday = Math.min(targetRuns, Math.max(1, Math.ceil((targetRuns * daysElapsedThisWeek) / 7)));
  const expectedDistanceByToday = plannedDistance ? plannedDistance * (daysElapsedThisWeek / 7) : 0;

  let label = "Needs data";
  let tone = "neutral";
  let detail = `Generated plan targets ${targetRuns} runs and ${compactNumber(plannedDistance, 1)} mi this week.`;
  if (runs.length) {
    const enoughRuns = completedThisWeek >= expectedRunsByToday;
    const enoughDistance = !expectedDistanceByToday || week.distance >= expectedDistanceByToday * 0.75;
    const recentEnough = daysSinceRun === null || daysSinceRun <= 7;
    if (enoughRuns && enoughDistance && recentEnough) {
      label = "On track to plan";
      tone = "good";
      detail = `Logged ${completedThisWeek}/${targetRuns} weekly runs; by today the plan expects about ${expectedRunsByToday}.`;
    } else if (completedThisWeek > 0 || recentEnough) {
      label = "Building";
      tone = "watch";
      detail = `Logged ${completedThisWeek}/${targetRuns} weekly runs and ${compactNumber(week.distance, 1)} of ${compactNumber(plannedDistance, 1)} mi.`;
    } else {
      label = "Needs attention";
      tone = "danger";
      detail = `No logged run in ${daysSinceRun} days.`;
    }
  }

  return {
    label,
    tone,
    detail,
    targetRuns,
    plannedRuns,
    plannedDistance,
    completedThisWeek,
    weekDistance: week.distance,
    expectedRunsByToday,
    expectedDistanceByToday,
    longest,
    longRunPercent,
    latest,
    daysSinceRun,
    averageHr,
    averageDistance,
    recent,
    plan
  };
}

function runMetricCard(label, value, detail) {
  return `
    <article>
      <span>${escapeHtml(value)}</span>
      <small>${escapeHtml(label)}</small>
      ${detail ? `<p>${escapeHtml(detail)}</p>` : ""}
    </article>
  `;
}

function renderRunPlanTable(plan, runs) {
  const table = document.createElement("div");
  table.className = "run-table run-plan-table";
  table.innerHTML = `
    <div class="run-table-row run-table-head run-plan-row">
      <span>Week</span>
      <span>Runs</span>
      <span>Distances</span>
      <span>Total</span>
      <span>Actual</span>
    </div>
  `;
  plan.weeks.forEach((week, index) => {
    const actual = runWeekSummary(runs, week.weekStart);
    const row = document.createElement("div");
    row.className = `run-table-row run-plan-row${index === 0 ? " is-current" : ""}${week.isRaceWeek ? " is-race-week" : ""}`;
    row.innerHTML = `
      <span>${escapeHtml(formatDate(week.weekStart))}${week.isRaceWeek ? " · race" : ""}</span>
      <span>${escapeHtml(String(week.targetRuns))}</span>
      <span>${escapeHtml(week.distances.map((distance) => `${distance} mi`).join(" / "))}</span>
      <span>${escapeHtml(`${compactNumber(week.weeklyDistance, 1)} mi`)}</span>
      <span>${escapeHtml(actual.runs.length ? `${actual.runs.length} runs · ${compactNumber(actual.distance, 1)} mi` : "-")}</span>
    `;
    table.append(row);
  });
  return table;
}

function renderRunTracking() {
  const runs = runActuals();
  const status = runPlanStatus(runs);
  elements.runDashboard.innerHTML = "";
  elements.runHistory.innerHTML = "";

  const statusPanel = document.createElement("section");
  statusPanel.className = `run-status-panel is-${status.tone}`;
  statusPanel.innerHTML = `
    <div>
      <p class="eyebrow">Readiness signal</p>
      <h3>${escapeHtml(status.label)}</h3>
      <p>${escapeHtml(status.detail)}</p>
      <p class="run-plan-note">${escapeHtml(status.plan.race.inferred ? `Race timing inferred as ${status.plan.race.label}. Set Race Date in Goals for a precise plan.` : `Race date: ${status.plan.race.label}.`)}</p>
    </div>
    <div class="run-progress">
      <div>
        <strong>${status.longRunPercent}%</strong>
        <span>of ${compactNumber(status.plan.targetDistance, 1)} mi covered by longest imported run</span>
      </div>
      <meter min="0" max="100" value="${status.longRunPercent}"></meter>
    </div>
  `;

  const metricGrid = document.createElement("div");
  metricGrid.className = "run-metric-grid";
  const longestDistance = status.longest?.distance_miles ? `${compactNumber(status.longest.distance_miles, 2)} mi` : "-";
  const latestDate = status.latest?.date ? formatDate(status.latest.date) : "-";
  const weekDistance = status.weekDistance ? `${compactNumber(status.weekDistance, 2)} mi` : "0 mi";
  const avgHr = status.averageHr ? `${compactNumber(status.averageHr, 0)} bpm` : "-";
  metricGrid.innerHTML = [
    runMetricCard("This week", `${status.completedThisWeek}/${status.targetRuns || status.plannedRuns.length || 0}`, `${weekDistance} logged`),
    runMetricCard("Plan long run", status.plan.currentWeek ? `${compactNumber(status.plan.currentWeek.longRun, 1)} mi` : "-", "current week target"),
    runMetricCard("Longest run", longestDistance, status.longest?.date ? `${formatDate(status.longest.date)} · ${status.longRunPercent}% of ${compactNumber(status.plan.targetDistance, 1)}` : "No run yet"),
    runMetricCard("Latest run", latestDate, status.latest ? `${compactNumber(status.latest.distance_miles || 0, 2)} mi · ${formatPaceFromActual(status.latest) || "pace -"}` : "No run yet"),
    runMetricCard("Recent avg HR", avgHr, status.averageDistance ? `${compactNumber(status.averageDistance, 2)} mi avg run` : "")
  ].join("");

  const planHeading = document.createElement("div");
  planHeading.className = "run-subsection-heading";
  planHeading.innerHTML = `
    <h3>Week-by-week run plan</h3>
    <p>${escapeHtml(status.plan.targetRuns)} runs/week ramp toward the half marathon, with every fourth week eased back.</p>
  `;

  elements.runDashboard.append(statusPanel, metricGrid, planHeading, renderRunPlanTable(status.plan, runs));

  if (!runs.length) {
    elements.runHistory.innerHTML = `<div class="empty-state">No imported runs yet. Once Health Auto Export sends runs, this view will show pace, heart rate, route, and location history.</div>`;
    return;
  }

  const table = document.createElement("div");
  table.className = "run-table";
  table.innerHTML = `
    <div class="run-table-row run-table-head">
      <span>Date</span>
      <span>Distance</span>
      <span>Pace</span>
      <span>HR</span>
      <span>Location</span>
    </div>
  `;
  runs.forEach((run) => {
    const row = document.createElement("div");
    row.className = "run-table-row";
    row.innerHTML = `
      <span>${escapeHtml(formatDate(run.date))}</span>
      <span>${escapeHtml(run.distance_miles ? `${compactNumber(run.distance_miles, 2)} mi` : "-")}</span>
      <span>${escapeHtml(formatPaceFromActual(run) || "-")}</span>
      <span>${escapeHtml(`${run.average_heart_rate ? `${compactNumber(run.average_heart_rate, 0)} avg` : "-"}${run.max_heart_rate ? ` / ${compactNumber(run.max_heart_rate, 0)} max` : ""}`)}</span>
      <span>${escapeHtml(run.location || (run.route_map || run.route_shape ? "route saved" : "-"))}</span>
    `;
    table.append(row);
  });

  const cards = document.createElement("div");
  cards.className = "run-card-list";
  runs.slice(0, 8).forEach((run) => cards.append(renderActualCard(run)));
  elements.runHistory.append(table, cards);
}

function renderGoals() {
  const goals = state.data?.goals || {};
  elements.goalPrimary.value = goals.primary || "";
  elements.goalRaceDate.value = goals.race_date || "";
  elements.goalRunFrequency.value = goals.run_frequency_per_week ?? "";
  elements.goalStrengthFocus.value = Array.isArray(goals.strength_focus) ? goals.strength_focus.join(", ") : (goals.strength_focus || "");
  elements.goalBackHealth.value = goals.back_health || "";
  elements.goalRecovery.value = goals.recovery || "";
  elements.coachNotes.value = state.data?.coach_notes || "";
}

function render() {
  activeAutosaveFlushers.clear();
  updateOverview();
  renderToday();
  renderWeek();
  renderLibrary();
  renderGoals();
  renderGear();
  renderActuals();
  renderRunTracking();
}

async function loadState() {
  try {
    state.data = await api("/api/state");
    setBackendStatus(true);
    render();
    await refreshCoachSummary();
  } catch (error) {
    setBackendStatus(false);
    setMessage(error.message, true);
  }
}

async function updateActivity(activityId, payload) {
  try {
    state.data = await api(`/api/activities/${encodeURIComponent(activityId)}`, {
      method: "PATCH",
      body: JSON.stringify(payload)
    });
    render();
    await refreshCoachSummary();
  } catch (error) {
    setMessage(error.message, true);
    await loadState();
  }
}

async function saveFeedback(activityId, payload, options = {}) {
  const { silent = false, rerender = true } = options;
  try {
    state.data = await api(`/api/activities/${encodeURIComponent(activityId)}/feedback`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    if (rerender) render();
    const summaryPromise = refreshCoachSummary();
    if (rerender) {
      await summaryPromise;
    } else {
      summaryPromise.catch(() => {});
    }
    if (!silent) setMessage("Feedback saved.");
  } catch (error) {
    if (!silent) setMessage(error.message, true);
    throw error;
  }
}

async function saveExerciseLog(activityId, payload, options = {}) {
  const { silent = false, rerender = true } = options;
  try {
    state.data = await api(`/api/activities/${encodeURIComponent(activityId)}/exercise-log`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    if (rerender) render();
    const summaryPromise = refreshCoachSummary();
    if (rerender) {
      await summaryPromise;
    } else {
      summaryPromise.catch(() => {});
    }
    if (!silent) setMessage("Exercise volume saved.");
  } catch (error) {
    if (!silent) setMessage(error.message, true);
    throw error;
  }
}

async function linkActivityActual(activityId, actualId) {
  try {
    state.data = await api(`/api/activities/${encodeURIComponent(activityId)}/actual-link`, {
      method: "POST",
      body: JSON.stringify({ actual_id: actualId || null })
    });
    render();
    await refreshCoachSummary();
    setMessage(actualId ? "Actual linked." : "Actual link cleared.");
  } catch (error) {
    setMessage(error.message, true);
  }
}

function parseTextareaJson(textarea) {
  const text = textarea.value.trim();
  if (!text) throw new Error("Paste JSON first.");
  return JSON.parse(text);
}

async function refreshCoachSummary() {
  const summary = await api("/api/coach-summary");
  elements.coachSummary.value = summary.summary_text;
  return summary;
}

elements.tabButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.activeView = button.dataset.view;
    elements.tabButtons.forEach((item) => item.classList.toggle("is-active", item === button));
    elements.views.forEach((view) => view.classList.toggle("is-active", view.id === state.activeView));
  });
});

elements.refreshButton.addEventListener("click", loadState);

elements.writeAccessButton.addEventListener("click", async () => {
  try {
    if (state.writeAccess) {
      await lockWriteAccess("Saves locked.");
      return;
    }
    await requestWriteAccess();
  } catch (error) {
    setMessage(error.message, true);
  }
});

elements.unlockForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  elements.unlockError.textContent = "";
  try {
    const unlocked = await submitUnlockPassword(elements.unlockPassword.value);
    closeUnlockModal(Boolean(unlocked));
  } catch (error) {
    elements.unlockError.textContent = error.message;
  }
});

elements.unlockCancel.addEventListener("click", () => {
  closeUnlockModal(false);
});

elements.unlockModal.addEventListener("click", (event) => {
  if (event.target === elements.unlockModal) closeUnlockModal(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.unlockModal.hidden) closeUnlockModal(false);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushActiveAutosaves();
});

window.addEventListener("pagehide", () => {
  flushActiveAutosaves();
});

elements.todaySwitchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  state.todayOverrideActivityId = elements.todaySwitchSelect.value || null;
  renderToday();
});

elements.clearSwitchButton.addEventListener("click", () => {
  state.todayOverrideActivityId = null;
  renderToday();
});

elements.planImportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = parseTextareaJson(elements.planJson);
    state.data = await api("/api/plans/import", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    elements.planJson.value = "";
    render();
    await refreshCoachSummary();
    setMessage("Plan imported and activated.");
  } catch (error) {
    setMessage(error.message, true);
  }
});

elements.goalsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const goals = {
      primary: elements.goalPrimary.value.trim(),
      race_date: elements.goalRaceDate.value || null,
      run_frequency_per_week: elements.goalRunFrequency.value ? Number(elements.goalRunFrequency.value) : null,
      run_plan: state.data?.goals?.run_plan || null,
      strength_focus: elements.goalStrengthFocus.value.split(",").map((item) => item.trim()).filter(Boolean),
      back_health: elements.goalBackHealth.value.trim(),
      recovery: elements.goalRecovery.value.trim()
    };
    state.data = await api("/api/goals", {
      method: "PUT",
      body: JSON.stringify({ goals })
    });
    render();
    await refreshCoachSummary();
    setMessage("Goals saved.");
  } catch (error) {
    setMessage(error.message, true);
  }
});

elements.coachNotesForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    state.data = await api("/api/coach-notes", {
      method: "PUT",
      body: JSON.stringify({ coach_notes: elements.coachNotes.value })
    });
    render();
    await refreshCoachSummary();
    setMessage("Coach notes saved.");
  } catch (error) {
    setMessage(error.message, true);
  }
});

elements.actualsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = parseTextareaJson(elements.actualsJson);
    state.data = await api("/api/health/import", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    render();
    await refreshCoachSummary();
    setMessage("Actuals imported.");
  } catch (error) {
    setMessage(error.message, true);
  }
});

elements.gearGrid.addEventListener("click", (event) => {
  const button = event.target.closest("[data-copy-gear]");
  if (!button) return;
  const item = (state.data?.gear || []).find((gear) => gear.gear_id === button.dataset.copyGear);
  if (!item) return;
  elements.gearJson.value = JSON.stringify(item, null, 2);
});

elements.gearForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const payload = parseTextareaJson(elements.gearJson);
    state.data = await api("/api/gear/upsert", {
      method: "POST",
      body: JSON.stringify(payload)
    });
    elements.gearJson.value = "";
    render();
    await refreshCoachSummary();
    setMessage("Gear saved.");
  } catch (error) {
    setMessage(error.message, true);
  }
});

elements.copySummaryButton.addEventListener("click", async () => {
  try {
    const summary = await refreshCoachSummary();
    await navigator.clipboard.writeText(summary.summary_text);
    setMessage("Coach summary copied.");
  } catch (error) {
    setMessage(error.message, true);
  }
});

window.localStorage.removeItem("coach_loop_api_token");
updateWriteAccessUi();
refreshWriteSession()
  .catch(() => {
    state.writeAccess = false;
    updateWriteAccessUi();
  })
  .finally(loadState);
