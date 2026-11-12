const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const savedGoal = "Saved primary goal";
const savedNotes = "Saved coach notes";
const typedGoal = "Unsaved primary goal typed before midnight";
const typedNotes = "Unsaved coach notes typed before midnight";
const typedBackHealth = "Unsaved back health note";
const typedPlan = '{ "unsaved": "plan json" }';
const typedPeriod = "Unsaved August vacation";
const typedWorkoutNote = "Unsaved workout note still in the week card";

function runInPage(context, code, filename) {
  new vm.Script(code, { filename }).runInContext(context);
}

function typeInto(window, element, text) {
  element.focus();
  element.value = "";
  for (const character of text) {
    element.value += character;
    element.dispatchEvent(new window.InputEvent("input", {
      bubbles: true,
      data: character,
      inputType: "insertText"
    }));
  }
}

function pageFixture() {
  return {
    goals: {
      primary: savedGoal,
      race_date: "2026-10-18",
      run_frequency_per_week: 3,
      strength_focus: ["Maintain lower-body strength"],
      back_health: "Saved back health",
      recovery: "Saved recovery"
    },
    coach_notes: savedNotes,
    streak: { days_without_miss: 2, weeks_without_miss: 1 },
    gear: [],
    planning_periods: [],
    coach_memories: [],
    health: { actual_workouts: [] },
    active_plan: {
      activities: [
        {
          activity_id: "lower",
          date: "2026-11-11",
          title: "Lower body strength",
          type: "strength",
          required_or_optional: "required",
          completion: { completed: false },
          subtasks: [],
          equipment: ["Barbell", "Rack"]
        },
        {
          activity_id: "upper",
          date: "2026-11-13",
          title: "Upper body",
          type: "strength",
          required_or_optional: "required",
          completion: { completed: false },
          subtasks: []
        }
      ]
    }
  };
}

