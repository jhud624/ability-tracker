function dateKeyFromDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function addDays(dateKey, days) {
  const date = new Date(`${dateKey}T12:00:00`);
  date.setDate(date.getDate() + days);
  return dateKeyFromDate(date);
}

function todayKey() {
  return new Date().toLocaleDateString("en-CA", { timeZone: process.env.COACH_LOOP_TIME_ZONE || "America/New_York" });
}

function dateDaysApart(start, end) {
  const startDate = new Date(`${start}T12:00:00`);
  const endDate = new Date(`${end}T12:00:00`);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return 0;
  return Math.round((endDate - startDate) / 86400000);
}

function weekKeyForDate(date) {
  const value = new Date(`${date}T12:00:00`);
  const day = value.getDay();
  value.setDate(value.getDate() - ((day + 6) % 7));
  return dateKeyFromDate(value);
}

function planningAdjustmentForWeek(state, weekStart, targetRuns) {
  const weekEnd = addDays(weekStart, 6);
  const periods = (state.planning_periods || state.goals?.planning_periods || [])
    .filter((period) => period.start_date <= weekEnd && period.end_date >= weekStart);
  let fullDeloadDays = 0;
  let reducedDays = 0;
  for (let offset = 0; offset < 7; offset += 1) {
    const date = addDays(weekStart, offset);
    if (periods.some((period) => period.training_load === "full_deload" && period.start_date <= date && period.end_date >= date)) {
      fullDeloadDays += 1;
    } else if (periods.some((period) => period.training_load === "reduced" && period.start_date <= date && period.end_date >= date)) {
      reducedDays += 1;
    }
  }
  const volumeFactor = Math.max(0, (7 - fullDeloadDays - (reducedDays * 0.5)) / 7);
  const adjustedRuns = periods.length ? Math.max(0, Math.round(targetRuns * volumeFactor)) : targetRuns;
  return {
    periods,
    fullDeloadDays,
    reducedDays,
    volumeFactor,
    targetRuns: adjustedRuns,
    trainingLoad: fullDeloadDays ? "full_deload_overlap" : reducedDays ? "reduced" : "normal"
  };
}

function roundDistance(value) {
  return Math.round(Number(value || 0) * 10) / 10;
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
  if (/^\d{4}-\d{2}-\d{2}$/.test(explicit)) return { date: explicit, inferred: false };
  const goalText = [goals.primary, ...(Array.isArray(goals.goals) ? goals.goals : [])].filter(Boolean).join(" ");
  const iso = goalText.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (iso) return { date: iso[1], inferred: true };
  const month = monthFromGoalText(goalText);
  if (month !== null) {
    const now = new Date(`${todayKey()}T12:00:00`);
    const year = month < now.getMonth() ? now.getFullYear() + 1 : now.getFullYear();
    return { date: dateKeyFromDate(new Date(year, month + 1, 0)), inferred: true };
  }
  return { date: addDays(todayKey(), 16 * 7), inferred: true };
}

function runDistancesForWeek(longRunDistance, runCount, raceWeek = false, targetDistance = 13.1) {
  const count = Math.max(1, Number(runCount || 3));
  if (raceWeek) {
    const tuneups = count <= 2 ? [3] : [3, 2];
    return [...tuneups.slice(0, Math.max(0, count - 1)), targetDistance].slice(-count);
  }
  if (count === 1) return [roundDistance(longRunDistance)];
  const easy = Math.max(2, longRunDistance * 0.6);
  if (count === 2) return [roundDistance(easy), roundDistance(longRunDistance)];
  const quality = Math.max(2.5, longRunDistance * 0.72);
  const extras = Array.from({ length: Math.max(0, count - 3) }, () => Math.max(2.5, longRunDistance * 0.5));
  return [easy, quality, ...extras, longRunDistance].map(roundDistance);
}

