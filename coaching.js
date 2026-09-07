const { createHash } = require('node:crypto');

const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const round = value => Math.round(value * 10) / 10;
const isStrength = activity => /strength|lift|functional|traditional/i.test(activity.type);

function activeMemories(store, date = new Date().toISOString().slice(0, 10)) {
  return (store.coach_memories || []).filter(m => (!m.effective_from || m.effective_from <= date) && (!m.expires_at || m.expires_at >= date));
}

function normalizeBlocks(activity) {
  if (activity.blocks === undefined) return [];
  if (!Array.isArray(activity.blocks)) throw new Error('blocks must be an array');
  const ids = new Set((activity.subtasks || []).map(s => s.subtask_id));
  const used = new Set();
  const blockIds = new Set();
  return activity.blocks.map(b => {
    if (!b.block_id || blockIds.has(b.block_id)) throw new Error('Each block needs a unique block_id');
    blockIds.add(b.block_id);
    if (b.mode !== 'alternating_sets') throw new Error('Block mode must be alternating_sets');
    for (const id of [b.primary_subtask_id, b.active_rest_subtask_id]) {
      if (!ids.has(id) || used.has(id)) throw new Error('Each block must reference two distinct, unshared movement subtasks');
      used.add(id);
    }
    if (!Number.isInteger(b.rounds) || b.rounds < 2 || b.rounds > 20) throw new Error('Block rounds must be an integer from 2 to 20');
    const rest = b.additional_rest_seconds ?? 0;
    if (!Number.isFinite(rest) || rest < 0 || rest > 600) throw new Error('additional_rest_seconds must be between 0 and 600');
    if (b.active_rest_between_rounds_only !== undefined && typeof b.active_rest_between_rounds_only !== 'boolean') throw new Error('active_rest_between_rounds_only must be boolean');
    return { block_id: String(b.block_id), mode: b.mode, rounds: b.rounds,
      primary_subtask_id: b.primary_subtask_id, active_rest_subtask_id: b.active_rest_subtask_id,
      active_rest_between_rounds_only: b.active_rest_between_rounds_only !== false,
      additional_rest_seconds: rest };
  });
}

function preferenceIssues(activity, store) {
  const applicable = activeMemories(store, activity.date).filter(m => m.rule?.sequence === 'alternate_sets' && isStrength(activity));
  return applicable.flatMap(m => {
    const receipt = (activity.preference_applications || []).find(r => r.key === m.key);
    if (!receipt || receipt.version !== (m.version || 1)) return [`${m.key}: review the current preference version ${m.version || 1}`];
    if (receipt.exception_reason?.trim()) return [];
    if (!(activity.blocks || []).length) return [`${m.key}: include alternating-set blocks or an explicit session exception`];
    if (/do not alternate|after all .*sets|complete .*sets before|finish (?:all|each).*before/i.test([activity.target?.notes, activity.notes, ...activity.subtasks.map(s => s.title)].filter(Boolean).join(' '))) {
      return [`${m.key}: remove instructions that contradict alternating individual sets`];
    }
    return [];
  });
}

function validatePreferences(activities, store) {
  for (const activity of activities) {
    // A preference change must never invalidate completed historical work.
    if (store.completions?.[activity.activity_id]?.completed || (store.health?.actual_workouts || []).some(a => store.actual_links?.[a.actual_id] === activity.activity_id)) continue;
    const issues = preferenceIssues(activity, store);
    if (issues.length) throw new Error(`${activity.title}: ${issues.join('; ')}`);
  }
}

function prescriptionKey(activity) {
  // Preserve numeric prescriptions. Never pool different volumes just because
  // they share a generic strength label. Ignore IDs that change every week.
  const names = new Map((activity.subtasks || []).map(s => [s.subtask_id, s.title.toLowerCase().trim()]));
  const value = {
    type: activity.type,
    intensity: activity.target?.intensity || '',
    movements: [...names.values()],
    blocks: (activity.blocks || []).map(b => ({ ...b, block_id: undefined,
      primary_subtask_id: names.get(b.primary_subtask_id), active_rest_subtask_id: names.get(b.active_rest_subtask_id) }))
  };
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
}

function snapshotForecasts(store, activities) {
  const snapshots = [...(store.duration_forecasts || [])];
  for (const a of activities) {
    const estimate = a.target?.estimated_duration_minutes ?? a.target?.duration_minutes;
    if (!positive(estimate)) continue;
    const key = prescriptionKey(a);
    const prior = snapshots.filter(s => s.activity_id === a.activity_id).at(-1);
    if (prior?.prescription_key === key && prior.estimated_minutes === Number(estimate)) continue;
    snapshots.push({ activity_id: a.activity_id, prescription_key: key, estimated_minutes: Number(estimate),
      captured_at: new Date().toISOString(), revision: (prior?.revision || 0) + 1 });
  }
  return snapshots;
}

