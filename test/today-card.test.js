const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");

function runInPage(context, code, filename) {
  new vm.Script(code, { filename }).runInContext(context);
}

function installClock(context) {
  runInPage(context, `
    const RealDate = Date;
    const nowMs = ${Date.parse("2026-11-16T15:00:00Z")};
    class ClockDate extends RealDate {
      constructor(...args) {
        super(...(args.length ? args : [nowMs]));
      }
      static now() { return nowMs; }
    }
    globalThis.Date = ClockDate;
  `, "clock.js");
}

function pageState() {
  return {
    goals: { primary: "Squat" },
    coach_notes: "",
    streak: { days_without_miss: 1, weeks_without_miss: 1 },
    gear: [],
    planning_periods: [],
    coach_memories: [],
    exercise_glossary: [{
      glossary_id: "back-squat",
      canonical_name: "Back squat",
      aliases: ["Barbell back squat"],
      description: "Brace, sit between the hips, and stand back up.",
      instructions: ["Set the bar", "Brace", "Stand up"],
      cues: ["Ribs down"],
      cautions: ["Don't chase depth through the back"],
      source_title: "Coach Loop",
      source_url: "https://example.com/squat"
    }],
    health: { actual_workouts: [] },
    active_plan: {
      activities: [
        {
          activity_id: "prev",
          date: "2026-11-09",
          title: "Lower body strength",
          type: "strength",
          required_or_optional: "required",
          equipment: ["gear-olympic-barbell"],
          completion: { completed: true, subtasks: {} },
          feedback: { difficulty: 4, back_pain: 0 },
          subtasks: [
            { subtask_id: "prev-squat", title: "Barbell back squat — 3 sets of 8 reps at a moderate load (RPE 6)" }
          ],
          exercise_logs: {
            "prev-squat": { exercise_id: "prev-squat", title: "Back squat", weight_lbs: 135, sets: 3, reps: 8, updated_at: "2026-11-09T18:00:00Z" }
          }
        },
        {
          activity_id: "today",
          date: "2026-11-16",
          title: "Lower body strength",
          type: "strength",
          required_or_optional: "required",
          equipment: ["gear-power-rack-cable-station", "gear-olympic-barbell"],
          completion: { completed: false, subtasks: {} },
          exercise_logs: {
            wall: { exercise_id: "wall", title: "Wall sit", duration_seconds: 30, updated_at: "2026-11-16T12:00:00Z" }
          },
          blocks: [{
            block_id: "squat-bird",
            mode: "alternating_sets",
            rounds: 3,
            primary_subtask_id: "squat",
            active_rest_subtask_id: "birddog",
            active_rest_between_rounds_only: true,
            additional_rest_seconds: 90
          }],
          preference_applications: [{ key: "active-rest", version: 1 }],
          subtasks: [
            { subtask_id: "wu-walk", title: "Warm-up: backward walking — 60 seconds" },
            { subtask_id: "wu-circles", title: "Warm-up: shoulder circles — 30 seconds" },
            { subtask_id: "wu-squat", title: "WARM-UP: BODYWEIGHT SQUAT — 1 SET OF 8 EASY REPS" },
            { subtask_id: "squat", title: "Barbell back squat — 3 sets of 8 reps at a moderate load (RPE 6)" },
            { subtask_id: "birddog", title: "Bird-dog — 2 between-set bouts", progression: "down" },
            { subtask_id: "cd-ham", title: "Cool-down: supine hamstring stretch — 30 seconds per side" },
            { subtask_id: "plank", title: "Plank hold", log_mode: "timed" },
            { subtask_id: "wall", title: "Wall sit — 3x30 sec" },
            { subtask_id: "sled", title: "Farmer carry — 40 seconds" }
          ]
        }
      ]
    }
  };
}

