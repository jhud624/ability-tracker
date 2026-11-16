// Shared rules for how an exercise is logged and what to suggest next time.
// Used by the browser, the plan import path, and the tests. Keeping one copy
// stops the TODAY card and a later MCP import from disagreeing.

function normalizeIdentityText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function baseExerciseTitle(title) {
  return String(title || "")
    .split(/\s+[—–-]\s+/)[0]
    .replace(/\b\d+\s*[xX×]\s*\d+.*$/g, "")
    .replace(/\b\d+\s*(min|minute|minutes|sec|second|seconds)\b.*$/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripSessionLeadIn(title) {
  return String(title || "").replace(/^\s*(?:warm[\s-]?up|cool[\s-]?down)\s*:\s*/i, "");
}

const EQUIPMENT_PREFIX = /^(?:barbell|dumbbell|kettlebell|cable|band|banded|ez bar|trap bar|smith machine)\s+/;

function loosenEquipment(name) {
  let current = String(name || "");
  let previous = "";
  while (current && current !== previous) {
    previous = current;
    current = current.replace(EQUIPMENT_PREFIX, "");
  }
  return current;
}

function exerciseIdentityKey(title, glossary = []) {
  const base = normalizeIdentityText(stripSessionLeadIn(baseExerciseTitle(title)));
  const loose = loosenEquipment(base);
  if (!base && !loose) return "";
  const entry = (glossary || []).find((item) => {
    const names = [item?.canonical_name, ...(item?.aliases || [])];
    return names.some((name) => {
      const normalized = normalizeIdentityText(name);
      const loosened = loosenEquipment(normalized);
      return normalized === base || loosened === loose || normalized === loose || loosened === base;
    });
  });
  if (entry) return `glossary:${entry.glossary_id || loosenEquipment(normalizeIdentityText(entry.canonical_name))}`;
  return `name:${loose || base}`;
}

function normalizeLogMode(value) {
  const mode = String(value || "").trim().toLowerCase();
  if (mode === "check" || mode === "strength" || mode === "timed" || mode === "loaded-timed") return mode;
  return undefined;
}

function normalizeProgression(value) {
  const direction = String(value || "").trim().toLowerCase();
  if (direction === "up" || direction === "hold" || direction === "down") return direction;
  return undefined;
}

function isCheckOnlyTitle(title) {
  return /^\s*(log|note|record|journal|rate|review)\b/i.test(String(title || ""));
}

function isWarmupOrCooldown(title) {
  return /\b(warm[\s-]?ups?|cool[\s-]?downs?)\b/i.test(String(title || ""));
}

function isLoadedTimedTitle(title) {
  return /\b(sleds?|carries|carry|farmers?|weighted|vests?|drags?)\b/i.test(String(title || ""));
}

function isUnloadedMobilityTitle(title) {
  return /\b(stretch(?:es)?|mobility|circles?|rolls?|breathing|foam\s*rolls?|cat[-\s]?cows?|dead\s?bugs?|open\s?books?|hip\s*flexors?|pigeon|backward\s*walk(?:ing)?|world'?s\s+greatest|resets?)\b/i.test(String(title || ""));
}

function parseSetRepPrescription(title) {
  const match = String(title || "").match(/(\d+)\s*[x×]\s*(\d+(?:\s*[-–]\s*\d+)?)\s*(sec|second|seconds|min|minute|minutes)?/i);
  if (!match) return null;
  return {
    sets: match[1],
    reps: match[2].replace(/\s+/g, ""),
    unit: match[3] ? match[3].toLowerCase() : null
  };
}

function exerciseSupportsDuration(title) {
  return /\b(timer|hold|stretch|plank|walk|warmup|warm-up|cooldown|cool-down|reset|circuit|breathing|mobility|sec|second|seconds|min|minute|minutes)\b/i.test(String(title || ""));
}

// Explicit log_mode always wins, including check. Otherwise warm-ups, cool-downs,
// and unloaded mobility are checkbox rows. Strength prescriptions and loaded
// carries stay loggable.
function resolveExerciseLogMode(title, explicitMode) {
  const explicit = normalizeLogMode(explicitMode);
  if (explicit) return explicit;
  if (isCheckOnlyTitle(title) || isWarmupOrCooldown(title)) return "check";
  const prescription = parseSetRepPrescription(title);
  if (prescription && !prescription.unit) return "strength";
  if (isLoadedTimedTitle(title)) return "loaded-timed";
  if (isUnloadedMobilityTitle(title)) return "check";
  if (!exerciseSupportsDuration(title)) return "strength";
  return "timed";
}

function parseRepRange(title) {
  const text = String(title || "");
  const cross = text.match(/(\d+)\s*[x×]\s*(\d+)(?:\s*[-–]\s*(\d+))?\s*(sec|second|seconds|min|minute|minutes)?/i);
  if (cross && !cross[4]) {
    const low = Number(cross[2]);
    const high = Number(cross[3] || cross[2]);
    return { min: Math.min(low, high), max: Math.max(low, high) };
  }
  const ofRange = text.match(/(\d+)\s*[-–]\s*(\d+)\s*reps?\b/i);
  if (ofRange) return { min: Number(ofRange[1]), max: Number(ofRange[2]) };
  const setsOf = text.match(/\bsets?\s+of\s+(\d+)(?:\s*[-–]\s*(\d+))?/i);
  if (setsOf) {
    const low = Number(setsOf[1]);
    const high = Number(setsOf[2] || setsOf[1]);
    return { min: Math.min(low, high), max: Math.max(low, high) };
  }
  const reps = text.match(/\b(\d+)\s+reps?\b/i);
  if (reps) return { min: Number(reps[1]), max: Number(reps[1]) };
  return null;
}

function parseRpeTarget(title) {
  const match = String(title || "").match(/\brpe\s*(\d+(?:\.\d+)?)(?:\s*[-–]\s*(\d+(?:\.\d+)?))?/i);
  if (!match) return null;
  const low = Number(match[1]);
  const high = Number(match[2] || match[1]);
  return { min: Math.min(low, high), max: Math.max(low, high) };
}

function prefillFromLog(log) {
  if (!log || typeof log !== "object") return null;
  const prefill = {};
  for (const field of ["weight_lbs", "sets", "reps"]) {
    const number = Number(log[field]);
    if (Number.isFinite(number) && number > 0) prefill[field] = String(number);
  }
  return Object.keys(prefill).length ? prefill : null;
}

function logHasStrengthData(log) {
  return Boolean(prefillFromLog(log));
}

function previousStrengthSession({ history, activity, title, glossary } = {}) {
  const key = exerciseIdentityKey(title, glossary);
  if (!key) return null;
  const activityId = activity?.activity_id;
  const activityDate = activity?.date || "";
  const matches = [];
  for (const item of history || []) {
    if (!item || item.activity_id === activityId) continue;
    if (activityDate && item.date && item.date > activityDate) continue;
    const logs = item.exercise_logs || {};
    const subtasks = item.subtasks || [];
    for (const [exerciseId, log] of Object.entries(logs)) {
      if (!logHasStrengthData(log)) continue;
      const subtask = subtasks.find((entry) => entry.subtask_id === exerciseId);
      const loggedTitle = String(log?.title || "").trim();
      const prescribedTitle = String(subtask?.title || "").trim();
      // The selector stores the movement they actually performed on log.title.
      // The subtask title stays the original prescription, so it is only a fallback.
      const identityTitle = loggedTitle || prescribedTitle;
      if (exerciseIdentityKey(identityTitle, glossary) !== key) continue;
      const sameMovement = !loggedTitle || !prescribedTitle
        || exerciseIdentityKey(loggedTitle, glossary) === exerciseIdentityKey(prescribedTitle, glossary);
      matches.push({
        activity_id: item.activity_id,
        date: item.date || "",
        updated_at: log.updated_at || "",
        log,
        prescriptionTitle: sameMovement ? (prescribedTitle || loggedTitle) : loggedTitle,
        feedback: item.feedback || null
      });
    }
  }
  matches.sort((a, b) => String(b.date).localeCompare(String(a.date))
    || String(b.updated_at).localeCompare(String(a.updated_at)));
  return matches[0] || null;
}

function progressionCue({ previous, prescriptionTitle, explicit } = {}) {
  const planned = normalizeProgression(explicit);
  if (planned) {
    const reason = {
      up: "This plan says to increase the load.",
      hold: "This plan says to keep the same load.",
      down: "This plan says to decrease the load."
    }[planned];
    return { direction: planned, source: "plan", reason };
  }
  if (!previous?.log) return null;

  const reps = Number(previous.log.reps);
  const hasReps = Number.isFinite(reps) && reps > 0;
  const range = parseRepRange(previous.prescriptionTitle) || parseRepRange(prescriptionTitle);
  const feedback = previous.feedback || {};
  const difficulty = Number(feedback.difficulty ?? feedback.rpe);
  const backPain = Number(feedback.back_pain);
  const rpe = parseRpeTarget(previous.prescriptionTitle) || parseRpeTarget(prescriptionTitle);
  const hasDifficulty = Number.isFinite(difficulty);
  const pain = Number.isFinite(backPain) && backPain > 0;
  const missed = Boolean(hasReps && range && reps < range.min);
  const topped = Boolean(hasReps && range && reps >= range.max);
  const aboveTarget = Boolean(hasDifficulty && rpe && difficulty > rpe.max);
  const highDifficulty = Boolean((hasDifficulty && difficulty >= 8) || aboveTarget);
  const lowDifficulty = Boolean(hasDifficulty && difficulty <= 6 && !aboveTarget);

  if (pain) {
    return { direction: "down", source: "history", reason: "Last session logged back pain." };
  }
  if (missed) {
    return { direction: "down", source: "history", reason: "Last session missed the rep range." };
  }
  if (highDifficulty) {
    return { direction: "down", source: "history", reason: "Last session felt harder than intended." };
  }
  if (topped && lowDifficulty) {
    return {
      direction: "up",
      source: "history",
      reason: "Last session hit the top of the rep range at low difficulty."
    };
  }
  return { direction: "hold", source: "history", reason: "Last session was on target. Keep the same load." };
}

// A session with no movement rows is logged as one entry. Its title often names
// the session ("Mobility") rather than a single drill, so it keeps a logging
// mode instead of collapsing to a checkbox.
function sessionLogMode(title, explicitMode) {
  const explicit = normalizeLogMode(explicitMode);
  if (explicit === "strength" || explicit === "timed" || explicit === "loaded-timed") return explicit;
  const prescription = parseSetRepPrescription(title);
  if (prescription && !prescription.unit) return "strength";
  if (!exerciseSupportsDuration(title)) return "strength";
  if (isLoadedTimedTitle(title)) return "loaded-timed";
  return "timed";
}

function exerciseGuidance({ history, activity, title, explicitMode, progression, glossary, suppressPrefill } = {}) {
  const mode = resolveExerciseLogMode(title, explicitMode);
  if (mode !== "strength") return { mode, prefill: null, cue: null };
  const previous = previousStrengthSession({ history, activity, title, glossary });
  const cue = progressionCue({ previous, prescriptionTitle: title, explicit: progression });
  const prefill = suppressPrefill ? null : prefillFromLog(previous?.log);
  return { mode, prefill, cue, previous };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    baseExerciseTitle,
    exerciseIdentityKey,
    normalizeLogMode,
    normalizeProgression,
    resolveExerciseLogMode,
    sessionLogMode,
    parseSetRepPrescription,
    parseRepRange,
    parseRpeTarget,
    prefillFromLog,
    previousStrengthSession,
    progressionCue,
    exerciseGuidance
  };
}
