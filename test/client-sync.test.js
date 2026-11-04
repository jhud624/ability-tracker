const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { createClientSync } = require("../client-sync");

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const turn = () => new Promise(setImmediate);
const snapshot = (revision, extra = {}) => ({ revision, active_plan: null, completions: {}, ...extra });
const response = (payload, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => payload });
const warning = "Primary data saved; automatic backup failed.";

async function seeded(send) {
  let initial = true;
  const sync = createClientSync({ send: (path, options) => {
    if (initial && path === "/api/state") { initial = false; return snapshot(1); }
    return send(path, options);
  } });
  await sync.request("/api/state");
  return sync;
}

// Run the actual browser transport, coordinator wiring and action functions.
// Only DOM leaf rendering, timers and HTTP are replaced; no live app is used.
function browser(fetch) {
  const source = fs.readFileSync(require.resolve("../app.js"), "utf8");
  function part(start, end) {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    assert.ok(a >= 0 && b > a, `${start} boundary exists`);
    return source.slice(a, b);
  }
  const timers = new Map(); let timerId = 0;
  const rendered = [], connected = [], listeners = {};
  const classes = new Set();
  const state = { data: null, writeAccess: true, notice: "", noticeError: false };
  const elements = { message: { textContent: "", classList: { toggle(name, value) { value ? classes.add(name) : classes.delete(name); } } }, coachSummary: { value: "" } };
  const context = vm.createContext({
    state, elements, fetch,
    window: { clearTimeout: id => timers.delete(id), setTimeout: cb => { timers.set(++timerId, cb); return timerId; } },
    activeAutosaveFlushers: new Set(),
    document: { createElement: () => ({ textContent: "", className: "" }) },
    FormData: class { constructor(form) { this.form = form; } entries() { return Object.entries(this.form.values); } },
    activities: () => [], renderCoachingDetails() {},
    setBackendStatus: value => connected.push(value), updateWriteAccessUi() {}, requestWriteAccess: async () => true,
    updateOverview: () => rendered.push(structuredClone(state.data)),
    ...Object.fromEntries(["renderToday", "renderWeek", "renderLibrary", "renderGoals", "renderCoachMemories", "renderPlanningPeriods", "renderGear", "renderActuals", "renderRunTracking"].map(name => [name, () => {}]))
  });
  const code = [
    part("async function api(", "\nasync function sendApi"),
    part("async function sendApi(", "\nfunction renderMessage"),
    part("function renderMessage(", "\nfunction setBackendStatus"),
    part("function feedbackSignature(", "\nfunction createExerciseNumberField"),
    part("function attachFeedbackAutosave(", "\nasync function flushActiveAutosaves"),
    part("async function flushActiveAutosaves(", "\nfunction openLibraryForExercise"),
    part("function render()", "\nasync function loadState"),
    part("async function loadState(", "\nasync function linkActivityActual"),
    part("async function refreshCoachSummary(", "\nelements.tabButtons"),
    part("const clientSync =", "\nlet unlockResolver")
  ].join("\n");
  vm.runInContext(fs.readFileSync(require.resolve("../client-sync.js"), "utf8"), context);
  vm.runInContext(code, context);
  return {
    state, elements, rendered, connected, classes, context, listeners,
    sync: vm.runInContext("clientSync", context),
    run: code => vm.runInContext(code, context),
    expireToasts() { for (const cb of [...timers.values()]) cb(); timers.clear(); },
    installBulkHandler() {
      elements.completeWorkout = { addEventListener: (_, cb) => { listeners.bulk = cb; } };
      context.todaysList = () => state.data?.active_plan?.activities || [];
      context.todayKey = () => "2026-11-04";
      vm.runInContext(part('elements.completeWorkout.addEventListener("click",', "\nelements.writeAccessButton"), context);
    },
    installExerciseAutosave() {
      vm.runInContext(part("function exerciseLogSignature(", "\nfunction createExerciseNumberField") + part("function exerciseLogHasData(", "\nfunction attachFeedbackAutosave"), context);
    },
    installActivityHandlers() {
      Object.assign(context, { activity: { activity_id: "synthetic" }, completed: false, options: {},
        checkButton: { dataset: {}, addEventListener: (_, cb) => { listeners.overall = cb; } },
        subtaskList: { addEventListener: (_, cb) => { listeners.subtask = cb; } }
      });
      vm.runInContext(part('  checkButton.addEventListener("click",', "\n\n  return node;"), context);
    }
  };
}

test("client mutations are serialized and a failed acknowledgement is never replayed", async () => {
  const gate = deferred(), calls = [];
  const sync = await seeded((path) => { calls.push(path); return path === "/a" ? gate.promise : snapshot(2); });
  const a = sync.request("/a", { method: "PATCH" });
  const b = sync.request("/b", { method: "PATCH" });
  await turn(); assert.deepEqual(calls, ["/a"]);
  gate.reject(new Error("lost acknowledgement"));
  await assert.rejects(a, /lost acknowledgement/); await b;
  assert.deepEqual(calls, ["/a", "/b"]);
  assert.equal(sync.state.data.revision, 2);
});

test("concurrent identical autosave flushes share one request without losing A-B-A intent", async () => {
  const gate = deferred(), sent = [];
  const sync = await seeded((path, options) => { sent.push(options.body); return sent.length === 1 ? gate.promise : snapshot(sent.length + 1); });
  const options = body => ({ method: "POST", body, coalesce: true, autosaveKey: "synthetic-control" });
  const a = sync.request("/autosave", options("A"));
  const duplicate = sync.request("/autosave", options("A"));
  assert.equal(a, duplicate);
  const b = sync.request("/autosave", options("B"));
  const backToA = sync.request("/autosave", options("A"));
  gate.resolve(snapshot(2)); await Promise.all([a, duplicate, b, backToA]);
  assert.deepEqual(sent, ["A", "B", "A"]);
});

