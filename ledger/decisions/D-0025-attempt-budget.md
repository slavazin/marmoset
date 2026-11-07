---
id: D-0025
title: Each attempt is told its step and wall budget and to edit by half of it, and its wall follows MAX_STEPS
status: admitted
supersedes: null
---
**Decision:** before the run opens:
- `TASK_TEXT` (`loop/projection.ts`) gains one sentence, filled per task by `taskText(budget)`: the repairer gets its step cap and wall, is told that an empty diff is refused, and is told to make its first `core/` edit by half of each.
- `ATTEMPT_WALL_S` (`loop/fast.ts`) is `ceil(MAX_STEPS × SECONDS_PER_STEP)`, with `SECONDS_PER_STEP = 15`, ATT-0001's wall rate (600 s / 40 steps).
- `MAX_STEPS = 90` (`loop/gate.ts`, set by the orchestrator before the run opens), so `ATTEMPT_WALL_S` is 1350 s and the first edit is due by step 45 (675 s).
- `CAMPAIGN_PARALLEL = 3`, the S8 Wiggle maximum. Repairs run in parallel; the gate step runs one at a time.

**Not this:**
- Keeping the 600 s wall with 60 steps. The wall cut ATT-0001 at step 40, so a third of the step cap could never be spent.
- Lowering `MAX_STEPS` to save spend. Budget no longer binds (owner reading below), and a smaller cap leaves less room to reach an edit.
- Running gate steps concurrently. Every gate step adds a worktree to the one live clone and merges into `core-live` there.

**Warrant:**
- ATT-0001 on INC-0001 (2026-11-07) made 40 Muse calls in its 600 s wall, at about 13.5 s per call as the orchestrator read it. It wrote no edit, and the gate refused its empty diff at diff-scope.
- Arithmetic for the proposal:
  - At 60 steps: 60 × 13.5 = 810 s.
  - At 90 steps: 90 × 13.5 = 1215 s, about 20 min. Half of that is step 45, at 607 s. ATT-0001 had already spent 40 steps investigating, so step 45 leaves it room to reach an edit.
  - At `CAMPAIGN_PARALLEL = 3`, the 14:30–15:45 window (75 min) holds about 3 × 75 / 20 ≈ 11 attempts, against `MAX_ATTEMPTS = 2` per incident.
- Owner reading from the Meta console, about 12:50 on 2026-11-07: about $5 in total. By PRICES the same calls come to over $90. Spend is therefore not the binding constraint.
- False if: at the proposed budget, the median attempt still ends with an empty diff, or the wall still binds before the step cap.

**Revisit when:** {when: "the first 3 attempts of RUN-0001 read", then: "if 2 of them refuse with an empty diff, cut the packet (S8 Wiggle); if the wall binds first, re-read SECONDS_PER_STEP from their spent.wall_s / spent.steps"}

**Residue:**
- Admitted 2026-11-07 by the orchestrator with one change: `SECONDS_PER_STEP` is the wall rate 15, not the model rate 13.5, so the wall does not bind at 90% of the step cap.
- A repair is judged against its own base commit. Under parallel attempts, a second GRADUATE can merge onto a `core-live` that moved after its base, so its checks did not read the merged head.
