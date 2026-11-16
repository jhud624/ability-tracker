const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveExerciseLogMode,
  exerciseIdentityKey,
  previousStrengthSession,
  prefillFromLog,
  progressionCue
} = require("../exercise-guidance");

test("check mode is the default for warm-ups, cool-downs, and unloaded mobility", () => {
  assert.equal(resolveExerciseLogMode("Warm-up: backward walking — 60 seconds"), "check");
  assert.equal(resolveExerciseLogMode("Warm-up: shoulder circles — 30 seconds"), "check");
  assert.equal(resolveExerciseLogMode("WARM-UP: BODYWEIGHT SQUAT — 1 SET OF 8 EASY REPS"), "check");
  assert.equal(resolveExerciseLogMode("Cool-down: supine hamstring stretch — 30 seconds per side"), "check");
  assert.equal(resolveExerciseLogMode("Couch stretch — 45 sec each side"), "check");
  assert.equal(resolveExerciseLogMode("Log difficulty and back pain"), "check");
});

test("explicit logging modes and real strength or loaded work stay loggable", () => {
  assert.equal(resolveExerciseLogMode("Warmup: bodyweight squat — 3x10", "strength"), "strength");
  assert.equal(resolveExerciseLogMode("Couch stretch — 45 sec each side", "timed"), "timed");
  assert.equal(resolveExerciseLogMode("Plank hold", "timed"), "timed");
  assert.equal(resolveExerciseLogMode("Plank hold"), "timed");
  assert.equal(resolveExerciseLogMode("Side plank 2x20 sec each side"), "timed");
  assert.equal(resolveExerciseLogMode("Barbell back squat — 3 sets of 8 reps at a moderate load (RPE 6)"), "strength");
  assert.equal(resolveExerciseLogMode("Horizontal press 3x8-10"), "strength");
  assert.equal(resolveExerciseLogMode("Farmer carry — 40 seconds"), "loaded-timed");
  assert.equal(resolveExerciseLogMode("Sled push", "loaded-timed"), "loaded-timed");
  assert.equal(resolveExerciseLogMode("Backward walk or sled 5 minutes"), "loaded-timed");
});

const glossary = [{
  glossary_id: "back-squat",
  canonical_name: "Back squat",
  aliases: ["Barbell back squat"]
}];

function session({ id, date, title, log, feedback, exerciseId = "squat" }) {
  return {
    activity_id: id,
    date,
    subtasks: [{ subtask_id: exerciseId, title }],
    exercise_logs: { [exerciseId]: { ...log, updated_at: log.updated_at || `${date}T12:00:00Z` } },
    feedback
  };
}

test("prefill lookup matches glossary identity and the most recent earlier session", () => {
  const today = { activity_id: "today", date: "2026-11-16" };
  const history = [
    session({
      id: "older",
      date: "2026-11-02",
      title: "Back squat — 3x8",
      log: { weight_lbs: 95, sets: 3, reps: 8, updated_at: "2026-11-02T12:00:00Z" }
    }),
    session({
      id: "newer",
      date: "2026-11-09",
      title: "Barbell back squat — 3 sets of 8 reps at a moderate load (RPE 6)",
      log: { title: "Back squat", weight_lbs: 135, sets: 3, reps: 8, updated_at: "2026-11-09T12:00:00Z" },
      feedback: { difficulty: 4, back_pain: 0 }
    }),
    session({
      id: "future",
      date: "2026-11-23",
      title: "Barbell back squat — 3x8",
      log: { weight_lbs: 185, sets: 3, reps: 5 }
    }),
    session({
      id: "curl",
      date: "2026-11-12",
      title: "Curl — 3x10",
      exerciseId: "curl",
      log: { weight_lbs: 40, sets: 3, reps: 10 }
    }),
    session({
      id: "today",
      date: "2026-11-16",
      title: "Barbell back squat — 3 sets of 8 reps",
      log: { weight_lbs: 155, sets: 3, reps: 8 }
    })
  ];

  assert.equal(
    exerciseIdentityKey("Barbell back squat — 3 sets of 8 reps", glossary),
    exerciseIdentityKey("Back squat", glossary)
  );
  assert.notEqual(
    exerciseIdentityKey("Front squat — 3x8"),
    exerciseIdentityKey("Back squat — 3x8")
  );

  const previous = previousStrengthSession({
    history,
    activity: today,
    title: "Barbell back squat — 3 sets of 8 reps at a moderate load (RPE 6)",
    glossary
  });
  assert.equal(previous.activity_id, "newer");
  assert.deepEqual(prefillFromLog(previous.log), { weight_lbs: "135", sets: "3", reps: "8" });
  assert.equal(previousStrengthSession({
    history,
    activity: today,
    title: "Bird-dog — 2 between-set bouts",
    glossary
  }), null);
});

test("the load arrow follows the last session, and a plan override wins", () => {
  const easyTop = {
    log: { reps: 8 },
    prescriptionTitle: "Barbell back squat — 3 sets of 8 reps at a moderate load (RPE 6)",
    feedback: { difficulty: 4, back_pain: 0 }
  };
  assert.equal(progressionCue({ previous: easyTop }).direction, "up");
  assert.match(progressionCue({ previous: easyTop }).reason, /top of the rep range/i);

  const missed = { ...easyTop, log: { reps: 6 }, feedback: { difficulty: 4, back_pain: 0 } };
  assert.equal(progressionCue({ previous: missed }).direction, "down");
  assert.match(progressionCue({ previous: missed }).reason, /missed the rep range/i);

  const hard = { ...easyTop, feedback: { difficulty: 9, back_pain: 0 } };
  assert.equal(progressionCue({ previous: hard }).direction, "down");

  const painful = { ...easyTop, feedback: { difficulty: 4, back_pain: 3 } };
  assert.equal(progressionCue({ previous: painful }).direction, "down");
  assert.match(progressionCue({ previous: painful }).reason, /back pain/i);

  const middle = {
    log: { reps: 7 },
    prescriptionTitle: "Squat — 3x6-8",
    feedback: { difficulty: 5, back_pain: 0 }
  };
  assert.equal(progressionCue({ previous: middle }).direction, "hold");

  const noDifficulty = { ...easyTop, feedback: { back_pain: 0 } };
  assert.equal(progressionCue({ previous: noDifficulty }).direction, "hold");

  assert.equal(progressionCue({ previous: easyTop, explicit: "down" }).direction, "down");
  assert.equal(progressionCue({ previous: easyTop, explicit: "down" }).source, "plan");
  assert.equal(progressionCue({ previous: null }), null);
  assert.equal(progressionCue({ previous: null, explicit: "up" }).direction, "up");
  assert.equal(prefillFromLog(null), null);
  assert.equal(prefillFromLog({ duration_seconds: 60 }), null);
});
