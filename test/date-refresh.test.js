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