test("unconfirmed autosaves cannot be replayed by another automatic flush", async () => {
  let calls = 0;
  const sync = await seeded(() => { calls++; throw new Error("acknowledgement lost"); });
  const options = { method: "POST", body: "same", coalesce: true, autosaveKey: "synthetic-control" };
  await assert.rejects(sync.request("/autosave", options));
  await assert.rejects(sync.request("/autosave", options));
  assert.equal(calls, 1);
  await assert.rejects(sync.request("/autosave", { ...options, coalesce: false }));
  await assert.rejects(sync.request("/autosave", options));
  assert.equal(calls, 2, "only the explicit second action issued another request");
});

test("a state read started before a queued write cannot overwrite the committed state", async () => {
  const read = deferred();
  const sync = await seeded(path => path === "/api/state" ? read.promise : snapshot(2, { completions: { synthetic: { subtasks: { a: true } } } }));
  const old = sync.request("/api/state"); await turn();
  await sync.request("/write", { method: "PATCH" });
  read.resolve(snapshot(1)); assert.equal(await old, null);
  assert.equal(sync.state.data.revision, 2);
  assert.equal(sync.state.data.completions.synthetic.subtasks.a, true);
});

test("reads wait for queued writes, including a write enqueued while waiting", async () => {
  const gate = deferred(), calls = [];
  const sync = await seeded(path => { calls.push(path); return path === "/a" ? gate.promise : snapshot(3); });
  const a = sync.request("/a", { method: "PATCH" });
  const read = sync.request("/api/state");
  const b = sync.request("/b", { method: "PATCH" });
  await turn(); assert.deepEqual(calls, ["/a"]);
  gate.resolve(snapshot(2)); await Promise.all([a, b, read]);
  assert.deepEqual(calls, ["/a", "/b", "/api/state"]);
});

test("out-of-order state reads and their late failures cannot replace the latest outcome", async () => {
  const old = deferred(), current = deferred(); let count = 0;
  const sync = await seeded(() => ++count === 1 ? old.promise : current.promise);
  const a = sync.request("/api/state"), b = sync.request("/api/state");
  await turn(); current.resolve(snapshot(3)); await b;
  old.reject(new Error("old failure")); assert.equal(await a, null);
  assert.equal(sync.state.data.revision, 3); assert.deepEqual(sync.state.refreshErrors, {});
});

test("summary responses cannot survive an intervening write or replace a later summary", async () => {
  const old = deferred(); let summaryCalls = 0;
  const sync = await seeded(path => path === "/write" ? snapshot(2) : ++summaryCalls === 1 ? old.promise : { revision: 2, summary_text: "current" });
  const a = sync.request("/api/coach-summary"); await turn();
  await sync.request("/write", { method: "PATCH" });
  await sync.request("/api/coach-summary"); old.resolve({ revision: 1, summary_text: "old" });
  assert.equal(await a, null); assert.equal(sync.state.summary.summary_text, "current");
});

test("a summary from a different revision is not presented as current", async () => {
  const sync = await seeded(() => ({ revision: 0, summary_text: "stale" }));
  assert.equal(await sync.request("/api/coach-summary"), null);
  assert.equal(sync.state.summary, null); assert.match(sync.state.refreshErrors.summary, /summary changed/);
});

test("a late summary failure cannot replace the newest successful summary", async () => {
  const a = deferred(), b = deferred(); let calls = 0;
  const sync = await seeded(() => ++calls === 1 ? a.promise : b.promise);
  const first = sync.request("/api/coach-summary"), second = sync.request("/api/coach-summary");
  await turn(); b.resolve({ revision: 1, summary_text: "latest" }); await second;
  a.reject(new Error("old summary failure")); await first;
  assert.equal(sync.state.summary.summary_text, "latest");
  assert.equal(sync.state.refreshErrors.summary, undefined);
});

test("backup warnings survive reads, failed writes and unspecified receipts; only a current explicit success clears them", async () => {
  let result = snapshot(2, { storage_warnings: [warning] });
  const sync = await seeded(() => { if (result instanceof Error) throw result; return result; });
  await sync.request("/write", { method: "PATCH" });
  result = snapshot(2); await sync.request("/api/state"); assert.equal(sync.state.backupWarning, warning);
  result = new Error("busy"); await assert.rejects(sync.request("/write", { method: "PATCH" }));
  assert.equal(sync.state.backupWarning, warning);
  result = { revision: 3, coach_memories: [] }; await sync.request("/partial", { method: "POST" });
  assert.equal(sync.state.backupWarning, warning);
  result = snapshot(2); await sync.request("/stale", { method: "PATCH" }); assert.equal(sync.state.backupWarning, warning);
  result = snapshot(3); await sync.request("/api/state", { resync: true });
  result = snapshot(4, { storage_warnings: [] }); await sync.request("/write", { method: "PATCH" });
  assert.equal(sync.state.backupWarning, "");
});

test("a newer restore can lower revision; an authoritative missing generation is surfaced for resync", async () => {
  let result = snapshot(9);
  const sync = await seeded(() => result);
  await sync.request("/api/state");
  result = snapshot(2, { restored_at: "2026-11-04T10:00:00.000Z" }); await sync.request("/api/state");
  assert.equal(sync.state.data.revision, 2);
  result = snapshot(10); await sync.request("/api/state");
  assert.equal(sync.state.data.revision, 10);
  assert.equal(sync.state.recoveryRequired, true);
  assert.match(sync.state.recoveryWarning, /Recovery mismatch/);
  result = snapshot(3, { restored_at: "2026-11-04T10:00:00.000Z" }); await sync.request("/api/state");
  assert.equal(sync.state.data.revision, 3);
});