function buildRunPlanFromState(state = {}, referenceDate = todayKey()) {
  const goals = state.goals || {};
  const runPlan = goals.run_plan || {};
  const runs = (state.health?.actual_workouts || []).filter((actual) => String(actual.type || actual.name || "").toLowerCase().includes("run"));
  const race = raceTargetFromGoals(goals);
  const targetDistance = Number(runPlan.race_distance_miles || goals.race_distance_miles || 13.1);
  const targetRuns = Math.max(1, Number(runPlan.weekly_runs || goals.run_frequency_per_week || 3));
  const currentWeekStart = weekKeyForDate(referenceDate);
  const raceWeekStart = weekKeyForDate(race.date);
  const longestActual = Math.max(0, ...runs.map((run) => Number(run.distance_miles || 0)));
  const plannedRunDistances = (state.active_plan?.activities || [])
    .filter((activity) => activity.type === "run")
    .map((activity) => Number(activity.target?.distance_miles || 0))
    .filter(Boolean);
  const plannedLong = Math.max(0, ...plannedRunDistances);
  const startLong = Number(runPlan.start_long_run_miles || Math.max(3, Math.min(6, longestActual || plannedLong || 3)));
  const peakLong = Number(goals.peak_long_run_target_miles ?? runPlan.peak_long_run_miles ?? Math.max(10, targetDistance - 1.1));
  const peakDate = goals.peak_long_run_target_date || runPlan.peak_long_run_date || addDays(raceWeekStart, -14);
  const cutbackEveryWeeks = Math.max(3, Number(runPlan.cutback_every_weeks || 4));
  const peakIndex = Math.max(0, Math.round(dateDaysApart(currentWeekStart, weekKeyForDate(peakDate)) / 7));
  const conflicts = [];
  if (goals.peak_long_run_target_miles != null && runPlan.peak_long_run_miles != null && Number(goals.peak_long_run_target_miles) !== Number(runPlan.peak_long_run_miles)) conflicts.push("Conflicting peak distances: using the explicit coaching goal; reconcile run-plan settings.");
  if (goals.peak_long_run_target_date && runPlan.peak_long_run_date && goals.peak_long_run_target_date !== runPlan.peak_long_run_date) conflicts.push("Conflicting peak dates: using the explicit coaching goal; reconcile run-plan settings.");
  if (peakDate >= race.date || peakDate < currentWeekStart) conflicts.push("Peak target date is outside the remaining pre-race build; review the goal.");
  const savedPlans = [...(state.plans || []), ...(state.active_plan ? [state.active_plan] : [])];
  const weeks = [];
  let weekStart = currentWeekStart;
  let index = 0;
  let postDeloadWeeks = 0;
  while (weekStart <= raceWeekStart && weeks.length < 32) {
    const weeksToRace = Math.max(0, Math.round(dateDaysApart(weekStart, raceWeekStart) / 7));
    const isRaceWeek = weekStart === raceWeekStart;
    let longRun = targetDistance;
    if (!isRaceWeek && weekStart > weekKeyForDate(peakDate)) longRun = Math.max(6, peakLong * 0.65);
    else if (!isRaceWeek && weekStart === weekKeyForDate(peakDate)) longRun = peakLong;
    else if (!isRaceWeek) {
      const progress = peakIndex ? Math.min(1, index / peakIndex) : 1;
      longRun = startLong + (peakLong - startLong) * progress;
      if (index > 0 && index % cutbackEveryWeeks === cutbackEveryWeeks - 1) longRun *= 0.86;
    }
    const planning = planningAdjustmentForWeek(state, weekStart, targetRuns);
    if (planning.fullDeloadDays) postDeloadWeeks = 2;
    else if (postDeloadWeeks > 0) {
      planning.volumeFactor *= postDeloadWeeks === 2 ? 0.75 : 0.9;
      planning.targetRuns = Math.max(1, Math.round(targetRuns * planning.volumeFactor));
      planning.trainingLoad = "post_deload_return";
      postDeloadWeeks -= 1;
    }
    longRun = planning.targetRuns ? roundDistance(longRun * planning.volumeFactor) : 0;
    let distances = planning.targetRuns ? runDistancesForWeek(longRun, planning.targetRuns, isRaceWeek, targetDistance) : [];
    const saved = savedPlans.filter(p => p.week_start_date === weekStart).at(-1);
    const savedRuns = saved ? (saved.activities || []).filter(a => a.type === "run").sort((a,b) => a.date.localeCompare(b.date)) : [];
    const projectedLong = longRun;
    if (saved) {
      distances = savedRuns.map(a => Number(a.target?.distance_miles || 0));
      longRun = Math.max(0, ...distances);
      if (savedRuns.some(a => !Number.isFinite(Number(a.target?.distance_miles)) || Number(a.target?.distance_miles) <= 0)) conflicts.push(`${weekStart}: a saved run has no distance target; review its time-based prescription.`);
      if (Math.abs(projectedLong - longRun) > 0.1) conflicts.push(`${weekStart}: saved long run is ${longRun} miles; the goal projection was ${projectedLong} miles. Reconcile the remaining build and peak target.`);
      if (savedRuns.some(a => (state.planning_periods || []).some(p => p.training_load === "full_deload" && a.date >= p.start_date && a.date <= p.end_date) && a.required_or_optional !== "optional")) conflicts.push(`${weekStart}: required running conflicts with a full deload.`);
    }
    const actualRuns = runs.filter((run) => run.date >= weekStart && run.date <= addDays(weekStart, 6));
    weeks.push({
      week_start: weekStart,
      week_end: addDays(weekStart, 6),
      target_runs: saved ? savedRuns.length : planning.targetRuns,
      status: saved ? "saved" : "provisional",
      plan_id: saved?.plan_id || null,
      rationale: savedRuns.map(a => a.target?.notes).filter(Boolean),
      planned_distances_miles: distances,
      target_weekly_miles: roundDistance(distances.reduce((sum, distance) => sum + distance, 0)),
      target_long_run_miles: longRun,
      training_load: planning.trainingLoad,
      full_deload_days: planning.fullDeloadDays,
      reduced_training_days: planning.reducedDays,
      planning_periods: planning.periods,
      actual_runs: actualRuns.length,
      actual_miles: roundDistance(actualRuns.reduce((sum, run) => sum + Number(run.distance_miles || 0), 0)),
      weeks_to_race: weeksToRace,
      is_race_week: isRaceWeek
    });
    weekStart = addDays(weekStart, 7);
    index += 1;
  }
  // Never display an unreconciled goal projection as a next workout.
  if (conflicts.length) {
    for (const week of weeks.filter(w => w.status === "provisional")) {
      week.status = "needs_review";
      week.goal_projection = { distances_miles: week.planned_distances_miles, long_run_miles: week.target_long_run_miles };
      week.planned_distances_miles = [];
      week.target_long_run_miles = null;
      week.target_weekly_miles = null;
    }
  }
  return {
    race,
    conflicts,
    guidance: "Saved weeks are authoritative. Future projections are provisional, not workout prescriptions. Reconcile recovery changes with the peak target before approving another week.",
    assumptions: {
      weekly_runs: targetRuns,
      race_distance_miles: targetDistance,
      start_long_run_miles: startLong,
      peak_long_run_miles: peakLong,
      peak_long_run_date: peakDate,
      cutback_every_weeks: cutbackEveryWeeks
    },
    weeks
  };
}


module.exports = { buildRunPlanFromState };
