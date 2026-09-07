const test = require('node:test');
const assert = require('node:assert/strict');
const { activeMemories, normalizeBlocks, validatePreferences, prescriptionKey, snapshotForecasts, timingObservation, estimateDuration } = require('../coaching');
const activity = () => ({ activity_id: 'a', type: 'strength', date: '2026-09-07', title: 'Arms', target: { duration_minutes: 35 }, subtasks: [{ subtask_id: 'curl', title: 'Curl 3x12' }, { subtask_id: 'atg', title: 'ATG 2x5' }], blocks: [{ block_id: 'pair', mode: 'alternating_sets', primary_subtask_id: 'curl', active_rest_subtask_id: 'atg', rounds: 3, active_rest_between_rounds_only: true, additional_rest_seconds: 0 }], preference_applications: [{ key: 'active-rest', version: 2 }] });
const memory = { key: 'active-rest', version: 2, rule: { sequence: 'alternate_sets' } };

test('active-rest blocks reference independent exercises and validate current preferences', () => {
  const a = activity();
  assert.equal(normalizeBlocks(a)[0].rounds, 3);
  assert.throws(() => normalizeBlocks({ ...a, blocks: [{ ...a.blocks[0], active_rest_subtask_id: 'curl' }] }), /distinct/);
  assert.throws(() => normalizeBlocks({ ...a, blocks: [{ ...a.blocks[0], rounds: 1 }] }), /rounds/);
  validatePreferences([a], { coach_memories: [memory] });
  assert.throws(() => validatePreferences([{ ...a, blocks: [] }], { coach_memories: [memory] }), /alternating-set/);
  assert.throws(() => validatePreferences([{ ...a, preference_applications: [{ key: 'active-rest', version: 1 }] }], { coach_memories: [memory] }), /version 2/);
  assert.throws(() => validatePreferences([{ ...a, target: { notes: 'Do not alternate individual sets' } }], { coach_memories: [memory] }), /contradict/);
  validatePreferences([{ ...a, blocks: [], preference_applications: [{ key: 'active-rest', version: 2, exception_reason: 'Temporary recovery restriction' }] }], { coach_memories: [memory] });
  assert.equal(activeMemories({ coach_memories: [{ ...memory, expires_at: '2026-09-06' }] }, '2026-09-07').length, 0);
});

test('duration calibration excludes unconfirmed and retrospective records and preserves original snapshots', () => {
  const a = activity();
  const store = { duration_forecasts: [{ activity_id: 'a', prescription_key: prescriptionKey(a), estimated_minutes: 35, captured_at: '2026-09-06T10:00:00Z', revision: 1 }], feedback: { a: { timing_status: 'complete' } } };
  const actual = { actual_id: 'watch', duration_minutes: 29.88, start_date: '2026-09-07T10:00:00Z' };
  const o = timingObservation(a, store, [actual]);
  assert.equal(o.eligible, true);
  assert.equal(o.error_minutes, 5.1);
  assert.equal(timingObservation(a, { ...store, feedback: {} }, [actual]).eligible, false);
  assert.equal(timingObservation(a, store, [{ ...actual, natural_match_multiple: true }]).eligible, false);
  assert.equal(timingObservation(a, store, [actual, actual]).eligible, false);
  assert.equal(timingObservation(a, { ...store, duration_forecasts: [] }, [actual]).eligible, false);
  assert.equal(timingObservation(a, store, [{ ...actual, start_date: '2026-09-01T10:00:00Z' }]).eligible, false);
  const changed = { ...a, target: { duration_minutes: 30 } };
  const snapshots = snapshotForecasts(store, [changed]);
  assert.equal(snapshots[0].estimated_minutes, 35);
  assert.equal(snapshots[1].estimated_minutes, 30);
  assert.equal(snapshotForecasts({ ...store, duration_forecasts: snapshots }, [changed]).length, 2);
});

test('personal forecast uses only previous identical prescriptions, without changing dose or budget', () => {
  const a = activity();
  a.target.time_budget_minutes = 40;
  const observations = [28, 30, 31].map((minutes, i) => ({ eligible: true, activity_id: `old-${i}`, date: `2026-09-0${i + 1}`, prescription_key: prescriptionKey(a), actual_minutes: minutes, error_minutes: 35 - minutes }));
  const before = JSON.stringify(a);
  assert.equal(estimateDuration(a, observations).estimated_minutes, 30);
  assert.equal(estimateDuration(a, observations.slice(0, 2)).confidence, 'provisional');
  assert.equal(estimateDuration(a, observations.map(o => ({ ...o, date: '2026-10-01' }))).sample_count, 0);
  assert.equal(JSON.stringify(a), before);
  assert.notEqual(prescriptionKey(a), prescriptionKey({ ...a, subtasks: [{ subtask_id: 'curl', title: 'Curl 5x12' }] }));
});

test('daily feedback persists versioned preferences atomically and rejects stale writes', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const old = process.env.COACH_LOOP_DATA_DIR;
  const dir = fs.mkdtempSync(`${os.tmpdir()}/coach-learning-test-`);
  process.env.COACH_LOOP_DATA_DIR = dir;
  const { startServer } = require('../server');
  const server = startServer(0);
  await new Promise(resolve => server.listening ? resolve() : server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, body) {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(process.env.COACH_LOOP_API_TOKEN ? { authorization: `Bearer ${process.env.COACH_LOOP_API_TOKEN}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() };
  }
  try {
    const state = (await request('/api/state')).data;
    const id = state.active_plan.activities[0].activity_id;
    const m = { key: 'active-rest', kind: 'preference', category: 'exercise', text: 'Alternate sets with active rest', source_quote: 'I like active rest between sets', rule: { sequence: 'alternate_sets' } };
    assert.equal((await request(`/api/activities/${id}/feedback`, { notes: 'Great session', coach_memories: [m] })).status, 200);
    let context = (await request('/api/planning-context')).data;
    assert.equal(context.coaching_brief.active_preferences[0].version, 1);
    assert.equal(context.coach_memories[0].source_quote, m.source_quote);
    assert.equal((await request('/api/coach-memories/upsert', { coach_memories: [m] })).data.saved[0].version, 1);
    const correction = { ...m, text: 'Use bird dogs between pull-up sets', expected_version: 1 };
    assert.equal((await request('/api/coach-memories/upsert', { coach_memories: [correction] })).data.saved[0].version, 2);
    assert.equal((await request(`/api/activities/${id}/feedback`, { notes: 'Must not save', coach_memories: [correction] })).status, 400);
    const after = (await request('/api/state')).data;
    assert.equal(after.feedback[id].notes, 'Great session');
    assert.equal(after.coach_memories[0].history[0].text, m.text);
    assert.equal((await request(`/api/activities/${id}/feedback`, { difficulty: 7 })).data.feedback[id].notes, 'Great session');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (old === undefined) delete process.env.COACH_LOOP_DATA_DIR; else process.env.COACH_LOOP_DATA_DIR = old;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
