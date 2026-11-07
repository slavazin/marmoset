// Wall-clock budgets of repairer runs (D-0026). Every Muse run gets MAX_STEPS steps (loop/gate.ts) and a wall of
// MAX_STEPS × SECONDS_PER_STEP, so the step cap, not the wall, ends a run that keeps working. loop/fast.ts uses
// ATTEMPT_WALL_S; loop/trial.ts, loop/vread.ts and loop/muse-native.ts use TRIAL_WALL_S, one value for every arm.

import { MAX_STEPS } from "./gate.ts";

/**
 * Seconds per Muse model step: ATT-0001's wall rate (2026-11-07, 600 s / 40 steps), not its model time of about
 * 13.5 s per call as the orchestrator read it, so the wall does not bind before the step cap (D-0026).
 */
export const SECONDS_PER_STEP = 15;
/** Wall-clock budget of one fast-loop attempt, in seconds: MAX_STEPS × SECONDS_PER_STEP, rounded up. */
export const ATTEMPT_WALL_S = Math.ceil(MAX_STEPS * SECONDS_PER_STEP);
/** Wall-clock budget of one trial or V-read arm's family-run, in seconds; every arm gets the same: ATTEMPT_WALL_S. */
export const TRIAL_WALL_S = ATTEMPT_WALL_S;
