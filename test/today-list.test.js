const test = require("node:test");
const assert = require("node:assert/strict");
const { compareActivitiesByDateThenTitle, selectTodaysView, todayFallbackNotice, todayEmptyCopy, localDateKey, shouldRerenderForNewDate } = require("../today-list");

const workout = (id, date, title = id, completed = false) => ({ activity_id: id, date, title, completion: { completed } });
const select = (activities, overrideActivityId, todayKey = "2026-11-02") => selectTodaysView({ activities, todayKey, overrideActivityId });
const notice = (view) => todayFallbackNotice({ ...view, activity: view.activities[0], formatDate: (date) => new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00`)) });

test("fallback names the next unfinished date and workout exactly", () => {
  const next = workout("next", "2026-11-03", "Lower body strength");
  const view = select([workout("done", "2026-11-01", "Done", true), next]);
  assert.equal(view.mode, "fallback");
  assert.deepEqual(view.activities, [next]);
  assert.equal(notice(view), "Nothing scheduled today, showing next unfinished: Tue, Nov 3 · Lower body strength");
});

test("fallback sorts by date then title without mutating array order", () => {
  const later = workout("later", "2026-11-05");
  const earlier = workout("earlier", "2026-11-01", "A workout");
  const input = [later, workout("tie", "2026-11-01", "Z workout"), earlier];
  assert.deepEqual(select(input).activities, [earlier]);
  assert.equal(input[0], later);
});

test("date-then-title sort tolerates missing date or title", () => {
  const missing = { activity_id: "missing", completion: { completed: false } };
  const titled = workout("titled", "2026-11-04", "Titled");
  assert.doesNotThrow(() => compareActivitiesByDateThenTitle(missing, titled));
  assert.deepEqual(select([titled, missing]).activities, [missing]);
});

test("empty and all-complete views have honest copy and no notice", () => {
  for (const activities of [[workout("done", "2026-11-01", "Done", true)], []]) {
    const view = select(activities);
    assert.equal(view.mode, activities.length ? "all-complete" : "empty");
    assert.deepEqual(view.activities, []);
    assert.equal(notice(view), null);
    assert.equal(todayEmptyCopy(view.mode), activities.length
      ? "Nothing scheduled today, and nothing left unfinished."
      : "No activities are scheduled yet. Import a weekly plan to get started.");
  }
});

test("explicit override wins and suppresses notice even on a different date", () => {
  const override = workout("chosen", "2026-11-10");
  for (const extras of [[], [workout("today", "2026-11-02")]]) {
    const view = select([workout("earlier", "2026-11-01"), override, ...extras], "chosen");
    assert.equal(view.mode, "override");
    assert.deepEqual(view.activities, [override]);
    assert.equal(notice(view), null);
  }
});

test("scheduled activities win in original order even when completed", () => {
  for (const completed of [false, true]) {
    const today = [workout("z", "2026-11-02", "Z", completed), workout("a", "2026-11-02", "A", completed)];
    const view = select([workout("before", "2026-11-01"), ...today, workout("after", "2026-11-03")]);
    assert.equal(view.mode, "scheduled");
    assert.deepEqual(view.activities, today);
    assert.equal(notice(view), null);
  }
});

test("local dates and visibility refresh cross midnight, not UTC midnight", () => {
  const previousTZ = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const evening = new Date("2026-11-03T23:30:00-05:00");
    const sameDay = new Date("2026-11-03T23:59:00-05:00");
    const midnight = new Date("2026-11-04T00:01:00-05:00");
    assert.equal(evening.toISOString().slice(0, 10), "2026-11-04");
    assert.equal(localDateKey(evening), "2026-11-03");
    assert.equal(localDateKey(midnight), "2026-11-04");
    assert.equal(shouldRerenderForNewDate(localDateKey(evening), sameDay), false);
    assert.equal(shouldRerenderForNewDate(localDateKey(evening), midnight), true);
    const yesterday = workout("yesterday", "2026-11-03");
    assert.equal(select([yesterday], null, localDateKey(evening)).mode, "scheduled");
    assert.equal(select([yesterday], null, localDateKey(midnight)).mode, "fallback");
    assert.equal(select([workout("done", "2026-11-03", "Done", true)], null, localDateKey(midnight)).mode, "all-complete");
    // 2026-11-01 is the America/New_York fall-back day (25-hour local day).
    const beforeFallback = new Date("2026-11-01T00:30:00-04:00");
    const afterFallback = new Date("2026-11-01T01:30:00-05:00");
    const endOfFallbackDay = new Date("2026-11-01T23:30:00-05:00");
    assert.equal(localDateKey(beforeFallback), "2026-11-01");
    assert.equal(localDateKey(afterFallback), "2026-11-01");
    assert.equal(localDateKey(endOfFallbackDay), "2026-11-01");
    assert.equal(shouldRerenderForNewDate("2026-11-01", endOfFallbackDay), false);
    const dayAfterFallback = new Date("2026-11-02T00:01:00-05:00");
    assert.equal(localDateKey(dayAfterFallback), "2026-11-02");
    assert.equal(shouldRerenderForNewDate("2026-11-01", dayAfterFallback), true);
  } finally {
    if (previousTZ === undefined) delete process.env.TZ;
    else process.env.TZ = previousTZ;
  }
});