async function waitFor(predicate) {
  let lastError = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if (predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(lastError ? lastError.message : "timed out waiting for the dashboard");
}

test("visibility date change keeps unsaved goals, notes, and other dashboard input", async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "UTC";
  const calls = [];
  const errors = [];
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:4173/",
    pretendToBeVisual: true,
    runScripts: "outside-only"
  });
  const { window } = dom;
  const context = dom.getInternalVMContext();
  window.addEventListener("error", (event) => {
    errors.push(String(event.error || event.message));
  });

  try {
    runInPage(context, `
      const RealDate = Date;
      let nowMs = ${Date.parse("2026-11-11T15:00:00Z")};
      class ClockDate extends RealDate {
        constructor(...args) {
          super(...(args.length ? args : [nowMs]));
        }
        static now() { return nowMs; }
      }
      globalThis.Date = ClockDate;
      globalThis.__setNow = (ms) => { nowMs = ms; };
    `, "clock.js");

    window.fetch = async (input, options = {}) => {
      const url = String(input?.url || input);
      const method = String(options.method || "GET").toUpperCase();
      calls.push({ url, method, body: options.body ? String(options.body) : "" });
      const respond = (status, body) => ({
        status,
        ok: status >= 200 && status < 300,
        json: async () => body
      });
      if (url.includes("/api/session")) return respond(200, { authenticated: true });
      if (url.includes("/api/state")) return respond(200, pageFixture());
      if (url.includes("/api/coach-summary")) return respond(200, { summary_text: "Synthetic summary" });
      return respond(500, { error: "synthetic test does not save this write" });
    };

    for (const file of ["activity-summary.js", "today-list.js", "app.js"]) {
      runInPage(context, fs.readFileSync(path.join(root, file), "utf8"), file);
    }

    const { document } = window;
    await waitFor(() => document.querySelector("#goal-primary").value === savedGoal
      && document.querySelector("#today-list h3")?.textContent === "Lower body strength"
      && document.querySelector("#today-switch-select option[value='upper']"));

    assert.equal(document.querySelector("#date-label").textContent.includes("11"), true);
    assert.equal(document.querySelector(".today-fallback-notice"), null);
    assert.equal(document.querySelectorAll("#week-grid h3.is-today").length, 1);
    assert.equal(document.querySelector("#week-grid article[data-activity-id='lower']").classList.contains("is-collapsed"), false);

    typeInto(window, document.querySelector("#goal-primary"), typedGoal);
    typeInto(window, document.querySelector("#goal-back-health"), typedBackHealth);
    typeInto(window, document.querySelector("#coach-notes"), typedNotes);
    typeInto(window, document.querySelector("#planning-period-title"), typedPeriod);
    typeInto(window, document.querySelector("#plan-json"), typedPlan);
    typeInto(window, document.querySelector("#week-grid article[data-activity-id='lower'] textarea[name='notes']"), typedWorkoutNote);
    document.querySelector("#today-switch-select").value = "upper";

    assert.equal(document.visibilityState, "visible");
    document.dispatchEvent(new window.Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(document.querySelector(".today-fallback-notice"), null);
    assert.equal(document.querySelector("#goal-primary").value, typedGoal);

    window.__setNow(Date.parse("2026-11-12T15:00:00Z"));
    document.dispatchEvent(new window.Event("visibilitychange"));
    await waitFor(() => document.querySelector(".today-fallback-notice")?.textContent.includes("Lower body strength"));

    const notice = document.querySelector(".today-fallback-notice").textContent;
    assert.equal(notice.startsWith("Nothing scheduled today, showing next unfinished:"), true);
    assert.equal(notice.includes("Lower body strength"), true);
    assert.equal(document.querySelector("#date-label").textContent.includes("12"), true);
    assert.equal(document.querySelector("#date-label").textContent.includes("11"), false);
    assert.equal(document.querySelectorAll("#week-grid h3.is-today").length, 0);
    assert.equal(document.querySelector("#week-grid article[data-activity-id='lower']").classList.contains("is-collapsed"), true);

    assert.equal(document.querySelector("#goal-primary").value, typedGoal);
    assert.equal(document.querySelector("#goal-back-health").value, typedBackHealth);
    assert.equal(document.querySelector("#goal-race-date").value, "2026-10-18");
    assert.equal(document.querySelector("#goal-recovery").value, "Saved recovery");
    assert.equal(document.querySelector("#coach-notes").value, typedNotes);
    assert.equal(document.querySelector("#planning-period-title").value, typedPeriod);
    assert.equal(document.querySelector("#plan-json").value, typedPlan);
    assert.equal(
      document.querySelector("#week-grid article[data-activity-id='lower'] textarea[name='notes']").value,
      typedWorkoutNote
    );
    assert.equal(
      document.querySelector("#today-list article[data-activity-id='lower'] textarea[name='notes']").value,
      ""
    );
    assert.equal(document.querySelector("#today-switch-select").value, "upper");

    const writes = calls.filter((call) => !["GET", "HEAD"].includes(call.method));
    assert.equal(writes.some((call) => call.url.includes("/api/goals")), false);
    assert.equal(writes.some((call) => call.url.includes("/api/coach-notes")), false);
    assert.equal(errors.length, 0, errors.join("\n"));
  } finally {
    dom.window.close();
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

test("date refresh keeps a saved edit instead of restoring the untouched duplicate card", async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "UTC";
  const savedFromToday = "Notes saved from the today card";
  const state = pageFixture();
  const calls = [];
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:4173/",
    pretendToBeVisual: true,
    runScripts: "outside-only"
  });
  const { window } = dom;
  const context = dom.getInternalVMContext();

  try {
    runInPage(context, `
      const RealDate = Date;
      let nowMs = ${Date.parse("2026-11-11T15:00:00Z")};
      class ClockDate extends RealDate {
        constructor(...args) {
          super(...(args.length ? args : [nowMs]));
        }
        static now() { return nowMs; }
      }
      globalThis.Date = ClockDate;
      globalThis.__setNow = (ms) => { nowMs = ms; };
    `, "clock.js");

    window.fetch = async (input, options = {}) => {
      const url = String(input?.url || input);
      const method = String(options.method || "GET").toUpperCase();
      calls.push({ url, method, body: options.body ? String(options.body) : "" });
      const respond = (status, body) => ({
        status,
        ok: status >= 200 && status < 300,
        json: async () => body
      });
      if (url.includes("/api/session")) return respond(200, { authenticated: true });
      if (url.includes("/api/state")) return respond(200, state);
      if (url.includes("/api/coach-summary")) return respond(200, { summary_text: "Synthetic summary" });
      if (method === "POST" && url.includes("/api/activities/lower/feedback")) {
        const activity = state.active_plan.activities.find((item) => item.activity_id === "lower");
        activity.feedback = { ...(activity.feedback || {}), ...JSON.parse(options.body) };
        return respond(200, state);
      }
      return respond(500, { error: "synthetic test does not save this write" });
    };

    for (const file of ["activity-summary.js", "today-list.js", "app.js"]) {
      runInPage(context, fs.readFileSync(path.join(root, file), "utf8"), file);
    }

    const { document } = window;
    await waitFor(() => document.querySelector("#goal-primary").value === savedGoal
      && document.querySelector("#today-list textarea[name='notes']"));

    typeInto(window, document.querySelector("#goal-primary"), typedGoal);
    typeInto(window, document.querySelector("#coach-notes"), typedNotes);
    typeInto(window, document.querySelector("#today-list textarea[name='notes']"), savedFromToday);
    assert.equal(document.querySelector("#week-grid textarea[name='notes']").value, "");

    window.__setNow(Date.parse("2026-11-12T15:00:00Z"));
    document.dispatchEvent(new window.Event("visibilitychange"));
    await waitFor(() => document.querySelector("#week-grid article[data-activity-id='lower'] textarea[name='notes']").value === savedFromToday);

    assert.equal(
      document.querySelector("#today-list article[data-activity-id='lower'] textarea[name='notes']").value,
      savedFromToday
    );
    assert.equal(document.querySelector("#goal-primary").value, typedGoal);
    assert.equal(document.querySelector("#coach-notes").value, typedNotes);
    assert.equal(calls.some((call) => call.method === "PUT" && call.url.includes("/api/goals")), false);
    assert.equal(calls.some((call) => call.method === "PUT" && call.url.includes("/api/coach-notes")), false);

    window.__setNow(Date.parse("2026-11-13T15:00:00Z"));
    document.dispatchEvent(new window.Event("visibilitychange"));
    await waitFor(() => document.querySelector("#today-list h3")?.textContent === "Upper body"
      && document.querySelector("#week-grid article[data-activity-id='lower'] textarea[name='notes']").value === savedFromToday);
    assert.equal(document.querySelector(".today-fallback-notice"), null);
    assert.equal(document.querySelector("#goal-primary").value, typedGoal);
    assert.equal(document.querySelector("#coach-notes").value, typedNotes);
  } finally {
    dom.window.close();
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

function plankState() {
  const state = pageFixture();
  state.active_plan.activities = [{
    activity_id: "core",
    date: "2026-11-11",
    title: "Core",
    type: "strength",
    required_or_optional: "required",
    completion: { completed: false },
    subtasks: [{ subtask_id: "plank", title: "Plank", log_mode: "timed" }]
  }];
  return state;
}

function installClock(context, startMs) {
  runInPage(context, `
    const RealDate = Date;
    let nowMs = ${startMs};
    class ClockDate extends RealDate {
      constructor(...args) {
        super(...(args.length ? args : [nowMs]));
      }
      static now() { return nowMs; }
    }
    globalThis.Date = ClockDate;
    globalThis.__setNow = (ms) => { nowMs = ms; };
  `, "clock.js");
}

function loadPageScripts(context) {
  for (const file of ["activity-summary.js", "today-list.js", "app.js"]) {
    runInPage(context, fs.readFileSync(path.join(root, file), "utf8"), file);
  }
}

function shownSeconds(value, unit) {
  if (value === "" || value == null) return "";
  const number = Number(value);
  if (!Number.isFinite(number)) return "";
  return String(Math.round(number * (unit === "min" ? 60 : 1)));
}

test("date refresh does not turn a saved 2.5 min duration into 2.5 sec", async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "UTC";
  const state = plankState();
  const calls = [];
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:4173/",
    pretendToBeVisual: true,
    runScripts: "outside-only"
  });
  const { window } = dom;
  const context = dom.getInternalVMContext();

  try {
    installClock(context, Date.parse("2026-11-11T15:00:00Z"));
    window.fetch = async (input, options = {}) => {
      const url = String(input?.url || input);
      const method = String(options.method || "GET").toUpperCase();
      const body = options.body ? String(options.body) : "";
      calls.push({ url, method, body });
      const respond = (status, payload) => ({
        status,
        ok: status >= 200 && status < 300,
        json: async () => payload
      });
      if (url.includes("/api/session")) return respond(200, { authenticated: true });
      if (url.includes("/api/state")) return respond(200, state);
      if (url.includes("/api/coach-summary")) return respond(200, { summary_text: "Synthetic summary" });
      if (method === "POST" && url.includes("/exercise-log")) {
        const payload = JSON.parse(body);
        const activity = state.active_plan.activities.find((item) => item.activity_id === "core");
        activity.exercise_logs = { ...(activity.exercise_logs || {}), [payload.exercise_id]: payload };
        return respond(200, state);
      }
      return respond(500, { error: "synthetic test does not save this write" });
    };
    loadPageScripts(context);

    const { document } = window;
    await waitFor(() => document.querySelector("#today-list input[name='duration_value']"));
    const duration = document.querySelector("#today-list input[name='duration_value']");
    const unit = document.querySelector("#today-list select[name='duration_unit']");
    assert.equal(unit.value, "min");
    duration.value = "2.5";
    duration.dispatchEvent(new window.InputEvent("input", { bubbles: true, data: "2.5", inputType: "insertText" }));
    typeInto(window, document.querySelector("#goal-primary"), typedGoal);

    window.__setNow(Date.parse("2026-11-12T15:00:00Z"));
    document.dispatchEvent(new window.Event("visibilitychange"));
    await waitFor(() => document.querySelector(".today-fallback-notice")
      && document.querySelector("#today-list input[name='duration_value']").value === "150"
      && document.querySelector("#today-list select[name='duration_unit']").value === "sec"
      && document.querySelector("#week-grid input[name='duration_value']").value === "150");

    for (const rootId of ["#today-list", "#week-grid"]) {
      const shownValue = document.querySelector(`${rootId} input[name='duration_value']`).value;
      const shownUnit = document.querySelector(`${rootId} select[name='duration_unit']`).value;
      assert.equal(shownSeconds(shownValue, shownUnit), "150");
      assert.equal(`${shownValue} ${shownUnit}`, "150 sec");
    }
    assert.equal(document.querySelector("#goal-primary").value, typedGoal);

    window.__setNow(Date.parse("2026-11-13T15:00:00Z"));
    document.dispatchEvent(new window.Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    await waitFor(() => document.querySelector("#today-list input[name='duration_value']").value === "150"
      && document.querySelector("#today-list select[name='duration_unit']").value === "sec");

    const loggedSeconds = calls
      .filter((call) => call.method === "POST" && call.url.includes("/exercise-log"))
      .map((call) => JSON.parse(call.body).duration_seconds);
    assert.ok(loggedSeconds.length >= 1);
    assert.deepEqual(loggedSeconds.every((value) => value === "150"), true);
    assert.equal(shownSeconds(
      document.querySelector("#today-list input[name='duration_value']").value,
      document.querySelector("#today-list select[name='duration_unit']").value
    ), "150");
    assert.equal(document.querySelector("#goal-primary").value, typedGoal);
  } finally {
    dom.window.close();
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

function feedbackNotes(calls) {
  return calls
    .filter((call) => call.method === "POST" && call.url.includes("/feedback"))
    .map((call) => JSON.parse(call.body).notes);
}

test("date refresh keeps the newest saved notes on both copies of a workout", async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "UTC";
  const state = pageFixture();
  const calls = [];
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:4173/",
    pretendToBeVisual: true,
    runScripts: "outside-only"
  });
  const { window } = dom;

  try {
    installClock(dom.getInternalVMContext(), Date.parse("2026-11-11T15:00:00Z"));
    window.fetch = async (input, options = {}) => {
      const url = String(input?.url || input);
      const method = String(options.method || "GET").toUpperCase();
      const body = options.body ? String(options.body) : "";
      calls.push({ url, method, body });
      const respond = (status, payload) => ({
        status,
        ok: status >= 200 && status < 300,
        json: async () => payload
      });
      if (url.includes("/api/session")) return respond(200, { authenticated: true });
      if (url.includes("/api/state")) return respond(200, state);
      if (url.includes("/api/coach-summary")) return respond(200, { summary_text: "Synthetic summary" });
      if (method === "POST" && url.includes("/feedback")) {
        const payload = JSON.parse(body);
        const activity = state.active_plan.activities.find((item) => item.activity_id === "lower");
        activity.feedback = { ...(activity.feedback || {}), ...payload };
        return respond(200, state);
      }
      return respond(500, { error: "synthetic test does not save this write" });
    };
    loadPageScripts(dom.getInternalVMContext());

    const { document } = window;
    await waitFor(() => document.querySelector("#today-list textarea[name='notes']")
      && document.querySelector("#week-grid article[data-activity-id='lower'] textarea[name='notes']"));
    typeInto(window, document.querySelector("#today-list textarea[name='notes']"), "Notes A");
    await waitFor(() => feedbackNotes(calls).includes("Notes A"));
    typeInto(window, document.querySelector("#week-grid article[data-activity-id='lower'] textarea[name='notes']"), "Notes B");
    await waitFor(() => feedbackNotes(calls).includes("Notes B"));
    assert.equal(document.querySelector("#today-list textarea[name='notes']").value, "Notes A");

    const postsBeforeRefresh = feedbackNotes(calls).length;
    window.__setNow(Date.parse("2026-11-12T15:00:00Z"));
    document.dispatchEvent(new window.Event("visibilitychange"));
    await waitFor(() => document.querySelector("#today-list textarea[name='notes']").value === "Notes B"
      && document.querySelector("#week-grid article[data-activity-id='lower'] textarea[name='notes']").value === "Notes B");

    window.__setNow(Date.parse("2026-11-13T15:00:00Z"));
    document.dispatchEvent(new window.Event("visibilitychange"));
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(document.querySelector("#week-grid article[data-activity-id='lower'] textarea[name='notes']").value, "Notes B");
    assert.deepEqual(feedbackNotes(calls).slice(postsBeforeRefresh), []);
    assert.equal(feedbackNotes(calls).includes("Notes A") && feedbackNotes(calls).at(-1) === "Notes A" && feedbackNotes(calls).length > 2, false);
  } finally {
    dom.window.close();
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

test("a failed workout-note save stays on screen after a date refresh", async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "UTC";
  const state = pageFixture();
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:4173/",
    pretendToBeVisual: true,
    runScripts: "outside-only"
  });
  const { window } = dom;

  try {
    installClock(dom.getInternalVMContext(), Date.parse("2026-11-11T15:00:00Z"));
    window.fetch = async (input, options = {}) => {
      const url = String(input?.url || input);
      const method = String(options.method || "GET").toUpperCase();
      const respond = (status, payload) => ({
        status,
        ok: status >= 200 && status < 300,
        json: async () => payload
      });
      if (url.includes("/api/session")) return respond(200, { authenticated: true });
      if (url.includes("/api/state")) return respond(200, state);
      if (url.includes("/api/coach-summary")) return respond(200, { summary_text: "Synthetic summary" });
      return respond(500, { error: "synthetic test does not save this write" });
    };
    loadPageScripts(dom.getInternalVMContext());

    const { document } = window;
    await waitFor(() => document.querySelector("#today-list textarea[name='notes']"));
    const unsaved = "Unsaved note that failed to save";
    typeInto(window, document.querySelector("#today-list textarea[name='notes']"), unsaved);
    typeInto(window, document.querySelector("#goal-primary"), typedGoal);
    typeInto(window, document.querySelector("#coach-notes"), typedNotes);

    window.__setNow(Date.parse("2026-11-12T15:00:00Z"));
    document.dispatchEvent(new window.Event("visibilitychange"));
    await waitFor(() => document.querySelector(".today-fallback-notice"));
    assert.equal(document.querySelector("#today-list textarea[name='notes']").value, unsaved);
    assert.equal(document.querySelector("#week-grid article[data-activity-id='lower'] textarea[name='notes']").value, "");
    assert.equal(document.querySelector("#goal-primary").value, typedGoal);
    assert.equal(document.querySelector("#coach-notes").value, typedNotes);
  } finally {
    dom.window.close();
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

function mobilityState() {
  const state = pageFixture();
  state.active_plan.activities = [{
    activity_id: "mobility",
    date: "2026-11-11",
    title: "Mobility",
    type: "strength",
    required_or_optional: "required",
    completion: { completed: false },
    subtasks: []
  }];
  return state;
}

function durationPosts(calls) {
  return calls
    .filter((call) => call.method === "POST" && call.url.includes("/exercise-log"))
    .map((call) => JSON.parse(call.body));
}

test("standalone exercise-log 2.5 min keeps its unit when the save fails", async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "UTC";
  const state = mobilityState();
  const calls = [];
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:4173/",
    pretendToBeVisual: true,
    runScripts: "outside-only"
  });
  const { window } = dom;

  try {
    installClock(dom.getInternalVMContext(), Date.parse("2026-11-11T15:00:00Z"));
    window.fetch = async (input, options = {}) => {
      const url = String(input?.url || input);
      const method = String(options.method || "GET").toUpperCase();
      const body = options.body ? String(options.body) : "";
      calls.push({ url, method, body });
      const respond = (status, payload) => ({
        status,
        ok: status >= 200 && status < 300,
        json: async () => payload
      });
      if (url.includes("/api/session")) return respond(200, { authenticated: true });
      if (url.includes("/api/state")) return respond(200, state);
      if (url.includes("/api/coach-summary")) return respond(200, { summary_text: "Synthetic summary" });
      return respond(500, { error: "synthetic test does not save this write" });
    };
    loadPageScripts(dom.getInternalVMContext());

    const { document } = window;
    await waitFor(() => document.querySelector("#today-list .exercise-log-row input[name='duration_value']"));
    const row = document.querySelector("#today-list .exercise-log-row");
    assert.equal(row.dataset.exerciseId, "activity");
    assert.equal(document.querySelector("#today-list .subtask-row"), null);
    const duration = row.querySelector("input[name='duration_value']");
    const unit = row.querySelector("select[name='duration_unit']");
    assert.equal(unit.value, "min");
    duration.value = "2.5";
    duration.dispatchEvent(new window.InputEvent("input", { bubbles: true, data: "2.5", inputType: "insertText" }));

    window.__setNow(Date.parse("2026-11-12T15:00:00Z"));
    document.dispatchEvent(new window.Event("visibilitychange"));
    await waitFor(() => document.querySelector(".today-fallback-notice")
      && document.querySelector("#today-list .exercise-log-row input[name='duration_value']"));

    for (const rootId of ["#today-list", "#week-grid"]) {
      const shownValue = document.querySelector(`${rootId} .exercise-log-row input[name='duration_value']`).value;
      const shownUnit = document.querySelector(`${rootId} .exercise-log-row select[name='duration_unit']`).value;
      assert.equal(shownSeconds(shownValue, shownUnit), "150", `${rootId} showed ${shownValue} ${shownUnit}`);
      assert.notEqual(`${shownValue} ${shownUnit}`, "2.5 sec");
    }

    const postsBeforeLaterFlush = durationPosts(calls).length;
    window.__setNow(Date.parse("2026-11-13T15:00:00Z"));
    document.dispatchEvent(new window.Event("visibilitychange"));
    await waitFor(() => document.querySelector("#date-label").textContent.includes("13")
      && durationPosts(calls).length > postsBeforeLaterFlush);
    const logged = durationPosts(calls);
    assert.ok(logged.length > postsBeforeLaterFlush);
    assert.equal(logged.every((entry) => entry.exercise_id === "activity" && entry.duration_seconds === "150"), true);
    assert.equal(logged.some((entry) => entry.duration_seconds === "3"), false);
    assert.equal(shownSeconds(
      document.querySelector("#today-list .exercise-log-row input[name='duration_value']").value,
      document.querySelector("#today-list .exercise-log-row select[name='duration_unit']").value
    ), "150");
  } finally {
    dom.window.close();
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

function linkChoiceState() {
  const state = pageFixture();
  const activity = state.active_plan.activities.find((item) => item.activity_id === "lower");
  activity.actuals = [];
  activity.actual_match_candidates = [
    { actual_id: "actual-easy", name: "Easy run", type: "run", duration_minutes: 30, linked: false },
    { actual_id: "actual-strength", name: "Strength session", type: "lift", duration_minutes: 40, linked: false }
  ];
  return state;
}

test("a failed actual-link keeps the unsaved choice across a date refresh", async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "UTC";
  const state = linkChoiceState();
  const calls = [];
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:4173/",
    pretendToBeVisual: true,
    runScripts: "outside-only"
  });
  const { window } = dom;

  try {
    installClock(dom.getInternalVMContext(), Date.parse("2026-11-11T15:00:00Z"));
    window.fetch = async (input, options = {}) => {
      const url = String(input?.url || input);
      const method = String(options.method || "GET").toUpperCase();
      const body = options.body ? String(options.body) : "";
      calls.push({ url, method, body });
      const respond = (status, payload) => ({
        status,
        ok: status >= 200 && status < 300,
        json: async () => payload
      });
      if (url.includes("/api/session")) return respond(200, { authenticated: true });
      if (url.includes("/api/state")) return respond(200, state);
      if (url.includes("/api/coach-summary")) return respond(200, { summary_text: "Synthetic summary" });
      return respond(500, { error: "synthetic test does not save this write" });
    };
    loadPageScripts(dom.getInternalVMContext());

    const { document } = window;
    await waitFor(() => document.querySelector("#today-list select[name='actual_id']"));
    const form = document.querySelector("#today-list .actual-link-form");
    const select = form.querySelector("select[name='actual_id']");
    assert.equal(select.value, "");
    select.value = "actual-strength";
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    assert.equal(select.dataset.userEdited, "true");
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));

    await waitFor(() => document.querySelector("#message")?.textContent.includes("synthetic test does not save this write"));
    assert.equal(select.isConnected, true);
    assert.equal(select.value, "actual-strength");
    assert.equal(select.dataset.userEdited, "true");
    assert.equal(calls.some((call) => call.method === "POST" && call.url.includes("/actual-link") && call.body.includes("actual-strength")), true);

    window.__setNow(Date.parse("2026-11-12T15:00:00Z"));
    document.dispatchEvent(new window.Event("visibilitychange"));
    await waitFor(() => document.querySelector(".today-fallback-notice")
      && document.querySelector("#today-list select[name='actual_id']"));
    assert.equal(document.querySelector("#today-list select[name='actual_id']").value, "actual-strength");
    assert.equal(document.querySelector("#today-list select[name='actual_id']").dataset.userEdited, "true");
  } finally {
    dom.window.close();
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

test("reverting notes to the saved value does not overwrite a newer week save", async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "UTC";
  const state = pageFixture();
  const calls = [];
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:4173/",
    pretendToBeVisual: true,
    runScripts: "outside-only"
  });
  const { window } = dom;

  try {
    installClock(dom.getInternalVMContext(), Date.parse("2026-11-11T15:00:00Z"));
    window.fetch = async (input, options = {}) => {
      const url = String(input?.url || input);
      const method = String(options.method || "GET").toUpperCase();
      const body = options.body ? String(options.body) : "";
      calls.push({ url, method, body });
      const respond = (status, payload) => ({
        status,
        ok: status >= 200 && status < 300,
        json: async () => payload
      });
      if (url.includes("/api/session")) return respond(200, { authenticated: true });
      if (url.includes("/api/state")) return respond(200, state);
      if (url.includes("/api/coach-summary")) return respond(200, { summary_text: "Synthetic summary" });
      if (method === "POST" && url.includes("/feedback")) {
        const payload = JSON.parse(body);
        const activity = state.active_plan.activities.find((item) => item.activity_id === "lower");
        activity.feedback = { ...(activity.feedback || {}), ...payload };
        return respond(200, state);
      }
      return respond(500, { error: "synthetic test does not save this write" });
    };
    loadPageScripts(dom.getInternalVMContext());

    const { document } = window;
    await waitFor(() => document.querySelector("#today-list textarea[name='notes']")
      && document.querySelector("#week-grid article[data-activity-id='lower'] textarea[name='notes']"));
    const todayNotes = document.querySelector("#today-list textarea[name='notes']");
    const weekNotes = document.querySelector("#week-grid article[data-activity-id='lower'] textarea[name='notes']");
    typeInto(window, todayNotes, "Notes A");
    await waitFor(() => feedbackNotes(calls).includes("Notes A") && todayNotes.dataset.userEdited !== "true");

    todayNotes.value = "Notes X";
    todayNotes.dispatchEvent(new window.InputEvent("input", { bubbles: true, data: "Notes X", inputType: "insertText" }));
    todayNotes.value = "Notes A";
    todayNotes.dispatchEvent(new window.InputEvent("input", { bubbles: true, data: "Notes A", inputType: "insertText" }));
    assert.equal(todayNotes.dataset.userEdited, "true");
    await waitFor(() => todayNotes.dataset.userEdited !== "true");
    assert.equal(todayNotes.value, "Notes A");
    assert.equal(feedbackNotes(calls).includes("Notes X"), false);

    typeInto(window, weekNotes, "Notes B");
    await waitFor(() => feedbackNotes(calls).includes("Notes B") && weekNotes.dataset.userEdited !== "true");
    assert.equal(todayNotes.value, "Notes A");
    const postsBeforeRefresh = feedbackNotes(calls).length;

    window.__setNow(Date.parse("2026-11-12T15:00:00Z"));
    document.dispatchEvent(new window.Event("visibilitychange"));
    await waitFor(() => document.querySelector("#today-list textarea[name='notes']").value === "Notes B"
      && document.querySelector("#week-grid article[data-activity-id='lower'] textarea[name='notes']").value === "Notes B");

    window.__setNow(Date.parse("2026-11-13T15:00:00Z"));
    document.dispatchEvent(new window.Event("visibilitychange"));
    await waitFor(() => document.querySelector("#date-label").textContent.includes("13")
      && document.querySelector("#today-list h3")?.textContent === "Upper body");
    assert.equal(document.querySelector("#week-grid article[data-activity-id='lower'] textarea[name='notes']").value, "Notes B");
    assert.deepEqual(feedbackNotes(calls).slice(postsBeforeRefresh).filter((note) => note === "Notes A"), []);
  } finally {
    dom.window.close();
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

function exerciseWeights(calls) {
  return calls
    .filter((call) => call.method === "POST" && call.url.includes("/exercise-log"))
    .map((call) => String(JSON.parse(call.body).weight_lbs));
}

function openDateRefreshPage(state) {
  const calls = [];
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const dom = new JSDOM(html, {
    url: "http://127.0.0.1:4173/",
    pretendToBeVisual: true,
    runScripts: "outside-only"
  });
  const { window } = dom;
  installClock(dom.getInternalVMContext(), Date.parse("2026-11-11T15:00:00Z"));
  window.fetch = async (input, options = {}) => {
    const url = String(input?.url || input);
    const method = String(options.method || "GET").toUpperCase();
    const body = options.body ? String(options.body) : "";
    calls.push({ url, method, body });
    const respond = (status, payload) => ({
      status,
      ok: status >= 200 && status < 300,
      json: async () => payload
    });
    if (url.includes("/api/session")) return respond(200, { authenticated: true });
    if (url.includes("/api/state")) return respond(200, state);
    if (url.includes("/api/coach-summary")) return respond(200, { summary_text: "Synthetic summary" });
    if (method === "POST" && url.includes("/exercise-log")) {
      const payload = JSON.parse(body);
      if (window.__failExerciseSaves) return respond(503, { error: "offline" });
      const activity = state.active_plan.activities.find((item) => item.activity_id === "lower");
      activity.exercise_logs = { ...(activity.exercise_logs || {}), [payload.exercise_id]: payload };
      return respond(200, state);
    }
    return respond(500, { error: "synthetic test does not save this write" });
  };
  loadPageScripts(dom.getInternalVMContext());
  return { dom, window, calls };
}

test("reverting today's exercise weight after a week save does not overwrite that later weight", async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "UTC";
  const state = pageFixture();
  const { dom, window, calls } = openDateRefreshPage(state);

  try {
    const { document } = window;
    const weightInput = (root) => document.querySelector(`${root} article[data-activity-id='lower'] input[name='weight_lbs']`);
    await waitFor(() => weightInput("#today-list") && weightInput("#week-grid"));
    const todayWeight = weightInput("#today-list");
    const weekWeight = weightInput("#week-grid");

    typeInto(window, todayWeight, "10");
    await waitFor(() => exerciseWeights(calls).includes("10") && todayWeight.dataset.userEdited !== "true");

    typeInto(window, weekWeight, "30");
    await waitFor(() => exerciseWeights(calls).includes("30") && weekWeight.dataset.userEdited !== "true");
    assert.deepEqual(exerciseWeights(calls), ["10", "30"]);

    todayWeight.value = "20";
    todayWeight.dispatchEvent(new window.InputEvent("input", { bubbles: true, data: "20", inputType: "insertText" }));
    todayWeight.value = "10";
    todayWeight.dispatchEvent(new window.InputEvent("input", { bubbles: true, data: "10", inputType: "insertText" }));
    assert.equal(todayWeight.value, "10");
    assert.equal(todayWeight.dataset.userEdited, "true");
    await waitFor(() => todayWeight.dataset.userEdited !== "true");
    assert.equal(exerciseWeights(calls).includes("20"), false);
    assert.deepEqual(exerciseWeights(calls), ["10", "30"]);
    const postsBeforeRefresh = exerciseWeights(calls).length;

    window.__setNow(Date.parse("2026-11-12T15:00:00Z"));
    document.dispatchEvent(new window.Event("visibilitychange"));
    await waitFor(() => document.querySelector(".today-fallback-notice")
      && weightInput("#today-list").value === "30"
      && weightInput("#week-grid").value === "30");

    window.__setNow(Date.parse("2026-11-13T15:00:00Z"));
    document.dispatchEvent(new window.Event("visibilitychange"));
    await waitFor(() => document.querySelector("#date-label").textContent.includes("13")
      && document.querySelector("#today-list h3")?.textContent === "Upper body");
    assert.equal(weightInput("#week-grid").value, "30");
    assert.deepEqual(exerciseWeights(calls).slice(postsBeforeRefresh).filter((weight) => weight === "10"), []);
    assert.equal(exerciseWeights(calls).at(-1), "30");
  } finally {
    dom.window.close();
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

test("an equal-signature exercise flush keeps a draft that is still ahead of the server", async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "UTC";
  const state = pageFixture();
  const { dom, window, calls } = openDateRefreshPage(state);

  try {
    const { document } = window;
    const todayWeight = () => document.querySelector("#today-list article[data-activity-id='lower'] input[name='weight_lbs']");
    const weekWeight = () => document.querySelector("#week-grid article[data-activity-id='lower'] input[name='weight_lbs']");
    await waitFor(() => todayWeight() && weekWeight());
    assert.equal(todayWeight().closest("[data-exercise-id]").dataset.exerciseId, "activity");

    typeInto(window, todayWeight(), "10");
    await waitFor(() => exerciseWeights(calls).includes("10") && todayWeight().dataset.userEdited !== "true");

    const currentToday = todayWeight();
    const currentWeek = weekWeight();
    currentWeek.value = "40";
    currentWeek.dispatchEvent(new window.InputEvent("input", { bubbles: true, data: "40", inputType: "insertText" }));
    currentToday.dispatchEvent(new window.Event("blur"));
    await new Promise((resolve) => setTimeout(resolve, 30));

    const draftKey = "coach_loop_exercise_log_draft:lower:activity";
    const stored = JSON.parse(window.localStorage.getItem(draftKey) || "null");
    assert.equal(stored?.weight_lbs, "40");
    assert.equal(exerciseWeights(calls).includes("40"), false);

    await waitFor(() => exerciseWeights(calls).includes("40"));
    assert.equal(exerciseWeights(calls).at(-1), "40");
  } finally {
    dom.window.close();
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

test("a failed week weight draft survives today's equal-signature flush", async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "UTC";
  const state = pageFixture();
  const { dom, window, calls } = openDateRefreshPage(state);
  const draftKey = "coach_loop_exercise_log_draft:lower:activity";

  try {
    const { document } = window;
    const weightInput = (root) => document.querySelector(`${root} article[data-activity-id='lower'] input[name='weight_lbs']`);
    const storedWeight = () => JSON.parse(window.localStorage.getItem(draftKey) || "null")?.weight_lbs;
    const savedWeight = () => state.active_plan.activities.find((item) => item.activity_id === "lower").exercise_logs.activity.weight_lbs;
    await waitFor(() => weightInput("#today-list") && weightInput("#week-grid"));
    const todayWeight = weightInput("#today-list");
    const weekWeight = weightInput("#week-grid");

    typeInto(window, todayWeight, "10");
    await waitFor(() => exerciseWeights(calls).includes("10") && todayWeight.dataset.userEdited !== "true");
    typeInto(window, weekWeight, "30");
    await waitFor(() => exerciseWeights(calls).includes("30") && weekWeight.dataset.userEdited !== "true");
    assert.equal(savedWeight(), "30");

    window.__failExerciseSaves = true;
    const before = calls.length;
    weekWeight.value = "10";
    weekWeight.dispatchEvent(new window.InputEvent("input", { bubbles: true, data: "10", inputType: "insertText" }));
    const weekStatus = weekWeight.closest("form").querySelector(".autosave-status");
    await waitFor(() => calls.length > before && weekStatus.textContent === "Not saved");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(storedWeight(), "10");
    assert.equal(weekWeight.dataset.userEdited, "true");
    assert.equal(weekWeight.value, "10");
    assert.equal(savedWeight(), "30");

    // Today blur flushes only this card. Week is not retried, so a deleted draft stays deleted.
    todayWeight.dispatchEvent(new window.Event("blur"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(storedWeight(), "10");

    const postsBeforeHide = exerciseWeights(calls).length;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new window.Event("visibilitychange"));
    await waitFor(() => exerciseWeights(calls).length > postsBeforeHide && weekStatus.textContent === "Not saved");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(storedWeight(), "10");
    assert.equal(savedWeight(), "30");
    assert.equal(weekWeight.dataset.userEdited, "true");

    window.dispatchEvent(new window.Event("pagehide"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(storedWeight(), "10");
    assert.equal(savedWeight(), "30");

    document.querySelector("#refresh-button").click();
    await waitFor(() => weightInput("#today-list")?.value === "10" && weightInput("#week-grid")?.value === "10");
    assert.equal(savedWeight(), "30");
    assert.equal(storedWeight(), "10");
  } finally {
    dom.window.close();
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

const lowerExerciseDraftKey = "coach_loop_exercise_log_draft:lower:activity";

function lowerWeightInput(document, root) {
  return document.querySelector(`${root} article[data-activity-id='lower'] input[name='weight_lbs']`);
}

function readLowerExerciseDraft(window) {
  return JSON.parse(window.localStorage.getItem(lowerExerciseDraftKey) || "null");
}

function setWeight(window, input, value) {
  input.value = value;
  input.dispatchEvent(new window.InputEvent("input", {
    bubbles: true,
    data: value,
    inputType: "insertText"
  }));
}

function holdExerciseLogPosts(window, state, calls) {
  const realFetch = window.fetch;
  const pending = [];
  window.__holdExerciseWeights = new Set();
  window.fetch = async (input, options = {}) => {
    const url = String(input?.url || input);
    const method = String(options.method || "GET").toUpperCase();
    const body = options.body ? String(options.body) : "";
    if (method === "POST" && url.includes("/exercise-log")) {
      let payload = null;
      try {
        payload = JSON.parse(body);
      } catch {
        payload = null;
      }
      if (payload && window.__holdExerciseWeights.has(String(payload.weight_lbs))) {
        calls.push({ url, method, body });
        let settle;
        const done = new Promise((resolve) => {
          settle = resolve;
        });
        pending.push({ weight: String(payload.weight_lbs), settle });
        const outcome = await done;
        if (!outcome?.ok) return { status: 503, ok: false, json: async () => ({ error: "offline" }) };
        const activity = state.active_plan.activities.find((item) => item.activity_id === "lower");
        activity.exercise_logs = { ...(activity.exercise_logs || {}), [payload.exercise_id]: payload };
        return { status: 200, ok: true, json: async () => state };
      }
    }
    return realFetch(input, options);
  };
  return {
    pending,
    hold(weights) {
      window.__holdExerciseWeights = new Set(weights.map((weight) => String(weight)));
    },
    release(weight, ok) {
      const index = pending.findIndex((entry) => entry.weight === String(weight));
      if (index < 0) throw new Error(`no held exercise-log save for ${weight}`);
      pending.splice(index, 1)[0].settle({ ok });
    },
    settleAll() {
      while (pending.length) pending.pop().settle({ ok: false });
    }
  };
}

function assertNoDraftOwnerLeak(calls, document, owner = "") {
  assert.equal(calls.some((call) => String(call.body || "").includes("draft_owner")), false);
  assert.equal(document.body.innerHTML.includes("draft_owner"), false);
  if (owner) assert.equal(document.body.innerHTML.includes(owner), false);
}

async function refreshLowerWeights(window) {
  const { document } = window;
  const previous = lowerWeightInput(document, "#today-list");
  document.querySelector("#refresh-button").click();
  await waitFor(() => {
    const today = lowerWeightInput(document, "#today-list");
    return today && today !== previous && today.value !== "";
  });
  return {
    today: lowerWeightInput(document, "#today-list").value,
    week: lowerWeightInput(document, "#week-grid").value
  };
}

async function hideDashboard(window) {
  Object.defineProperty(window.document, "visibilityState", {
    configurable: true,
    get: () => "hidden"
  });
  window.document.dispatchEvent(new window.Event("visibilitychange"));
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function saveInitialLowerWeights(window, calls) {
  const { document } = window;
  await waitFor(() => lowerWeightInput(document, "#today-list") && lowerWeightInput(document, "#week-grid"));
  const today = lowerWeightInput(document, "#today-list");
  const week = lowerWeightInput(document, "#week-grid");
  typeInto(window, today, "10");
  await waitFor(() => exerciseWeights(calls).includes("10") && today.dataset.userEdited !== "true");
  typeInto(window, week, "30");
  await waitFor(() => exerciseWeights(calls).includes("30") && week.dataset.userEdited !== "true");
  return { today, week };
}

async function runSupersededFailure(order) {
  const state = pageFixture();
  const page = openDateRefreshPage(state);
  const { dom, window, calls } = page;
  const gate = holdExerciseLogPosts(window, state, calls);
  const savedWeight = () => state.active_plan.activities.find((item) => item.activity_id === "lower").exercise_logs?.activity?.weight_lbs;
  try {
    const { today, week } = await saveInitialLowerWeights(window, calls);
    assert.equal(savedWeight(), "30");
    const weekStatus = () => week.closest("form").querySelector(".autosave-status");
    if (order === "newer-first") gate.hold(["10"]);
    else gate.hold(["10", "50"]);

    setWeight(window, week, "10");
    week.dispatchEvent(new window.Event("blur"));
    await waitFor(() => gate.pending.some((entry) => entry.weight === "10"));

    setWeight(window, today, "50");
    today.dispatchEvent(new window.Event("blur"));
    if (order === "newer-first") {
      await waitFor(() => savedWeight() === "50" && readLowerExerciseDraft(window) === null);
    } else {
      await waitFor(() => gate.pending.some((entry) => entry.weight === "50"));
      assert.equal(readLowerExerciseDraft(window)?.weight_lbs, "50");
      gate.release("10", false);
      await waitFor(() => weekStatus().textContent === "Not saved");
      assert.equal(readLowerExerciseDraft(window)?.weight_lbs, "50");
      assert.equal(savedWeight(), "30");
      gate.release("50", true);
      await waitFor(() => savedWeight() === "50" && readLowerExerciseDraft(window) === null);
    }

    const postsAfterNewerSave = exerciseWeights(calls).length;
    if (order === "newer-first") {
      gate.release("10", false);
      await waitFor(() => weekStatus().textContent === "Not saved");
      assert.equal(readLowerExerciseDraft(window), null);
    }
    assert.equal(savedWeight(), "50");
    assert.equal(exerciseWeights(calls).at(-1), "50");

    gate.hold([]);
    const shown = await refreshLowerWeights(window);
    assert.equal(shown.today, "50");
    assert.equal(shown.week, "50");
    assert.equal(readLowerExerciseDraft(window), null);
    await hideDashboard(window);
    assert.equal(exerciseWeights(calls).length, postsAfterNewerSave);
    assert.equal(exerciseWeights(calls).at(-1), "50");
    assert.equal(savedWeight(), "50");
    assert.equal(lowerWeightInput(window.document, "#today-list").value, "50");
    assert.equal(lowerWeightInput(window.document, "#week-grid").value, "50");
    assertNoDraftOwnerLeak(calls, window.document);
  } finally {
    gate.settleAll();
    dom.window.close();
  }
}

test("a failed exercise save does not restore a weight a newer save already replaced", async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "UTC";
  const failures = [];
  try {
    for (const order of ["newer-first", "failed-first"]) {
      try {
        await runSupersededFailure(order);
      } catch (error) {
        failures.push(`${order}: ${error.message}`);
      }
    }
    assert.equal(failures.length, 0, failures.join("\n"));
  } finally {
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

test("a failed exercise save restores a cleared draft when the saved log is unchanged", async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "UTC";
  const state = pageFixture();
  const { dom, window, calls } = openDateRefreshPage(state);
  const gate = holdExerciseLogPosts(window, state, calls);
  const savedWeight = () => state.active_plan.activities.find((item) => item.activity_id === "lower").exercise_logs?.activity?.weight_lbs;
  try {
    const { week } = await saveInitialLowerWeights(window, calls);
    assert.equal(savedWeight(), "30");
    gate.hold(["40"]);
    setWeight(window, week, "40");
    week.dispatchEvent(new window.Event("blur"));
    await waitFor(() => gate.pending.some((entry) => entry.weight === "40"));
    assert.equal(readLowerExerciseDraft(window)?.weight_lbs, "40");
    window.localStorage.removeItem(lowerExerciseDraftKey);
    assert.equal(readLowerExerciseDraft(window), null);

    gate.release("40", false);
    await waitFor(() => week.closest("form").querySelector(".autosave-status").textContent === "Not saved");
    const restored = readLowerExerciseDraft(window);
    assert.equal(restored?.weight_lbs, "40");
    assert.equal(typeof restored?.draft_owner, "string");
    assert.equal(restored.draft_owner.length > 0, true);
    assert.equal(savedWeight(), "30");
    assertNoDraftOwnerLeak(calls, window.document, restored.draft_owner);

    gate.hold([]);
    window.__failExerciseSaves = true;
    const shown = await refreshLowerWeights(window);
    assert.equal(shown.today, "40");
    assert.equal(shown.week, "40");
    assert.equal(savedWeight(), "30");
    assert.equal(readLowerExerciseDraft(window)?.weight_lbs, "40");
    assertNoDraftOwnerLeak(calls, window.document, restored.draft_owner);

    const postsBeforeHide = exerciseWeights(calls).length;
    await hideDashboard(window);
    await waitFor(() => exerciseWeights(calls).length > postsBeforeHide);
    assert.equal(savedWeight(), "30");
    assert.equal(readLowerExerciseDraft(window)?.weight_lbs, "40");
    assert.equal(exerciseWeights(calls).every((weight) => weight === "10" || weight === "30" || weight === "40"), true);
    assertNoDraftOwnerLeak(calls, window.document, readLowerExerciseDraft(window)?.draft_owner || restored.draft_owner);
  } finally {
    gate.settleAll();
    dom.window.close();
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

test("a later failed flush does not restore an edit a newer save already replaced", async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "UTC";
  const state = pageFixture();
  const { dom, window, calls } = openDateRefreshPage(state);
  const savedWeight = () => state.active_plan.activities.find((item) => item.activity_id === "lower").exercise_logs?.activity?.weight_lbs;
  try {
    const { today, week } = await saveInitialLowerWeights(window, calls);
    const weekStatus = () => week.closest("form").querySelector(".autosave-status");
    window.__failExerciseSaves = true;
    const postsBeforeFailedEdit = exerciseWeights(calls).length;
    setWeight(window, week, "10");
    week.dispatchEvent(new window.Event("blur"));
    await waitFor(() => exerciseWeights(calls).length > postsBeforeFailedEdit && weekStatus().textContent === "Not saved");
    assert.equal(readLowerExerciseDraft(window)?.weight_lbs, "10");
    assert.equal(savedWeight(), "30");

    window.__failExerciseSaves = false;
    setWeight(window, today, "50");
    today.dispatchEvent(new window.Event("blur"));
    await waitFor(() => savedWeight() === "50" && readLowerExerciseDraft(window) === null);

    window.__failExerciseSaves = true;
    const postsBeforeRetry = exerciseWeights(calls).length;
    week.dispatchEvent(new window.Event("blur"));
    await waitFor(() => exerciseWeights(calls).length > postsBeforeRetry && weekStatus().textContent === "Not saved");
    assert.equal(readLowerExerciseDraft(window), null);
    assert.equal(savedWeight(), "50");

    const postsAfterRetry = exerciseWeights(calls).length;
    const shown = await refreshLowerWeights(window);
    assert.equal(shown.today, "50");
    assert.equal(shown.week, "50");
    await hideDashboard(window);
    assert.equal(exerciseWeights(calls).length, postsAfterRetry);
    assert.equal(exerciseWeights(calls).at(-1), "10");
    assert.equal(savedWeight(), "50");
    assertNoDraftOwnerLeak(calls, window.document);
  } finally {
    dom.window.close();
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

test("a same-card overlap keeps the newer failed weight after the earlier save clears it", async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "UTC";
  const state = pageFixture();
  const { dom, window, calls } = openDateRefreshPage(state);
  const gate = holdExerciseLogPosts(window, state, calls);
  const savedWeight = () => state.active_plan.activities.find((item) => item.activity_id === "lower").exercise_logs?.activity?.weight_lbs;
  try {
    const { week } = await saveInitialLowerWeights(window, calls);
    assert.equal(savedWeight(), "30");
    const weekStatus = () => week.closest("form").querySelector(".autosave-status");
    gate.hold(["10", "20"]);

    setWeight(window, week, "10");
    week.dispatchEvent(new window.Event("blur"));
    await waitFor(() => gate.pending.some((entry) => entry.weight === "10"));
    setWeight(window, week, "20");
    week.dispatchEvent(new window.Event("blur"));
    await waitFor(() => gate.pending.some((entry) => entry.weight === "20"));

    gate.release("10", true);
    await waitFor(() => savedWeight() === "10" && readLowerExerciseDraft(window) === null);
    assert.equal(week.value, "20");

    gate.release("20", false);
    await waitFor(() => weekStatus().textContent === "Not saved");
    assert.equal(readLowerExerciseDraft(window)?.weight_lbs, "20");
    assert.equal(savedWeight(), "10");
    assert.equal(typeof readLowerExerciseDraft(window)?.draft_owner, "string");
    assertNoDraftOwnerLeak(calls, window.document, readLowerExerciseDraft(window).draft_owner);

    gate.hold([]);
    window.__failExerciseSaves = true;
    const shown = await refreshLowerWeights(window);
    assert.deepEqual(shown, { today: "20", week: "20" });
    assert.equal(savedWeight(), "10");
    assert.equal(readLowerExerciseDraft(window)?.weight_lbs, "20");
    assertNoDraftOwnerLeak(calls, window.document, readLowerExerciseDraft(window).draft_owner);
  } finally {
    gate.settleAll();
    dom.window.close();
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

test("a failed exercise save stays cleared when another card returns to this card's old value", async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "UTC";
  const state = pageFixture();
  const { dom, window, calls } = openDateRefreshPage(state);
  const gate = holdExerciseLogPosts(window, state, calls);
  const savedWeight = () => state.active_plan.activities.find((item) => item.activity_id === "lower").exercise_logs?.activity?.weight_lbs;
  try {
    const { today, week } = await saveInitialLowerWeights(window, calls);
    assert.equal(savedWeight(), "30");
    const weekStatus = () => week.closest("form").querySelector(".autosave-status");

    setWeight(window, today, "50");
    today.dispatchEvent(new window.Event("blur"));
    await waitFor(() => savedWeight() === "50" && today.dataset.userEdited !== "true");
    assert.equal(week.isConnected, true);

    gate.hold(["10"]);
    setWeight(window, week, "10");
    week.dispatchEvent(new window.Event("blur"));
    await waitFor(() => gate.pending.some((entry) => entry.weight === "10"));
    assert.equal(readLowerExerciseDraft(window)?.weight_lbs, "10");

    setWeight(window, today, "30");
    today.dispatchEvent(new window.Event("blur"));
    await waitFor(() => savedWeight() === "30" && today.dataset.userEdited !== "true" && readLowerExerciseDraft(window) === null);
    assert.equal(week.isConnected, true);
    assert.equal(week.value, "10");

    gate.release("10", false);
    await waitFor(() => weekStatus().textContent === "Not saved");
    assert.equal(week.value, "10");
    assert.equal(readLowerExerciseDraft(window), null, "failed 10 was written back over the other card's later 30");
    assert.equal(savedWeight(), "30");

    gate.hold([]);
    window.__failExerciseSaves = true;
    const shown = await refreshLowerWeights(window);
    assert.deepEqual(shown, { today: "30", week: "30" });
    assert.equal(savedWeight(), "30");
    assert.equal(readLowerExerciseDraft(window), null);

    const postsBeforeHide = exerciseWeights(calls).length;
    window.__failExerciseSaves = false;
    await hideDashboard(window);
    assert.equal(exerciseWeights(calls).length, postsBeforeHide);
    assert.equal(savedWeight(), "30");
    assert.equal(lowerWeightInput(window.document, "#today-list").value, "30");
    assert.equal(lowerWeightInput(window.document, "#week-grid").value, "30");
    assertNoDraftOwnerLeak(calls, window.document);
  } finally {
    gate.settleAll();
    dom.window.close();
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

test("a late change does not restore an older failed weight after another card saved", async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "UTC";
  const state = pageFixture();
  const { dom, window, calls } = openDateRefreshPage(state);
  const gate = holdExerciseLogPosts(window, state, calls);
  const savedWeight = () => state.active_plan.activities.find((item) => item.activity_id === "lower").exercise_logs?.activity?.weight_lbs;
  try {
    const { today, week } = await saveInitialLowerWeights(window, calls);
    assert.equal(savedWeight(), "30");
    gate.hold(["50"]);
    setWeight(window, today, "50");
    today.dispatchEvent(new window.Event("blur"));
    await waitFor(() => gate.pending.some((entry) => entry.weight === "50"));

    gate.hold(["50", "10"]);
    setWeight(window, week, "10");
    await waitFor(() => gate.pending.some((entry) => entry.weight === "10"));
    gate.release("50", true);
    await waitFor(() => savedWeight() === "50" && readLowerExerciseDraft(window) === null);

    gate.hold(["10"]);
    week.dispatchEvent(new window.Event("change"));
    await waitFor(() => gate.pending.filter((entry) => entry.weight === "10").length === 2);
    const weekStatus = () => week.closest("form").querySelector(".autosave-status");
    gate.release("10", false);
    await waitFor(() => gate.pending.filter((entry) => entry.weight === "10").length === 1 && weekStatus().textContent === "Not saved");
    assert.equal(readLowerExerciseDraft(window), null);
    assert.equal(savedWeight(), "50");

    gate.release("10", false);
    await waitFor(() => gate.pending.length === 0 && weekStatus().textContent === "Not saved");
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(readLowerExerciseDraft(window), null);
    assert.equal(week.value, "10");
    assert.equal(savedWeight(), "50");
    assert.equal(exerciseWeights(calls).filter((weight) => weight === "10").length >= 2, true);

    gate.hold([]);
    const shown = await refreshLowerWeights(window);
    assert.deepEqual(shown, { today: "50", week: "50" });
    assert.equal(readLowerExerciseDraft(window), null);
    assert.equal(savedWeight(), "50");
    assertNoDraftOwnerLeak(calls, window.document);
  } finally {
    gate.settleAll();
    dom.window.close();
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});
