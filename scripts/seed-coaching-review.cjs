// Seed an explicitly selected review environment with synthetic examples only.
// Never point this at production. The caller must provide an isolated store.
const base = process.env.COACH_REVIEW_URL;
if (!base) throw new Error('COACH_REVIEW_URL is required');
const headers = { 'content-type': 'application/json', ...(process.env.COACH_REVIEW_TOKEN ? { authorization: `Bearer ${process.env.COACH_REVIEW_TOKEN}` } : {}) };
async function send(path, body) {
  const response = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
(async () => {
  const key = 'strength-active-rest-sequencing';
  const saved = await send('/api/coach-memories/upsert', { coach_memories: [{ key, kind: 'preference', category: 'exercise', text: 'Alternate individual work sets with active rest using another muscle group: curls with ATG lunges, or pull-ups with bird dogs.', rule: { sequence: 'alternate_sets' }, source_quote: 'I really like to have active rest using another muscle group between sets.', source_event_id: 'review-example' }] });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const monday = new Date(`${today}T12:00:00Z`); monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  const activity = { activity_id: `review-${today}-active-rest`, date: today, title: 'Review example · Arms with active rest', type: 'strength', required_or_optional: 'optional', target: { estimated_duration_minutes: 30, time_budget_minutes: 40, notes: 'Sample workout for reviewing the app. Alternate individual sets in each pair.' }, equipment: [], references: [], subtasks: [
    { subtask_id: 'review-curls', title: 'Biceps curls · 3 sets', log_mode: 'strength' },
    { subtask_id: 'review-atg', title: 'ATG lunges · 2 active-rest bouts', log_mode: 'strength' },
    { subtask_id: 'review-pullups', title: 'Pull-ups · 3 sets', log_mode: 'strength' },
    { subtask_id: 'review-birddogs', title: 'Bird dogs · 2 active-rest bouts', log_mode: 'strength' }
  ], blocks: [
    { block_id: 'review-pair-1', mode: 'alternating_sets', rounds: 3, primary_subtask_id: 'review-curls', active_rest_subtask_id: 'review-atg' },
    { block_id: 'review-pair-2', mode: 'alternating_sets', rounds: 3, primary_subtask_id: 'review-pullups', active_rest_subtask_id: 'review-birddogs' }
  ], preference_applications: [{ key, version: saved.saved[0].version }] };
  await send('/api/plans/import', { plan_id: `review-${monday.toISOString().slice(0, 10)}`, week_start_date: monday.toISOString().slice(0, 10), goals: ['Review example only: see paired sets and personalized coaching controls'], activities: [activity] });
  await send(`/api/activities/${activity.activity_id}/feedback`, { actual_duration_minutes: 29.9, timing_status: 'exclude', notes: 'Synthetic review example; excluded from learning.' });
  console.log('Seeded isolated review example. No production data copied.');
})();
