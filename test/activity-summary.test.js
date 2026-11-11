const test = require("node:test");
const assert = require("node:assert/strict");
const { activityCardText } = require("../activity-summary.js");

const safety = "Stop if knee symptoms worsen. No weighted vest or face pulls.";

test("duration stays in the visible summary; prose goes to coach notes", () => {
  const activity = { target: { estimated_duration_minutes: 35, intensity: "Challenging", time_budget_minutes: 45, notes: safety } };
  const { summary, notes } = activityCardText(activity);
  assert.equal(summary, "About 35 min");
  assert.deepEqual(notes, ["45 min available", "Challenging", safety]);
  assert.ok(!summary.includes("Challenging") && !summary.includes("knee"));
});

test("activity.notes is used when target.notes is absent", () => {
  const { notes } = activityCardText({ target: { duration_minutes: 20 }, notes: safety });
  assert.deepEqual(notes, [safety]);
});

test("no prose yields empty notes so no expander renders", () => {
  const { summary, notes } = activityCardText({ target: { duration_minutes: 20 } });
  assert.equal(summary, "About 20 min");
  assert.deepEqual(notes, []);
  assert.deepEqual(activityCardText({}).notes, []);
});

test("distance stays in the summary", () => {
  const { summary, notes } = activityCardText({ target: { distance_miles: 3, duration_minutes: 30, intensity: "Easy" } });
  assert.equal(summary, "3 mi · About 30 min");
  assert.deepEqual(notes, ["Easy"]);
});