async function waitFor(predicate) {
  let lastError = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if (predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(lastError ? lastError.message : "timed out waiting for the dashboard");
}

function row(document, title) {
  return [...document.querySelectorAll("#today-list .subtask-row")].find((item) => item.textContent.includes(title));
}

test("today card uses check rows, a collapsed round line, suggestions, and an in-place movement sheet", async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "UTC";
  const calls = [];
  const state = pageState();
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const dom = new JSDOM(html, { url: "http://127.0.0.1:4173/", pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  installClock(dom.getInternalVMContext());
  window.fetch = async (input, options = {}) => {
    const url = String(input?.url || input);
    const method = String(options.method || "GET").toUpperCase();
    const body = options.body ? String(options.body) : "";
    calls.push({ url, method, body });
    const respond = (status, payload) => ({ status, ok: status >= 200 && status < 300, json: async () => payload });
    if (url.includes("/api/session")) return respond(200, { authenticated: true });
    if (url.includes("/api/state")) return respond(200, state);
    if (url.includes("/api/coach-summary")) return respond(200, { summary_text: "Synthetic summary" });
    if (method === "POST" && url.includes("/exercise-log")) {
      const payload = JSON.parse(body);
      const activity = state.active_plan.activities.find((item) => item.activity_id === "today");
      activity.exercise_logs = { ...(activity.exercise_logs || {}), [payload.exercise_id]: payload };
      return respond(200, state);
    }
    return respond(500, { error: "synthetic test does not save this write" });
  };
  for (const file of ["activity-summary.js", "today-list.js", "exercise-guidance.js", "app.js"]) {
    runInPage(dom.getInternalVMContext(), fs.readFileSync(path.join(root, file), "utf8"), file);
  }

  try {
    const { document } = window;
    await waitFor(() => document.querySelector("#today-list h3")?.textContent === "Lower body strength");

    assert.equal(document.querySelector("#today-list .equipment-tags"), null);
    assert.ok(document.querySelector("#week-grid .equipment-tags span"));
    const rounds = document.querySelector("#today-list .round-structure");
    assert.equal(rounds.open, false);
    assert.match(rounds.querySelector("summary").textContent, /3 rounds/);
    assert.equal(rounds.querySelector("summary").textContent.includes("next work set"), false);
    assert.equal(document.querySelector("#today-list .coaching-details"), null);

    for (const title of [
      "Warm-up: backward walking",
      "Warm-up: shoulder circles",
      "BODYWEIGHT SQUAT",
      "Cool-down: supine hamstring stretch"
    ]) {
      const item = row(document, title);
      assert.equal(item.tagName, "LABEL", title);
      assert.equal(item.querySelector("input[name='weight_lbs'], input[name='duration_value']"), null, title);
      assert.equal(item.querySelector(".exercise-total"), null, title);
    }

    const squat = row(document, "Barbell back squat");
    assert.equal(squat.classList.contains("exercise-entry-row"), true);
    assert.equal(squat.querySelector("input[name='weight_lbs']").value, "135");
    assert.equal(squat.querySelector("input[name='sets']").value, "3");
    assert.equal(squat.querySelector("input[name='reps']").value, "8");
    assert.equal(squat.querySelector("input[name='weight_lbs']").classList.contains("is-prefill"), true);
    assert.equal(squat.querySelector("input[type='checkbox']").checked, false);
    assert.equal(squat.querySelector(".progression-cue").dataset.direction, "up");
    assert.match(squat.querySelector(".progression-cue").getAttribute("aria-label"), /top of the rep range/i);

    const bird = row(document, "Bird-dog");
    assert.equal(bird.querySelector("input[name='weight_lbs']").value, "");
    assert.equal(bird.querySelector("input[name='weight_lbs']").classList.contains("is-prefill"), false);
    assert.equal(bird.querySelector(".progression-cue").dataset.direction, "down");

    const wall = row(document, "Wall sit");
    assert.ok(wall.querySelector("input[name='duration_value']"));
    assert.equal(wall.querySelector("input[name='weight_lbs']"), null);
    assert.equal(wall.querySelector("input[name='duration_value']").value, "30");
    assert.equal(wall.querySelector("select[name='duration_unit']").value, "sec");
    assert.equal(wall.querySelector("input[name='sets']").placeholder, "3");
    assert.equal(wall.querySelector("select[name='title']").value, "Wall sit");
    assert.ok(row(document, "Plank hold").querySelector("input[name='duration_value']"));
    assert.ok(row(document, "Farmer carry").querySelector("input[name='weight_lbs']"));
    assert.equal(row(document, "Farmer carry").querySelector("input[name='duration_value']") !== null, true);

    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(calls.some((call) => call.url.includes("/exercise-log")), false);

    const opener = squat.querySelector(".lib-link");
    opener.click();
    const sheet = document.querySelector("#movement-sheet");
    assert.equal(sheet.open || sheet.hasAttribute("open"), true);
    assert.equal(document.querySelector("#today-view").classList.contains("is-active"), true);
    assert.equal(document.querySelector("#library-view").classList.contains("is-active"), false);
    assert.match(sheet.textContent, /Brace, sit between the hips/);
    document.querySelector("#movement-sheet-close").click();
    assert.equal(sheet.open || sheet.hasAttribute("open"), false);
    assert.equal(document.querySelector("#today-view").classList.contains("is-active"), true);

    const weight = squat.querySelector("input[name='weight_lbs']");
    weight.value = "145";
    weight.dispatchEvent(new window.InputEvent("input", { bubbles: true, data: "145", inputType: "insertText" }));
    weight.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => calls.some((call) => call.method === "POST" && call.url.includes("/exercise-log")));
    const saved = JSON.parse(calls.find((call) => call.url.includes("/exercise-log")).body);
    assert.equal(saved.weight_lbs, "145");
    assert.equal(saved.sets, "3");
    assert.equal(saved.reps, "8");
    assert.equal(weight.classList.contains("is-prefill"), false);
    assert.match(squat.querySelector(".exercise-last").textContent, /135/);
  } finally {
    dom.window.close();
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

test("changing the movement discards an unaccepted suggestion instead of saving it", async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "UTC";
  const calls = [];
  const state = {
    goals: { primary: "Arms" },
    coach_notes: "",
    streak: { days_without_miss: 0, weeks_without_miss: 0 },
    gear: [],
    planning_periods: [],
    coach_memories: [],
    exercise_glossary: [],
    health: { actual_workouts: [] },
    active_plan: {
      activities: [
        {
          activity_id: "prev-curl",
          date: "2026-11-09",
          title: "Arms",
          type: "strength",
          required_or_optional: "required",
          completion: { completed: true, subtasks: {} },
          feedback: { difficulty: 5, back_pain: 0 },
          subtasks: [{ subtask_id: "curl", title: "Curl — 3x10" }],
          exercise_logs: {
            curl: { exercise_id: "curl", title: "Curl", weight_lbs: 30, sets: 3, reps: 10, updated_at: "2026-11-09T18:00:00Z" }
          }
        },
        {
          activity_id: "today-curl",
          date: "2026-11-16",
          title: "Arms",
          type: "strength",
          required_or_optional: "required",
          completion: { completed: false, subtasks: {} },
          subtasks: [{ subtask_id: "curl", title: "Curl — 3x10" }]
        }
      ]
    }
  };
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const dom = new JSDOM(html, { url: "http://127.0.0.1:4173/", pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  installClock(dom.getInternalVMContext());
  window.fetch = async (input, options = {}) => {
    const url = String(input?.url || input);
    const method = String(options.method || "GET").toUpperCase();
    const body = options.body ? String(options.body) : "";
    calls.push({ url, method, body });
    const respond = (status, payload) => ({ status, ok: status >= 200 && status < 300, json: async () => payload });
    if (url.includes("/api/session")) return respond(200, { authenticated: true });
    if (url.includes("/api/state")) return respond(200, state);
    if (url.includes("/api/coach-summary")) return respond(200, { summary_text: "Synthetic summary" });
    if (method === "POST" && url.includes("/exercise-log")) return respond(200, state);
    return respond(500, { error: "synthetic test does not save this write" });
  };
  for (const file of ["activity-summary.js", "today-list.js", "exercise-guidance.js", "app.js"]) {
    runInPage(dom.getInternalVMContext(), fs.readFileSync(path.join(root, file), "utf8"), file);
  }

  try {
    const { document } = window;
    await waitFor(() => document.querySelector("#today-list input[name='weight_lbs']")?.value === "30");
    const select = document.querySelector("#today-list select[name='title']");
    assert.equal(select.value, "Curl");
    assert.ok([...select.options].some((option) => option.value === "Hammer curl"));
    select.value = "Hammer curl";
    select.dispatchEvent(new window.Event("input", { bubbles: true }));
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => calls.some((call) => call.method === "POST" && call.url.includes("/exercise-log")));
    const posts = calls
      .filter((call) => call.method === "POST" && call.url.includes("/exercise-log"))
      .map((call) => JSON.parse(call.body));
    assert.ok(posts.every((post) => String(post.weight_lbs || "") !== "30"));
    assert.ok(posts.every((post) => String(post.reps || "") !== "10"));
    assert.equal(document.querySelector("#today-list input[type='checkbox']").checked, false);
  } finally {
    dom.window.close();
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

test("a saved dumbbell curl stays selected on a barbell curl prescription", async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "UTC";
  const calls = [];
  const state = {
    goals: { primary: "Arms" },
    coach_notes: "",
    streak: { days_without_miss: 0, weeks_without_miss: 0 },
    gear: [],
    planning_periods: [],
    coach_memories: [],
    exercise_glossary: [],
    health: { actual_workouts: [] },
    active_plan: {
      activities: [{
        activity_id: "arms",
        date: "2026-11-16",
        title: "Arms",
        type: "strength",
        required_or_optional: "required",
        completion: { completed: false, subtasks: {} },
        subtasks: [{ subtask_id: "curl", title: "Barbell curl — 3x10" }],
        exercise_logs: {
          curl: { exercise_id: "curl", title: "Dumbbell curl", weight_lbs: 40, sets: 3, reps: 10, updated_at: "2026-11-16T12:00:00Z" }
        }
      }]
    }
  };
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const dom = new JSDOM(html, { url: "http://127.0.0.1:4173/", pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  installClock(dom.getInternalVMContext());
  window.fetch = async (input, options = {}) => {
    const url = String(input?.url || input);
    const method = String(options.method || "GET").toUpperCase();
    const body = options.body ? String(options.body) : "";
    calls.push({ url, method, body });
    const respond = (status, payload) => ({ status, ok: status >= 200 && status < 300, json: async () => payload });
    if (url.includes("/api/session")) return respond(200, { authenticated: true });
    if (url.includes("/api/state")) return respond(200, state);
    if (url.includes("/api/coach-summary")) return respond(200, { summary_text: "Synthetic summary" });
    if (method === "POST" && url.includes("/exercise-log")) return respond(200, state);
    return respond(500, { error: "synthetic test does not save this write" });
  };
  for (const file of ["activity-summary.js", "today-list.js", "exercise-guidance.js", "app.js"]) {
    runInPage(dom.getInternalVMContext(), fs.readFileSync(path.join(root, file), "utf8"), file);
  }

  try {
    const { document } = window;
    await waitFor(() => document.querySelector("#today-list select[name='title']")?.value === "Dumbbell curl");
    const row = document.querySelector("#today-list .exercise-entry-row");
    assert.equal(row.querySelector("input[name='weight_lbs']").value, "40");
    assert.equal(row.querySelector("input[name='sets']").value, "3");
    assert.equal(row.querySelector("input[name='reps']").value, "10");
    assert.equal(row.querySelector("input[name='sets']").placeholder, "3");
    assert.equal(row.querySelector("input[name='reps']").placeholder, "10");
    row.querySelector("input[name='weight_lbs']").dispatchEvent(new window.Event("blur", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const posts = calls.filter((call) => call.method === "POST" && call.url.includes("/exercise-log"));
    assert.ok(posts.every((call) => JSON.parse(call.body).title !== "Barbell curl"));
    assert.equal(document.querySelector("#today-list select[name='title']").value, "Dumbbell curl");
  } finally {
    dom.window.close();
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

test("saving a set keeps the Today card scroll position and the field being edited", async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "UTC";
  const state = pageState();
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const dom = new JSDOM(html, { url: "http://127.0.0.1:4173/", pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  installClock(dom.getInternalVMContext());
  window.fetch = async (input, options = {}) => {
    const url = String(input?.url || input);
    const method = String(options.method || "GET").toUpperCase();
    const body = options.body ? String(options.body) : "";
    const respond = (status, payload) => ({ status, ok: status >= 200 && status < 300, json: async () => payload });
    if (url.includes("/api/session")) return respond(200, { authenticated: true });
    if (url.includes("/api/state")) return respond(200, state);
    if (url.includes("/api/coach-summary")) return respond(200, { summary_text: "Synthetic summary" });
    if (method === "POST" && url.includes("/exercise-log")) {
      const payload = JSON.parse(body);
      const activity = state.active_plan.activities.find((item) => item.activity_id === "today");
      activity.exercise_logs = { ...(activity.exercise_logs || {}), [payload.exercise_id]: payload };
      return respond(200, state);
    }
    if (method === "PATCH" && url.includes("/api/activities/")) {
      const payload = JSON.parse(body);
      const activity = state.active_plan.activities.find((item) => item.activity_id === "today");
      activity.completion = {
        ...(activity.completion || { completed: false }),
        subtasks: { ...(activity.completion?.subtasks || {}) }
      };
      if (payload.subtask_id) activity.completion.subtasks[payload.subtask_id] = Boolean(payload.completed);
      return respond(200, state);
    }
    return respond(500, { error: "synthetic test does not save this write" });
  };
  for (const file of ["activity-summary.js", "today-list.js", "exercise-guidance.js", "app.js"]) {
    runInPage(dom.getInternalVMContext(), fs.readFileSync(path.join(root, file), "utf8"), file);
  }

  try {
    const { document } = window;
    await waitFor(() => document.querySelector("#today-list input[name='weight_lbs']"));
    const squat = [...document.querySelectorAll("#today-list .subtask-row")].find((item) => item.textContent.includes("Barbell back squat"));
    const weight = squat.querySelector("input[name='weight_lbs']");
    weight.value = "145";
    weight.dispatchEvent(new window.InputEvent("input", { bubbles: true, data: "145", inputType: "insertText" }));
    weight.focus();
    weight.setSelectionRange(1, 3);

    let scrollY = 720;
    Object.defineProperty(window, "scrollX", { configurable: true, get: () => 0 });
    Object.defineProperty(window, "scrollY", { configurable: true, get: () => scrollY });
    window.scrollTo = (x, y) => {
      scrollY = x && typeof x === "object" ? Number(x.top || 0) : Number(y || 0);
    };
    const list = document.querySelector("#today-list");
    const inner = Object.getOwnPropertyDescriptor(window.Element.prototype, "innerHTML");
    Object.defineProperty(list, "innerHTML", {
      configurable: true,
      get() { return inner.get.call(this); },
      set(value) {
        inner.set.call(this, value);
        // Mobile Safari jumps to the top when the focused card is replaced.
        if (String(value) === "") scrollY = 0;
      }
    });

    const checkbox = squat.querySelector("input[type='checkbox']");
    checkbox.checked = true;
    checkbox.dispatchEvent(new window.Event("change", { bubbles: true }));

    await waitFor(() => !weight.isConnected);
    const active = document.activeElement;
    assert.equal(scrollY, 720);
    assert.equal(active.isConnected, true);
    assert.notEqual(active, weight);
    assert.equal(active.getAttribute("name"), "weight_lbs");
    assert.equal(active.closest("[data-activity-id]")?.dataset.activityId, "today");
    assert.equal(active.closest("[data-exercise-id]")?.dataset.exerciseId, "squat");
    assert.equal(active.value, "145");
    assert.equal(active.selectionStart, 1);
    assert.equal(active.selectionEnd, 3);
  } finally {
    dom.window.close();
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});

async function rerenderTodayCard(beforeFrame) {
  const previousTZ = process.env.TZ;
  process.env.TZ = "UTC";
  const state = pageState();
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const dom = new JSDOM(html, { url: "http://127.0.0.1:4173/", pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  installClock(dom.getInternalVMContext());
  window.fetch = async (input, options = {}) => {
    const url = String(input?.url || input);
    const method = String(options.method || "GET").toUpperCase();
    const body = options.body ? String(options.body) : "";
    const respond = (status, payload) => ({ status, ok: status >= 200 && status < 300, json: async () => payload });
    if (url.includes("/api/session")) return respond(200, { authenticated: true });
    if (url.includes("/api/state")) return respond(200, state);
    if (url.includes("/api/coach-summary")) return respond(200, { summary_text: "Synthetic summary" });
    if (method === "POST" && url.includes("/exercise-log")) return respond(200, state);
    if (method === "PATCH" && url.includes("/api/activities/")) {
      const payload = JSON.parse(body);
      const activity = state.active_plan.activities.find((item) => item.activity_id === "today");
      activity.completion = {
        ...(activity.completion || { completed: false }),
        subtasks: { ...(activity.completion?.subtasks || {}) }
      };
      if (payload.subtask_id) activity.completion.subtasks[payload.subtask_id] = Boolean(payload.completed);
      return respond(200, state);
    }
    return respond(500, { error: "synthetic test does not save this write" });
  };
  for (const file of ["activity-summary.js", "today-list.js", "exercise-guidance.js", "app.js"]) {
    runInPage(dom.getInternalVMContext(), fs.readFileSync(path.join(root, file), "utf8"), file);
  }

  const scroll = { y: 720 };
  try {
    const { document } = window;
    await waitFor(() => document.querySelector("#today-list input[name='weight_lbs']"));
    const nativeFrame = window.requestAnimationFrame.bind(window);
    let frameDone = false;
    let hooked = false;
    window.requestAnimationFrame = (callback) => nativeFrame((time) => {
      if (!hooked) {
        hooked = true;
        scroll.y = 0;
        beforeFrame(window, document, scroll);
      }
      callback(time);
      frameDone = true;
    });
    Object.defineProperty(window, "scrollX", { configurable: true, get: () => 0 });
    Object.defineProperty(window, "scrollY", { configurable: true, get: () => scroll.y });
    window.scrollTo = (x, y) => {
      scroll.y = x && typeof x === "object" ? Number(x.top || 0) : Number(y || 0);
    };
    const list = document.querySelector("#today-list");
    const inner = Object.getOwnPropertyDescriptor(window.Element.prototype, "innerHTML");
    Object.defineProperty(list, "innerHTML", {
      configurable: true,
      get() { return inner.get.call(this); },
      set(value) {
        inner.set.call(this, value);
        if (String(value) === "") scroll.y = 0;
      }
    });

    const squat = [...document.querySelectorAll("#today-list .subtask-row")].find((item) => item.textContent.includes("Barbell back squat"));
    const weight = squat.querySelector("input[name='weight_lbs']");
    weight.focus();
    const checkbox = squat.querySelector("input[type='checkbox']");
    checkbox.checked = true;
    checkbox.dispatchEvent(new window.Event("change", { bubbles: true }));
    await waitFor(() => !weight.isConnected && frameDone);
    return {
      scrollY: scroll.y,
      activeId: document.activeElement?.id || "",
      activeName: document.activeElement?.getAttribute?.("name") || "",
      activeIsBody: document.activeElement === document.body
    };
  } finally {
    dom.window.close();
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
}

test("a late jump back to the top is restored on the next animation frame", async () => {
  const restored = await rerenderTodayCard(() => {});
  assert.equal(restored.scrollY, 720);
  assert.equal(restored.activeName, "weight_lbs");
});

test("user input before the next animation frame keeps that scroll and focus", async () => {
  for (const type of ["wheel", "touchstart", "keydown"]) {
    const kept = await rerenderTodayCard((pageWindow, pageDocument, pageScroll) => {
      pageDocument.body.focus();
      pageWindow.dispatchEvent(new pageWindow.Event(type, { bubbles: true, cancelable: true }));
      pageScroll.y = 200;
      pageDocument.querySelector("#refresh-button").focus();
    });
    assert.equal(kept.scrollY, 200, type);
    assert.equal(kept.activeId, "refresh-button", type);

    const leftAlone = await rerenderTodayCard((pageWindow, pageDocument) => {
      const focused = pageDocument.activeElement;
      if (focused && typeof focused.blur === "function") focused.blur();
      pageDocument.body.focus();
      pageWindow.dispatchEvent(new pageWindow.Event(type, { bubbles: true, cancelable: true }));
    });
    assert.equal(leftAlone.scrollY, 0, type);
    assert.equal(leftAlone.activeName, "", type);
    assert.equal(leftAlone.activeIsBody, true, type);
  }
});

test("the weeks stat shows the escaped breaking miss and hides it when the streak is clean", async () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "UTC";
  const state = pageState();
  state.streak = {
    days_without_miss: 10,
    weeks_without_miss: 2,
    breaking_miss: { date: "2026-11-08", title: "Light arms <img src=x onerror=alert(1)>" }
  };
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  const dom = new JSDOM(html, { url: "http://127.0.0.1:4173/", pretendToBeVisual: true, runScripts: "outside-only" });
  const { window } = dom;
  installClock(dom.getInternalVMContext());
  window.fetch = async (input) => {
    const url = String(input?.url || input);
    const respond = (status, payload) => ({ status, ok: status >= 200 && status < 300, json: async () => payload });
    if (url.includes("/api/session")) return respond(200, { authenticated: true });
    if (url.includes("/api/state")) return respond(200, state);
    if (url.includes("/api/coach-summary")) return respond(200, { summary_text: "Synthetic summary" });
    return respond(500, { error: "synthetic test does not save this write" });
  };
  for (const file of ["activity-summary.js", "today-list.js", "exercise-guidance.js", "app.js"]) {
    runInPage(dom.getInternalVMContext(), fs.readFileSync(path.join(root, file), "utf8"), file);
  }

  try {
    const { document } = window;
    await waitFor(() => document.querySelector("#metric-week")?.textContent === "2");
    const label = document.querySelector("#metric-week-break");
    const expectedDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })
      .format(new Date("2026-11-08T12:00:00"));
    assert.equal(label.hidden, false);
    assert.equal(label.textContent, `last miss: ${expectedDate} · Light arms <img src=x onerror=alert(1)>`);
    assert.equal(label.querySelector("img"), null);
    assert.equal(label.children.length, 0);

    state.streak = { days_without_miss: 10, weeks_without_miss: 4, breaking_miss: null };
    document.querySelector("#refresh-button").click();
    await waitFor(() => document.querySelector("#metric-week")?.textContent === "4");
    assert.equal(document.querySelector("#metric-week-break").hidden, true);
    assert.equal(document.querySelector("#metric-week-break").textContent, "");
  } finally {
    dom.window.close();
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});