test("partial memory receipts retain checkbox state and invalidate old summaries", async () => {
  const sync = await seeded(() => ({ revision: 2, restored_at: null, coach_memories: [{ key: "synthetic" }], storage_warnings: [] }));
  const before = sync.state.data.completions;
  await sync.request("/api/coach-memories/upsert", { method: "POST" });
  assert.equal(sync.state.data.completions, before);
  assert.equal(sync.state.data.revision, 1);
  assert.equal(sync.state.data.coach_memories, undefined);
  assert.equal(sync.state.receiptHead.revision, 2);
  assert.equal(sync.state.needsReconcile, true);
});

test("invalid successful responses preserve state and remain unconfirmed without replay", async () => {
  let calls = 0; const sync = await seeded(() => { calls++; return {}; });
  await assert.rejects(sync.request("/write", { method: "PATCH" }), /incomplete/);
  assert.equal(calls, 1); assert.equal(sync.state.data.revision, 1);
  assert.equal(sync.state.saveStatus, "unconfirmed");
});

test("browser: a saved checkbox remains saved when summary and subsequent state refresh fail", async () => {
  let writes = 0;
  const app = browser(async (path, options = {}) => {
    if (options.method === "PATCH") { writes++; return response(snapshot(2, { storage_warnings: [warning] })); }
    throw new TypeError("Load failed");
  });
  await app.run('updateActivity("synthetic", {subtask_id:"a",completed:true})');
  await app.run("loadState()");
  assert.equal(writes, 1); assert.equal(app.state.data.revision, 2);
  assert.match(app.elements.message.textContent, /Saved\./);
  assert.match(app.elements.message.textContent, /Summary refresh failed: Load failed/);
  assert.match(app.elements.message.textContent, /State refresh failed: Load failed/);
  assert.match(app.elements.message.textContent, /backup unverified/);
  assert.doesNotMatch(app.elements.message.textContent, /Save outcome unconfirmed/);
  app.expireToasts(); assert.match(app.elements.message.textContent, /backup unverified/);
});

test("browser: summary failure cannot turn a committed autosave into a failed save", async () => {
  let writes = 0;
  const app = browser(async (path, options = {}) => {
    if (options.method === "POST") { writes++; return response(snapshot(2)); }
    throw new Error("summary unavailable");
  });
  await app.run('saveFeedback("synthetic", {}, {silent:true,rerender:false})'); await turn();
  assert.equal(writes, 1); assert.equal(app.sync.state.saveStatus, "saved");
  assert.match(app.elements.message.textContent, /Summary refresh failed/);
});

test("browser: simultaneous autosave flushes issue one POST despite failed summary reads", async () => {
  const gate = deferred(); let writes = 0;
  const app = browser(async (path, options = {}) => {
    if (options.method === "POST") { writes++; return gate.promise; }
    throw new Error("summary unavailable");
  });
  const a = app.run('saveFeedback("synthetic",{notes:"same"},{silent:true,rerender:false})');
  const b = app.run('saveFeedback("synthetic",{notes:"same"},{silent:true,rerender:false})');
  await turn(); assert.equal(writes, 1); gate.resolve(response(snapshot(2)));
  await Promise.all([a, b]); await turn();
  assert.equal(writes, 1); assert.equal(app.sync.state.saveStatus, "saved");
});

test("browser: repeated checkbox taps are captured before a delayed autosave flush and sent once in order", async () => {
  const flush = deferred(), sent = []; let revision = 0, checked = false;
  const app = browser(async (path, options = {}) => {
    if (options.method === "PATCH") { const body = JSON.parse(options.body); sent.push(body.completed); checked = body.completed; revision++; return response(snapshot(revision, { completions: { synthetic: { subtasks: { a: checked } } } })); }
    return response({ revision, summary_text: "current" });
  });
  app.installActivityHandlers(); app.context.activeAutosaveFlushers.add(() => flush.promise);
  const checkbox = { dataset: { subtaskId: "a" }, checked: true };
  const event = { target: { closest: () => checkbox } };
  const a = app.listeners.subtask(event); checkbox.checked = false; const b = app.listeners.subtask(event);
  await turn(); assert.deepEqual(sent, []); flush.resolve(); await Promise.all([a, b]);
  assert.deepEqual(sent, [true, false]); assert.equal(app.state.data.completions.synthetic.subtasks.a, false);
  assert.ok(app.rendered.every(value => value.revision === 2));
});

test("browser: repeated overall-completion taps toggle pending intent rather than a stale render closure", async () => {
  const sent = []; let revision = 0;
  const app = browser(async (path, options = {}) => {
    if (options.method === "PATCH") { sent.push(JSON.parse(options.body).completed); revision++; return response(snapshot(revision)); }
    return response({ revision, summary_text: "current" });
  });
  app.installActivityHandlers(); await Promise.all([app.listeners.overall(), app.listeners.overall()]);
  assert.deepEqual(sent, [true, false]);
});

test("browser: a lost acknowledgement is verified only by reads, not a mutation retry", async () => {
  let writes = 0;
  const app = browser(async (path, options = {}) => {
    if (options.method === "PATCH") { writes++; throw new TypeError("connection lost after commit"); }
    return response(path === "/api/state" ? snapshot(2) : { revision: 2, summary_text: "current" });
  });
  await app.run('updateActivity("synthetic", {completed:true})');
  assert.equal(writes, 1); assert.equal(app.state.data.revision, 2);
  assert.match(app.elements.message.textContent, /Save outcome unconfirmed/);
});

test("browser: an unauthorized mutation is not automatically replayed after unlocking", async () => {
  let writes = 0;
  const app = browser(async (path, options = {}) => {
    if (options.method === "PATCH") { writes++; return response({ error: "Unauthorized" }, 401); }
    return response(path === "/api/state" ? snapshot(1) : { revision: 1, summary_text: "current" });
  });
  await app.run('updateActivity("synthetic", {completed:true})');
  assert.equal(writes, 1); assert.equal(app.sync.state.saveStatus, "unconfirmed");
});

