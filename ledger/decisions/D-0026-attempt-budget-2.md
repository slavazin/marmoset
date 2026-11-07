---
id: D-0026
title: Every repairer run is told its step and wall budget and to edit by half of it, and every wall, fast or trial, follows MAX_STEPS
status: admitted
supersedes: D-0025
---
**Decision:** before the run opens:
- `TASK_TEXT` (`loop/projection.ts`) carries one sentence, filled per task by `taskText(budget)`: the repairer gets its step cap and wall, is told that an empty diff is refused, and is told to make its first `core/` edit by half of each.
- `SECONDS_PER_STEP = 15` (`loop/budget.ts`), ATT-0001's wall rate (600 s / 40 steps).
- `ATTEMPT_WALL_S` and `TRIAL_WALL_S` (`loop/budget.ts`) are both `ceil(MAX_STEPS × SECONDS_PER_STEP)`. Fast attempts, shadow-trial arms, muse-native arms and V-read arms get the same wall, so every arm of a trial or of the V read has an equal budget (`loop/budget.test.ts`).
- `MAX_STEPS = 90` (`loop/gate.ts`, set by the orchestrator before the run opens), so every wall is 1350 s and the first edit is due by step 45 (675 s).
- `CAMPAIGN_PARALLEL = 3` (`loop/campaign.ts`), the S8 Wiggle maximum. Repairs run in parallel. The gate step runs one at a time under one mutex, and a candidate whose base `core-live` moved past is rebased onto the head and judged there (`loop/gate-repair.ts`, `gate.test.ts` "two attempts from one base").

**Not this:**
- Keeping the 600 s wall with 60 steps. The wall cut ATT-0001 at step 40, so a third of the step cap could never be spent.
- Keeping `TRIAL_WALL_S = 900` beside a 90-step cap. Trial and V-read arms would hit the wall near step 60, which is the failure this decision removes from fast attempts.
- Lowering `MAX_STEPS` to save spend. Budget does not bind (owner reading below), and a smaller cap leaves less room to reach an edit.
- Running gate steps concurrently. Every gate step adds a worktree to the one live clone and merges into `core-live` there.

**Warrant:**
- ATT-0001 on INC-0001 (2026-11-07) made 40 Muse calls in its 600 s wall, at about 13.5 s per call as the orchestrator read it. It wrote no edit, and the gate refused its empty diff at diff-scope.
- Arithmetic at the admitted figures:
  - Wall: 90 steps × 15 s = 1350 s, 22.5 min. Half is step 45, at 675 s.
  - At `CAMPAIGN_PARALLEL = 3`, the 14:30–15:45 window (75 min) holds about 3 × 75 / 22.5 ≈ 10 attempts, against `MAX_ATTEMPTS = 2` per incident.
- Owner reading from the Meta console, about 12:50 on 2026-11-07: about $5 in total. By PRICES the same calls come to over $90. Spend is therefore not the binding constraint.
- False if: at this budget, the median attempt still ends with an empty diff, or the wall still binds before the step cap.

**Revisit when:** {when: "the first 3 attempts of RUN-0001 read", then: "check their spent.wall_s / spent.steps: if 2 of them refuse with an empty diff, cut the packet (S8 Wiggle); if the wall binds first, re-derive SECONDS_PER_STEP from those readings"}

**Residue:**
- `SECONDS_PER_STEP` is one Muse run's rate (ATT-0001). A slower model step under load makes the wall bind before the step cap.
- D-0025's residue on stale bases under parallel attempts is closed by commit 376d515: a GRADUATE whose `task.base_commit` is behind `core-live` is rebased and re-judged on the head, or refused at `merge` with `base_moved {from, onto}`.