function timingObservation(activity, store, actuals) {
  const feedback = store.feedback?.[activity.activity_id] || {};
  const forecasts = (store.duration_forecasts || []).filter(f => f.activity_id === activity.activity_id);
  const forecast = forecasts.at(-1);
  const manual = positive(feedback.actual_duration_minutes);
  const actual = actuals.length === 1 ? actuals[0] : null;
  const minutes = manual ? Number(feedback.actual_duration_minutes) : actual && positive(actual.duration_minutes) ? Number(actual.duration_minutes) : null;
  let reason = null;
  if (!minutes) reason = 'Add or link a session duration';
  else if (feedback.timing_status !== 'complete') reason = feedback.timing_status === 'exclude' ? 'Excluded: interrupted, partial, or changed workout' : 'Confirm the full prescribed session was completed';
  else if (!manual && (!actual || (actual.natural_match_multiple && !actual.linked))) reason = 'Confirm duration manually or resolve ambiguous workout matches';
  else if (!forecast) reason = 'No original forecast snapshot; history only';
  else if (forecast.prescription_key !== prescriptionKey(activity)) reason = 'Prescription changed since the forecast';
  else if (manual ? forecast.captured_at.slice(0, 10) >= activity.date : (!Number.isFinite(Date.parse(actual.start_date)) || Date.parse(forecast.captured_at) >= Date.parse(actual.start_date))) reason = 'Forecast was recorded after training began';
  const estimate = forecast?.estimated_minutes ?? activity.target?.estimated_duration_minutes ?? activity.target?.duration_minutes;
  return { activity_id: activity.activity_id, date: activity.date, prescription_key: prescriptionKey(activity),
    actual_id: manual ? null : actual?.actual_id || null, actual_minutes: minutes ? round(minutes) : null,
    estimated_minutes: positive(estimate) ? Number(estimate) : null,
    error_minutes: minutes && positive(estimate) ? round(Number(estimate) - minutes) : null,
    eligible: !reason, reason, source: manual ? 'reported' : 'health', forecast_revision: forecast?.revision || null };
}

function timingContext(store, matchActuals) {
  const activities = (store.plans || []).flatMap(p => p.activities || []);
  const observations = activities.filter(isStrength).map(a => timingObservation(a, store, matchActuals(a, store)));
  const counts = new Map();
  observations.forEach(o => { if (o.actual_id) counts.set(o.actual_id, (counts.get(o.actual_id) || 0) + 1); });
  observations.forEach(o => {
    if (o.actual_id && counts.get(o.actual_id) > 1) { o.eligible = false; o.reason = 'Actual appears on multiple sessions'; }
  });
  return { observations, guidance: [
    'Separate available time (time_budget_minutes) from the forecast (estimated_duration_minutes).',
    'Use only eligible comparable completed sessions for calibration. Do not halve unrelated workout estimates.',
    'Active rest replaces passive rest: count primary work, active rest, transitions and additional rest once each.',
    'Use spare time deliberately for goal-relevant work when effort and recovery support it; never add volume solely to fill an old estimate.'
  ] };
}

function estimateDuration(activity, observations) {
  const samples = observations.filter(o => o.eligible && o.activity_id !== activity.activity_id && o.date < activity.date && o.prescription_key === prescriptionKey(activity))
    .sort((a, b) => a.date.localeCompare(b.date)).slice(-8);
  const values = samples.map(o => o.actual_minutes);
  const original = activity.target?.estimated_duration_minutes ?? activity.target?.duration_minutes ?? null;
  // Remain advisory: keep the accepted forecast immutable; never rewrite dose.
  return { estimated_minutes: values.length >= 3 ? round(median(values)) : original,
    sample_count: values.length, confidence: values.length >= 3 ? 'personalized' : 'provisional',
    range_minutes: values.length >= 3 ? [Math.floor(Math.min(...values)), Math.ceil(Math.max(...values))] : null,
    mean_error_minutes: values.length ? round(samples.reduce((sum, s) => sum + s.error_minutes, 0) / values.length) : null };
}

module.exports = { activeMemories, normalizeBlocks, preferenceIssues, validatePreferences, prescriptionKey, snapshotForecasts, timingObservation, timingContext, estimateDuration };