test("browser: a stale read failure cannot take a newer saved checkbox offline", async () => {
  const old = deferred(); let writes = 0;
  const app = browser(async (path, options = {}) => {
    if (options.method === "PATCH") { writes++; return response(snapshot(2)); }
    if (path === "/api/state") return old.promise;
    return response({ revision: 2, summary_text: "current" });
  });
  const read = app.run("loadState()"); await turn();
  await app.run('updateActivity("synthetic", {completed:true})');
  old.reject(new Error("obsolete read failed")); await read;
  assert.equal(writes, 1); assert.equal(app.state.data.revision, 2);
  assert.equal(app.connected.includes(false), false);
  assert.equal(app.sync.state.refreshErrors.state, undefined);
});

test("browser: a stale 401 cannot lock a newer acknowledged session or open an unlock prompt", async () => {
  const old = deferred(); let unlocks = 0;
  const app = browser(async (path, options = {}) => {
    if (options.method === "PATCH") return response(snapshot(2));
    if (path === "/api/state") return old.promise;
    return response({ revision: 2, summary_text: "current" });
  });
  app.context.requestWriteAccess = async () => { unlocks++; return true; };
  const read = app.run("loadState()"); await turn();
  await app.run('updateActivity("synthetic",{completed:true})');
  old.resolve(response({ error: "Unauthorized" }, 401)); await read;
  assert.equal(app.state.writeAccess, true); assert.equal(unlocks, 0);
  assert.equal(app.state.noticeError, false); assert.equal(app.state.data.revision, 2);
});

test("browser: a busy second tap shows the verified first save without replay or a false second commit", async () => {
  const sent = []; const saved = snapshot(1, { completions: { synthetic: { subtasks: { a: true } } } });
  const app = browser(async (path, options = {}) => {
    if (options.method === "PATCH") {
      sent.push(JSON.parse(options.body).completed);
      return sent.length === 1 ? response({ ...saved, storage_warnings: [warning] })
        : response({ error: "Coach Loop store is busy. Retry in a moment." }, 400);
    }
    return response(path === "/api/state" ? saved : { revision: 1, summary_text: "current" });
  });
  await Promise.all([app.run('updateActivity("synthetic",{subtask_id:"a",completed:true})'), app.run('updateActivity("synthetic",{subtask_id:"a",completed:false})')]);
  assert.deepEqual(sent, [true, false]);
  assert.equal(app.state.data.completions.synthetic.subtasks.a, true);
  assert.match(app.elements.message.textContent, /Save outcome unconfirmed/);
  assert.match(app.elements.message.textContent, /Earlier saved changes: backup unverified/);
});

test("browser: redraw failure is separate from a successful write and clears on recovered refresh", async () => {
  let revision = 1, writes = 0, failRender = true;
  const app = browser(async (path, options = {}) => {
    if (options.method === "POST") { writes++; revision++; return response(snapshot(revision)); }
    return response(path === "/api/state" ? snapshot(revision) : { revision, summary_text: "current" });
  });
  app.context.updateOverview = () => { if (failRender) throw new Error("synthetic redraw failure"); };
  await app.run('saveFeedback("synthetic",{})');
  assert.equal(writes, 1); assert.equal(app.sync.state.saveStatus, "saved");
  assert.match(app.elements.message.textContent, /Display refresh failed/);
  failRender = false; await app.run("loadState()");
  assert.equal(app.sync.state.refreshErrors.display, undefined);
  assert.equal(writes, 1);
});

test("browser: an acknowledged autosave is not repeated by later flushes after summary/detail errors", async () => {
  let writes = 0; const statusHolder = {};
  const app = browser(async (path, options = {}) => {
    if (options.method === "POST") { writes++; return response(snapshot(2)); }
    throw new Error("summary unavailable");
  });
  app.context.form = { values: { notes: "old" }, elements: { notes: { addEventListener() {} } },
    querySelector: () => ({ replaceWith(value) { statusHolder.value = value; } }),
    closest: () => ({}), addEventListener() {} };
  app.context.activities = () => [{ activity_id: "synthetic" }];
  app.context.renderCoachingDetails = () => { throw new Error("detail unavailable"); };
  app.run('attachFeedbackAutosave(form,{activity_id:"synthetic"})');
  app.context.form.values.notes = "new";
  await app.run("flushActiveAutosaves()"); await turn();
  await app.run("flushActiveAutosaves()");
  assert.equal(writes, 1); assert.equal(statusHolder.value.textContent, "Saved");
  assert.equal(app.sync.state.saveStatus, "saved");
  assert.match(app.elements.message.textContent, /Display refresh failed: detail unavailable/);
});

test("browser: automatic flushes never retry an unconfirmed autosave, while an explicit submission is a new intent", async () => {
  let writes = 0; const handlers = {};
  const app = browser(async (path, options = {}) => {
    if (options.method === "POST") {
      writes++; if (writes === 1) throw new Error("acknowledgement lost");
      return response(snapshot(2));
    }
    return response({ revision: 2, summary_text: "current" });
  });
  app.context.form = { values: { notes: "old" }, elements: {}, querySelector: () => null,
    addEventListener(type, listener) { handlers[type] = listener; } };
  app.run('attachFeedbackAutosave(form,{activity_id:"synthetic"})');
  app.context.form.values.notes = "new";
  await app.run("flushActiveAutosaves()");
  await app.run("flushActiveAutosaves()");
  assert.equal(writes, 1);
  await handlers.submit({ preventDefault() {} }); await turn();
  await app.run("flushActiveAutosaves()");
  assert.equal(writes, 2); assert.equal(app.sync.state.saveStatus, "saved");
});


