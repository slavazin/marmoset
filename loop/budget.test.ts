import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_STEPS } from "./gate.ts";
import { ATTEMPT_WALL_S, SECONDS_PER_STEP, TRIAL_WALL_S } from "./budget.ts";
import * as fast from "./fast.ts";
import * as trial from "./trial.ts";

test("the trial and V-read arm wall is MAX_STEPS × SECONDS_PER_STEP like the fast attempt's, so the step cap binds on every arm (D-0026)", () => {
  assert.equal(ATTEMPT_WALL_S, Math.ceil(MAX_STEPS * SECONDS_PER_STEP));
  assert.equal(TRIAL_WALL_S, ATTEMPT_WALL_S);
  // the old import sites read the same values
  assert.equal(fast.ATTEMPT_WALL_S, ATTEMPT_WALL_S);
  assert.equal(trial.TRIAL_WALL_S, TRIAL_WALL_S);
});
