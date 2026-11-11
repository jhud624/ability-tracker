// Pure presentation helpers for the Today card.
function selectTodaysView({ activities, todayKey, overrideActivityId }) {
  const override = activities.find((activity) => activity.activity_id === overrideActivityId);
  if (override) return { mode: "override", activities: [override] };
  const scheduled = activities.filter((activity) => activity.date === todayKey);
  if (scheduled.length) return { mode: "scheduled", activities: scheduled };
  const unfinished = activities.filter((activity) => !activity.completion?.completed)
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  if (unfinished.length) return { mode: "fallback", activities: [unfinished[0]] };
  return { mode: activities.length ? "all-complete" : "empty", activities: [] };
}

function todayFallbackNotice({ mode, activity, formatDate }) {
  return mode === "fallback"
    ? `Nothing scheduled today, showing next unfinished: ${formatDate(activity.date)} · ${activity.title}`
    : null;
}

function todayEmptyCopy(mode) {
  return mode === "all-complete"
    ? "Nothing scheduled today, and nothing left unfinished."
    : "No activities are scheduled yet. Import a weekly plan to get started.";
}

function localDateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function shouldRerenderForNewDate(lastRenderedDateKey, now = new Date()) {
  return lastRenderedDateKey !== localDateKey(now);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { selectTodaysView, todayFallbackNotice, todayEmptyCopy, localDateKey, shouldRerenderForNewDate };
}