test("unconfirmed exercise A survives exercise B success at the same endpoint, including later automatic flush", async () => {
  const sent = [];
  const sync = await seeded((path, options) => {
    const value = JSON.parse(options.body); sent.push(value);
    if (value.exercise_id === "A") throw new Error("A acknowledgement lost");
    return snapshot(3);
  });
  const options = (id, reps = 1) => ({ method: "POST", autosaveKey: id, coalesce: true, body: JSON.stringify({ exercise_id: id, reps }) });
  await assert.rejects(sync.request("/same-exercise-endpoint", options("A")));
  await sync.request("/same-exercise-endpoint", options("B"));
  await assert.rejects(sync.request("/same-exercise-endpoint", options("A")));
  assert.deepEqual(sent.map(x => x.exercise_id), ["A", "B"]);
  await sync.request("/same-exercise-endpoint", options("B", 2));
  await assert.rejects(sync.request("/same-exercise-endpoint", options("A")));
  assert.equal(sent.length, 3, "other-control changes cannot erase A's uncertainty");
});

test("same-control deliberate A-B-A is a new intent even when first A was unconfirmed", async () => {
  const sent = [];
  const sync = await seeded((path, options) => { sent.push(options.body); if (sent.length === 1) throw new Error("lost"); return snapshot(sent.length + 1); });
  const options = body => ({ method: "POST", autosaveKey: "one-control", coalesce: true, body });
  await assert.rejects(sync.request("/same", options("A")));
  await sync.request("/same", options("B"));
  await sync.request("/same", options("A"));
  assert.deepEqual(sent, ["A", "B", "A"]);
});

test("automatic saves require an explicit stable logical identity and never send it to the transport", async () => {
  let calls = 0;
  const sync = await seeded((path, options) => { calls++; assert.equal(options.autosaveKey, undefined); assert.equal(options.coalesce, undefined); return snapshot(2); });
  await assert.rejects(sync.request("/same", { method: "POST", coalesce: true }), /logical control identity/);
  assert.equal(calls, 0);
  await sync.request("/same", { method: "POST", coalesce: true, autosaveKey: "A" });
  assert.equal(calls, 1);
});

test("partial receipts cannot version old plans/goals/completions or authorize matching summaries before full reconciliation", async () => {
  let result;
  const sync = await seeded(() => result);
  const old = sync.state.data;
  result = { revision: 5, coach_memories: [{ key: "new" }], storage_warnings: [] };
  await sync.request("/memory", { method: "POST" });
  assert.equal(sync.state.data, old);
  assert.equal(sync.state.data.revision, 1);
  assert.equal(sync.state.receiptHead.revision, 5);
  result = { revision: 5, summary_text: "other-tab revised plan" };
  assert.equal(await sync.request("/api/coach-summary"), null);
  assert.equal(sync.state.summary, null);
  result = snapshot(5, { active_plan: { title: "other-tab revised plan" }, goals: { primary: "new" }, coach_memories: [{ key: "new" }], completions: { new: true } });
  await sync.request("/api/state");
  assert.equal(sync.state.needsReconcile, false);
  assert.equal(sync.state.data.active_plan.title, "other-tab revised plan");
  result = { revision: 5, summary_text: "current reconciled plan" };
  assert.equal((await sync.request("/api/coach-summary")).summary_text, "current reconciled plan");
});

test("restore race revision11 without restored_at displays latest authoritative snapshot, blocks edits until explicit consistent resync, never replays", async () => {
  let result, mutations = 0;
  const sync = await seeded((path, options = {}) => { if (options.method) mutations++; return result; });
  result = snapshot(10); await sync.request("/api/state");
  result = snapshot(2, { restored_at: "2026-11-04T10:00:00.000Z", active_plan: { title: "restored" } });
  await sync.request("/api/state");
  result = snapshot(11, { active_plan: { title: "racing updater committed" } });
  assert.equal((await sync.request("/api/state")).revision, 11);
  assert.equal(sync.state.data.active_plan.title, "racing updater committed");
  assert.equal(sync.state.recoveryRequired, true);
  assert.match(sync.state.recoveryWarning, /Recovery mismatch.*latest server snapshot/);
  await assert.rejects(sync.request("/write", { method: "PATCH" }), /No save was sent/);
  assert.equal(mutations, 0);
  result = { revision: 11, summary_text: "not safe before resync" };
  assert.equal(await sync.request("/api/coach-summary"), null);
  result = snapshot(11); await sync.request("/api/state");
  assert.equal(sync.state.recoveryRequired, true, "automatic reads cannot clear explicit resync requirement");
  await sync.request("/api/state", { resync: true });
  assert.equal(sync.state.recoveryRequired, false);
  assert.match(sync.state.recoveryWarning, /Resynced.*operator review/);
  assert.equal(mutations, 0);
});

test("resync request that discovers another revision anomaly stays blocked until another consistent explicit read", async () => {
  let result; const sync = await seeded(() => result);
  result = snapshot(0); await sync.request("/api/state");
  result = snapshot(8); await sync.request("/api/state", { resync: true });
  assert.equal(sync.state.recoveryRequired, true);
  assert.equal(sync.state.data.revision, 8);
  await sync.request("/api/state", { resync: true });
  assert.equal(sync.state.recoveryRequired, false);
});

test("browser: two exercise controls preserve A uncertainty after B acknowledgement and later flusher", async () => {
  const sent = [];
  const app = browser(async (path, options = {}) => {
    if (options.method) { const body = JSON.parse(options.body); sent.push(body.exercise_id); if (body.exercise_id === "A") throw new Error("lost A ack"); return response(snapshot(2)); }
    return response({ revision: 2, summary_text: "current" });
  });
  await assert.rejects(app.run('saveExerciseLog("activity", {exercise_id:"A",reps:1}, {silent:true,rerender:false})'));
  await app.run('saveExerciseLog("activity", {exercise_id:"B",reps:1}, {silent:true,rerender:false})');
  await assert.rejects(app.run('saveExerciseLog("activity", {exercise_id:"A",reps:1}, {silent:true,rerender:false})'));
  assert.deepEqual(sent, ["A", "B"]);
});


