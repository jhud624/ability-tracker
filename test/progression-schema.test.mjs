import test from "node:test";
import assert from "node:assert/strict";
import { weeklySubtaskSchema } from "../mcp/coach-loop-tools.mjs";

test("progression accepts omitted, valid arrows, null, and non-strings", () => {
  assert.equal(weeklySubtaskSchema.safeParse({ title: "Squat" }).success, true);
  for (const progression of ["up", "hold", "down", null, 1, false]) {
    const parsed = weeklySubtaskSchema.safeParse({ title: "Squat", progression });
    assert.equal(parsed.success, true, `progression ${JSON.stringify(progression)} should pass the tool schema`);
  }
});
