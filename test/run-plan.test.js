const test = require('node:test');
const assert = require('node:assert/strict');
const { buildRunPlanFromState } = require('../run-plan');
const { normalizeDecisionReview, validateDecisionVersions, decisionReview } = require('../coaching');
const goals = { race_date: '2026-10-25', peak_long_run_target_miles: 13.1, peak_long_run_target_date: '2026-10-04' };
const plan = { goals: ['Easy week'], plan_id: 'week', week_start_date: '2026-09-14', activities: [3,3,4].map((d,i) => ({ activity_id: `run-${i}`, title: `Easy run ${d} miles`, subtasks: [], date: ['2026-09-15','2026-09-17','2026-09-20'][i], type: 'run', target: { distance_miles: d, notes: 'Temporary recovery adjustment' } })) };
test('saved weekly distances win over a historical longest run and reconcile explicit peak goal', () => {
  const state = { goals, plans: [plan], active_plan: plan, health: { actual_workouts: [{ type: 'run', distance_miles: 8, date: '2026-08-01' }] } };
  const before = JSON.stringify(state);
  const result = buildRunPlanFromState(state, '2026-09-16');
  assert.deepEqual(result.weeks[0].planned_distances_miles, [3,3,4]);
  assert.equal(result.weeks[0].target_long_run_miles, 4);
  assert.equal(result.weeks[0].status, 'saved');
  assert.equal(result.weeks[1].status, 'needs_review');
  assert.deepEqual(result.weeks[1].planned_distances_miles, []);
  assert.equal(result.weeks.find(w => w.week_start === '2026-09-28').goal_projection.long_run_miles, 13.1);
  assert.match(result.conflicts.join(' '), /saved long run is 4 miles/);
  assert.equal(JSON.stringify(state), before);
});
test('current week remains authoritative when next week is active; rest-only saved weeks stay empty', () => {
  const next = { plan_id: 'next', week_start_date: '2026-09-21', activities: [{ type: 'rest', date: '2026-09-21' }] };
  const result = buildRunPlanFromState({ goals, plans: [plan,next], active_plan: next }, '2026-09-16');
  assert.equal(result.weeks[0].target_long_run_miles, 4);
  assert.equal(result.weeks[1].target_runs, 0);
  assert.deepEqual(result.weeks[1].planned_distances_miles, []);
});
test('conflicting goal fields and deload prescriptions are explicit', () => {
  const result = buildRunPlanFromState({ goals: { ...goals, run_plan: { peak_long_run_miles: 12 } }, active_plan: plan,
    planning_periods: [{ start_date: '2026-09-14', end_date: '2026-09-20', training_load: 'full_deload' }] }, '2026-09-16');
  assert.match(result.conflicts.join(' '), /Conflicting peak distances/);
  assert.match(result.conflicts.join(' '), /required running conflicts/);
});
test('decision review flags stale and missing applications, and includes future constraints', () => {
  const store = { coach_memories: [{key:'warmup',version:2,text:'Warm up'}, {key:'recovery',version:1,text:'Rest',effective_from:'2026-09-20',expires_at:'2026-09-20'}, {key:'expired',version:1,expires_at:'2026-09-01'}] };
  const reviewed = { ...plan, coaching_review: normalizeDecisionReview({memory_applications:[{key:'warmup',version:1,application:'Added'}]}) };
  assert.throws(() => validateDecisionVersions(reviewed,store), /changed/);
  assert.deepEqual(decisionReview(store,reviewed).memories.map(m => [m.key,m.status]), [['warmup','needs_review'],['recovery','needs_review']]);
  reviewed.coaching_review.memory_applications[0].version=2;
  validateDecisionVersions(reviewed,store);
  assert.equal(decisionReview(store,reviewed).memories[0].status,'applied');
  assert.throws(() => normalizeDecisionReview({memory_applications:[{key:'x',version:1}]}), /Explain/);
});

test('state, planning context, summary and run endpoint share the same plan; decisions survive import', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { once } = require('node:events');
  const { startServer, createDefaultState } = require('../server');
  const old = process.env.COACH_LOOP_DATA_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'coach-continuity-test-'));
  process.env.COACH_LOOP_DATA_DIR=dir;
  const data = createDefaultState();
  data.goals=goals; data.plans=[plan]; data.active_plan_id=plan.plan_id;
  data.coach_memories=[{memory_id:'memory-warmup',key:'warmup',kind:'preference',category:'exercise',version:1,text:'Short warmups'}];
  fs.writeFileSync(path.join(dir,'store.json'),JSON.stringify(data));
  const server=startServer(0); await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const reviewed={...plan,coaching_review:{memory_applications:[{key:'warmup',version:1,application:'Included in run instructions'}],run_plan_review:'Recovery adjustment; peak target still needs review'}};
    const write=await fetch(base+'/api/plans/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(reviewed)});
    assert.equal(write.status,201, write.status !== 201 ? await write.text() : "");
    const stored=await write.json();
    assert.deepEqual(stored.active_plan.coaching_review,normalizeDecisionReview(reviewed.coaching_review));
    const [state,context,summary,run] = await Promise.all(['/api/state','/api/planning-context','/api/coach-summary','/api/run-plan'].map(async url => (await fetch(base+url)).json()));
    assert.deepEqual(state.run_plan,context.run_plan);
    assert.deepEqual(context.run_plan,summary.run_plan);
    assert.deepEqual(summary.run_plan,run.run_plan);
    assert.equal(context.coaching_brief.decision_review.memories[0].status,'applied');
    reviewed.coaching_review.memory_applications[0].version=99;
    const stale=await fetch(base+'/api/plans/import',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(reviewed)});
    assert.equal(stale.status,400);
    const after=await (await fetch(base+'/api/plans/current')).json();
    assert.equal(after.coaching_review.memory_applications[0].version,1);
  } finally {
    await new Promise(resolve=>server.close(resolve));
    if(old===undefined) delete process.env.COACH_LOOP_DATA_DIR; else process.env.COACH_LOOP_DATA_DIR=old;
    fs.rmSync(dir,{recursive:true,force:true});
  }
});