test("browser: partial memory receipt reconciles complete state, and a failed reconciliation cannot authorize its summary", async () => {
  let failRead = true;
  const app = browser(async (path, options = {}) => {
    if (options.method) return response({ revision: 7, coach_memories: [], storage_warnings: [] });
    if (path === "/api/state") { if (failRead) throw new Error("state unavailable"); return response(snapshot(7, { active_plan: { title: "new plan" } })); }
    return response({ revision: 7, summary_text: "new plan" });
  });
  await app.run('api("/api/coach-memories/upsert", {method:"POST",body:"{}"})');
  assert.equal(app.sync.state.saveStatus, "saved");
  assert.equal(app.sync.state.needsReconcile, true);
  assert.equal(app.state.data, null);
  await app.run("refreshCoachSummary()");
  assert.equal(app.elements.coachSummary.value, "");
  failRead = false; await app.run("loadState()");
  assert.equal(app.state.data.active_plan.title, "new plan");
  assert.equal(app.elements.coachSummary.value, "new plan");
});

test("browser: missing restore marker displays latest state with explicit recovery message, reads do not replay writes", async () => {
  let result = snapshot(2, { restored_at: "2026-11-04T10:00:00.000Z" }); let writes = 0;
  const app = browser(async (path, options = {}) => { if (options.method) writes++; return response(path === "/api/coach-summary" ? { revision: result.revision, restored_at: result.restored_at, summary_text: "summary" } : result); });
  await app.run("loadState()");
  result = snapshot(11, { active_plan: { title: "authoritative racing updater" } });
  await app.run("loadState()");
  assert.equal(app.state.data.revision, 11);
  assert.equal(app.state.data.active_plan.title, "authoritative racing updater");
  assert.match(app.elements.message.textContent, /Recovery mismatch/);
  assert.equal(app.elements.coachSummary.value, "");
  await app.run("loadState({resync:true})");
  assert.match(app.elements.message.textContent, /Resynced.*operator review/);
  assert.equal(app.elements.coachSummary.value, "summary");
  assert.equal(writes, 0);
});

test("queued mutations do not execute after an earlier acknowledged response discovers inconsistent recovery metadata", async () => {
  let result = snapshot(5), calls = 0;
  const sync = await seeded(() => { calls++; return result; });
  await sync.request("/api/state");
  result = snapshot(2, { restored_at: "2026-11-04T10:00:00.000Z" }); await sync.request("/api/state");
  result = snapshot(11);
  const first = sync.request("/first", { method: "POST" });
  const queued = sync.request("/second", { method: "POST", coalesce: true, autosaveKey: "second" });
  await first; await assert.rejects(queued, /No save was sent/);
  assert.equal(calls, 3, "two reads plus exactly one mutation");
  assert.equal(sync.state.saveStatus, "blocked");
});


test("browser: recovery and resync cancel running and queued activity intents, render inspected state before stalled flush unwinds", async () => {
  const flush = deferred(); const sent = []; let result = snapshot(2, { restored_at: "2026-11-04T10:00:00.000Z", completions: { synthetic: { subtasks: { a: false } } } });
  const app = browser(async (path, options = {}) => {
    if (options.method === "PATCH") { sent.push(JSON.parse(options.body)); result = snapshot(12, { completions: { synthetic: { subtasks: { a: false } } } }); return response(result); }
    return response(path === "/api/state" ? result : { revision: result.revision, restored_at: result.restored_at, summary_text: "current" });
  });
  await app.run("loadState()");
  app.installActivityHandlers(); app.context.activeAutosaveFlushers.add(() => flush.promise);
  const checkbox = { dataset: { subtaskId: "a" }, checked: true };
  const event = { target: { closest: () => checkbox } };
  const running = app.listeners.subtask(event);
  checkbox.checked = false; const queued = app.listeners.subtask(event);
  await turn(); assert.equal(app.sync.state.pendingIntents, 2); assert.deepEqual(sent, []);
  result = snapshot(11, { completions: { synthetic: { subtasks: { a: false } } } });
  await app.run("loadState()");
  assert.equal(app.sync.state.recoveryRequired, true);
  assert.equal(app.sync.state.pendingIntents, 2);
  assert.equal(app.sync.state.pendingCurrentIntents, 0);
  assert.deepEqual(app.rendered.map(x => x.revision), [2, 11]);
  await app.run("loadState({resync:true})");
  assert.equal(app.sync.state.recoveryRequired, false);
  assert.equal(app.sync.state.pendingIntents, 2, "old intent work is still suspended");
  assert.deepEqual(app.rendered.map(x => x.revision), [2, 11, 11]);
  assert.match(app.elements.message.textContent, /pending edits were canceled/);
  flush.resolve(); await Promise.all([running, queued]);
  assert.deepEqual(sent, [], "neither running nor queued pre-recovery tap was replayed after resync");
  assert.equal(app.sync.state.pendingIntents, 0);
  assert.equal(app.state.data.revision, 11);
  await app.run('updateActivity("synthetic", {subtask_id:"a",completed:false})');
  assert.deepEqual(sent, [{ subtask_id: "a", completed: false }], "only a new deliberate action sends a mutation");
});

