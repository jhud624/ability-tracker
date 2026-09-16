# Coaching continuity

Coach Loop is the durable source for coaching decisions. A conversation only changes this source when it calls a save tool successfully. ChatGPT's general memory is not a substitute for an application save.

## Daily coaching

1. Read planning context and existing memories before editing preferences.
2. Save explicit durable preferences using `upsert_coaching_memories`. Include the user's source wording and an event identifier. Reuse stable keys and provide `expected_version` for corrections. Keep temporary constraints date-bounded; keep one-workout requests in `update_day_plan` or activity feedback.
3. Inspect the write receipt. `verified` means the write was read back. `changed_after_save` means another edit intervened. `saved_verification_pending` means the write succeeded but the verification read failed. The latter two require a fresh read, not blindly repeating the write.
4. Report storage warnings separately: primary data may have saved even if automatic backup creation failed.

After deployment, refresh the developer-mode Coach Loop connection in ChatGPT and verify that memory tools, day-plan editing, and `get_run_plan` are listed. Start a fresh conversation to exercise the refreshed schemas. If tools are missing, say exactly which decision remains unsaved; do not replace all freeform notes as an implicit fallback.

## Weekly coaching

Read fresh planning context, including legacy notes, structured memories, the decision review, and `run_plan`. Review memories effective on any target-week activity date. An old target-week plan with missing or stale applications is not fully reviewed.

Include this record in an imported plan:

```json
{
  "coaching_review": {
    "memory_applications": [
      { "key": "short-warmups", "version": 1, "application": "Included in each substantive session" }
    ],
    "run_plan_review": "Describe changes from the saved progression, the recovery evidence, and effects on the peak target. Name any unresolved decision."
  }
}
```

Use `exception_reason` instead of `application` where appropriate. Stale supplied versions reject the import. Legacy imports remain compatible but missing decisions are shown as needing review. A coach's application record is not automatic proof that every workout follows the preference; exercise-level validation still applies.

Read the imported plan back. Summarize new coaching decisions used, preferences applied or excepted, and unresolved conflicts. Do not automatically change race goals or turn uncertain observations into permanent preferences.

## Running schedule

`run-plan.js` is the only progression calculator, exposed by authenticated `/api/run-plan`, `/api/state`, `/api/planning-context`, and `/api/coach-summary`. The browser and MCP consume that result. Saved weekly plans override projections, including when a future week is active. No workout prescriptions or goals are migrated by this release.

The explicit `peak_long_run_target_miles` and `peak_long_run_target_date` goals take precedence over legacy nested run-plan settings; contradictory settings are flagged. Unapproved future rows are provisional. When there is a conflict, future prescriptions are withheld as `needs_review`; an arithmetic `goal_projection` remains available for coach comparison only. Projections are not readiness assessments or recommendations to increase training.

Week boundaries default to America/New_York; deployments can set `COACH_LOOP_TIME_ZONE`.