test("browser: a single captured checkbox intent remains canceled after recovery and resync release its autosave wait", async () => {
  const flush = deferred(); let writes = 0;
  let result = snapshot(2, { restored_at: "2026-11-04T10:00:00.000Z" });
  const app = browser(async (path, options = {}) => { if (options.method === "PATCH") writes++; return response(path === "/api/state" ? result : { revision: result.revision, restored_at: result.restored_at, summary_text: "current" }); });
  await app.run("loadState()"); app.context.activeAutosaveFlushers.add(() => flush.promise);
  const action = app.run('updateActivity("synthetic", {subtask_id:"a",completed:true})');
  await turn(); result = snapshot(11); await app.run("loadState()"); await app.run("loadState({resync:true})");
  assert.equal(app.sync.state.pendingIntents, 1); assert.equal(app.rendered.at(-1).revision, 11);
  flush.resolve(); await action; assert.equal(writes, 0); assert.equal(app.state.data.revision, 11);
});

test("captured guards never revive after explicit resync, including an HTTP request not yet enqueued", async () => {
  let result; let writes = 0; const sync = await seeded((path, options = {}) => { if (options.method) writes++; return result; });
  const intent = sync.captureIntent();
  result = snapshot(0); await sync.request("/api/state"); await sync.request("/api/state", {resync:true});
  assert.equal(intent.isCurrent(), false);
  await assert.rejects(sync.request("/write", {method:"PATCH", intent}), error => error.notSent && error.cancelledIntent);
  assert.equal(writes, 0);
});

test("browser transport rechecks a captured intent after asynchronous unlock and immediately before first send", async () => {
  const unlock = deferred(); let current = true, writes = 0;
  const app = browser(async () => { writes++; return response(snapshot(2)); });
  app.state.writeAccess = false;
  app.context.requestWriteAccess = () => unlock.promise;
  app.context.guard = { assertCurrent() { if (!current) { const error = new Error("canceled"); error.notSent = true; throw error; } } };
  const action = app.run('sendApi("/write", {method:"PATCH",body:"{}"}, guard)');
  await turn(); current = false; unlock.resolve(true);
  await assert.rejects(action, error => error.notSent);
  assert.equal(writes, 0);
});

test("browser: detached pre-recovery feedback control cannot silently recapture its old payload after resync", async () => {
  let result = snapshot(2, { restored_at: "2026-11-04T10:00:00.000Z" }); let writes = 0;
  const app = browser(async (path, options = {}) => { if (options.method) writes++; return response(path === "/api/state" ? result : { revision: result.revision, restored_at: result.restored_at, summary_text: "current" }); });
  await app.run("loadState()");
  const events = {}, form = {values:{notes:"old"},elements:{},querySelector:()=>null,addEventListener:(name,fn)=>{events[name]=fn},closest:()=>({})};
  app.context.form = form;
  app.run('attachFeedbackAutosave(form, {activity_id:"synthetic"})');
  const oldFlush = [...app.context.activeAutosaveFlushers][0]; form.values.notes = "captured old control change";
  result = snapshot(11); await app.run("loadState()"); await app.run("loadState({resync:true})");
  await oldFlush(); assert.equal(writes, 0);
});


test("browser: an observed normal restore also cancels suspended pre-restore activity intents without recapturing them", async () => {
  const flush = deferred(); let writes = 0; let result = snapshot(10);
  const app = browser(async (path, options = {}) => { if (options.method === "PATCH") writes++; return response(path === "/api/state" ? result : { revision: result.revision, restored_at: result.restored_at, summary_text: "current" }); });
  await app.run("loadState()"); app.context.activeAutosaveFlushers.add(() => flush.promise);
  const action = app.run('updateActivity("synthetic", {completed:true})'); await turn();
  result = snapshot(2, { restored_at: "2026-11-04T10:00:00.000Z" }); await app.run("loadState()");
  assert.equal(app.sync.state.recoveryRequired, false);
  assert.equal(app.sync.state.pendingIntents, 1); assert.equal(app.sync.state.pendingCurrentIntents, 0);
  assert.equal(app.rendered.at(-1).revision, 2);
  flush.resolve(); await action; assert.equal(writes, 0);
});


const planSnapshot = (revision, ids, extra = {}) => snapshot(revision, { active_plan: { activities: ids.map(activity_id => ({ activity_id })) }, ...extra });

test("actual bulk handler preserves its click guard through an initial autosave wait and normal restore; only a new click sends", async () => {
  const flush = deferred(), sent = []; let result = planSnapshot(10, ["old-A", "old-B"]);
  const app = browser(async (path, options = {}) => {
    if (options.method === "PATCH") { sent.push(path); result = planSnapshot(3, ["new-A"], { restored_at: "2026-11-04T10:00:00.000Z" }); return response(result); }
    return response(path === "/api/state" ? result : { revision: result.revision, restored_at: result.restored_at, summary_text: "current" });
  });
  await app.run("loadState()"); app.installBulkHandler(); app.context.activeAutosaveFlushers.add(() => flush.promise);
  const action = app.listeners.bulk(); await turn();
  result = planSnapshot(2, ["new-A"], { restored_at: "2026-11-04T10:00:00.000Z" }); await app.run("loadState()");
  flush.resolve(); await action; assert.deepEqual(sent, []);
  assert.match(app.elements.message.textContent, /bulk completion edits were canceled/);
  await app.listeners.bulk(); assert.deepEqual(sent, ["/api/activities/new-A"]);
});

test("actual bulk handler cannot remint captured old activities after anomaly and explicit resync during its initial wait", async () => {
  const flush = deferred(), sent = []; let result = planSnapshot(2, ["old-A", "old-B"], { restored_at: "2026-11-04T10:00:00.000Z" });
  const app = browser(async (path, options = {}) => { if (options.method === "PATCH") sent.push(path); return response(path === "/api/state" ? result : { revision: result.revision, restored_at: result.restored_at, summary_text: "current" }); });
  await app.run("loadState()"); app.installBulkHandler(); app.context.activeAutosaveFlushers.add(() => flush.promise);
  const action = app.listeners.bulk(); await turn();
  result = planSnapshot(11, ["new-A"]); await app.run("loadState()"); await app.run("loadState({resync:true})");
  assert.equal(app.sync.state.recoveryRequired, false);
  flush.resolve(); await action; assert.deepEqual(sent, []);
  assert.equal(app.state.data.active_plan.activities[0].activity_id, "new-A");
});

for (const anomaly of [false, true]) test(`actual bulk handler cancels remaining captured activities when ${anomaly ? "anomaly/resync" : "normal restore"} occurs between loop iterations`, async () => {
  const firstSummary = deferred(), entered = deferred(), sent = []; let held = false;
  const oldGeneration = anomaly ? { restored_at: "2026-11-04T10:00:00.000Z" } : {};
  let result = planSnapshot(10, ["old-A", "old-B"], oldGeneration);
  const app = browser(async (path, options = {}) => {
    if (options.method === "PATCH") { sent.push(path); result = planSnapshot(11, ["old-A", "old-B"], oldGeneration); return response(result); }
    if (path === "/api/coach-summary" && sent.length === 1 && !held) { held = true; entered.resolve(); return firstSummary.promise; }
    return response(path === "/api/state" ? result : { revision: result.revision, restored_at: result.restored_at, summary_text: "current" });
  });
  await app.run("loadState()"); app.installBulkHandler();
  const action = app.listeners.bulk(); await entered.promise;
  result = anomaly ? planSnapshot(12, ["new-A"]) : planSnapshot(2, ["new-A"], { restored_at: "2026-11-04T11:00:00.000Z" });
  await app.run("loadState()"); if (anomaly) await app.run("loadState({resync:true})");
  firstSummary.resolve(response({ revision: 11, ...oldGeneration, summary_text: "old" })); await action;
  assert.deepEqual(sent, ["/api/activities/old-A"], "already acknowledged first write stays saved; no remaining old activity is sent");
  assert.equal(app.state.data.active_plan.activities[0].activity_id, "new-A");
});

test("actual exercise swap timer cannot rebuild an old control with a fresh guard after recovery/resync", async () => {
  let result = snapshot(2, { restored_at: "2026-11-04T10:00:00.000Z" }), writes = 0, rebuilt = 0; const handlers = {};
  const app = browser(async (path, options = {}) => { if (options.method) writes++; return response(path === "/api/state" ? result : { revision: result.revision, restored_at: result.restored_at, summary_text: "current" }); });
  await app.run("loadState()"); app.installExerciseAutosave();
  app.context.row = { addEventListener() {}, querySelector: () => null, isConnected: true };
  app.context.controls = { payload: () => ({ exercise_id: "A", reps: 1 }), status: {}, inputs: [], elements: [], updateTotal() {}, swap: { addEventListener: (name, fn) => { handlers[name] = fn; } } };
  app.context.appendExerciseLogControls = () => { rebuilt++; return {status:{}}; };
  app.run('attachExerciseLogAutosave(row, {activity_id:"old-A"}, {exercise_id:"A"}, controls)');
  handlers.change();
  result = snapshot(11); await app.run("loadState()"); await app.run("loadState({resync:true})");
  app.expireToasts(); await turn();
  assert.equal(rebuilt, 0); assert.equal(writes, 0);
});


test("persisted exercise draft shown after recovery is preserved but cannot be automatically reminted under a fresh control guard", async () => {
  let result = snapshot(2, { restored_at: "2026-11-04T10:00:00.000Z" }), writes = 0, clears = 0;
  const app = browser(async (path, options = {}) => { if (options.method) { writes++; result = snapshot(12); } return response(path === "/api/state" || options.method ? result : { revision: result.revision, restored_at: result.restored_at, summary_text: "current" }); });
  await app.run("loadState()"); result = snapshot(11); await app.run("loadState()"); await app.run("loadState({resync:true})");
  app.installExerciseAutosave();
  const handlers = {}, payload = { exercise_id: "A", title: "Synthetic preserved draft", reps: 3 };
  app.context.readExerciseDraft = () => ({ ...payload });
  app.context.clearExerciseDraft = () => { clears++; };
  app.context.row = { addEventListener:(name,fn)=>{handlers[name]=fn}, querySelector:()=>null, isConnected:true };
  app.context.controls = {payload:()=>({...payload}),status:{},inputs:[],elements:[],updateTotal(){},swap:{addEventListener(){}}};
  app.run('attachExerciseLogAutosave(row, {activity_id:"current-A"}, {exercise_id:"A"}, controls)');
  await app.run("flushActiveAutosaves()"); await app.run("flushActiveAutosaves()");
  assert.equal(writes, 0); assert.equal(clears, 0, "draft remains available for explicit review");
  await handlers.submit({preventDefault(){}}); assert.equal(writes, 1); assert.equal(clears, 1);
});

test("a new deliberate field edit reviews a displayed exercise draft and permits one automatic save", async () => {
  let writes = 0; const app = browser(async (path, options = {}) => { if (options.method) writes++; return response(options.method ? snapshot(2) : { revision:2,summary_text:"current" }); });
  app.installExerciseAutosave(); const inputHandlers = {}, payload = { exercise_id:"A",reps:3 };
  app.context.readExerciseDraft=()=>({...payload}); app.context.row={addEventListener(){},querySelector:()=>null,isConnected:true};
  app.context.controls={payload:()=>({...payload}),status:{},inputs:[{addEventListener:(name,fn)=>{inputHandlers[name]=fn}}],elements:[],updateTotal(){},swap:{addEventListener(){}}};
  app.run('attachExerciseLogAutosave(row, {activity_id:"current-A"}, {exercise_id:"A"}, controls)');
  await app.run("flushActiveAutosaves()"); assert.equal(writes,0);
  payload.reps=4; inputHandlers.input(); await app.run("flushActiveAutosaves()"); assert.equal(writes,1);
});
