---
id: D-draft-concurrent-cgb-run
title: RUN-0002 takes its incidents from the CGB T families, judges on splits.json and splits-cgb.json together, and keeps its own ledger and per-run directories beside RUN-0001
status: draft
supersedes: null
---
**Decision:** RUN-0002, the CGB tier of D-0019, opens with `loop/campaign.ts --run RUN-0002 --source cgb-suite --rules-as RUN-0001 --s0-commit f4650f1` and these conditions, which `runs/RUN-0002/conditions.json` declares and `loop/run-conditions.ts` checks at open and at `--resume`:
- Incidents: `cgbSuitePlay` opens one suite incident per failing ROM of `cgb:mealybug:palette-scroll-bg`, the CGB T family of `splits-cgb.json`, scored on a core created with `{ model: "CGB" }` against its RGB reference (`lockstep/suite.ts`, `lockstep/lockstep.test.ts` "CGB suite incident"). It opens one only while fewer than `CGB_QUEUE_DEPTH` incidents are open (`loop/campaign-cgb.test.ts` "cgb-suite play").
- Splits: `RATCHET_SPLITS=splits.json,splits-cgb.json`, merged by `suites/splits.ts` `loadSplits()`. The gate's base and H-no-regress checks read DMG and CGB families together, and shadow trials repair `TRIAL_FAMILIES` (DMG H families) on the CGB core, so the rule constants and `rule_version` are RUN-0001's (8e27c0f753ca).
- Core: `RATCHET_LIVE=../ratchet-live-cgb`, `RATCHET_LIVE_BRANCH=core-cgb`, S0 core commit f4650f1. This commit is not RUN-0001's S0 core (dcc327c), by design (D-0019).
- Ledger and per-run directories: a ledger, skills, evidence, traces, cache, scratch root, subq-cache and telemetry under `runs/RUN-0002/` of the main checkout or `~/.cache/ratchet-run2`, none of them RUN-0001's (`isolationClashes`). Its SSE server is a port nothing listens on.
- Spend: the guard reads `server/spend.ts` `combinedMeter` over RUN-0002 and RUN-0001 (`--spend-also`), and the RUN-0001 part includes `runs/RUN-0001/muse-native.jsonl` (`server/spend.test.ts` "combined meter").

**Not this:**
- Playing game/game.gb on the CGB core. game.gb is a DMG game, and `lockstep/` compares DMG shades only, so play on CGB opens no CGB incident.
- Sharing `ledger/` with RUN-0001. RUN-0001's process runs code that reads every incident in its ledger: `loop/fast.ts` `openIncidents`, `loop/slow.ts` `generationsDue` and `loop/gate-repair.ts` `recheckIncidents` filter on no run. RUN-0002's CGB incidents would then enter RUN-0001's queue on the DMG core and its K count.
- Changing `TRIAL_FAMILIES` to the CGB H families. That changes `rule_version` and breaks the owner's same-rules requirement.

**Warrant:**
- Reading of 2026-11-07, `suites/score.ts` `scoreFamilies` on core-cgb f4650f1 with `splits-cgb.json`: base `cgb:acid2` 1/1; T `cgb:mealybug:palette-scroll-bg` 0/14 at mean pixel match 0.6089; H `cgb:acid-hell` 0/1 at 0.9999 and `cgb:mealybug:window` 0/8 at 0.5658. So the T family holds 14 incidents.
- `loop/ledger.test.ts` "two run processes": appends from two runs to one ledger are whole lines with distinct ids. Sharing one ledger is safe at the byte level and unsafe at the reader level, as Not this says.
- False if: a RUN-0002 incident appears in `ledger/incidents.jsonl` of the main checkout, or RUN-0002's manifest `rule_version` is not RUN-0001's.

**Revisit when:** {when: "a run's campaign code filters openIncidents, generationsDue and recheckIncidents by run", then: "runs opened with that code can share one ledger; RUN-0001's process cannot"}

**Residue:**
- `tools/replay.mjs --family` scores a family's ROMs as DMG, so a repairer scoring a CGB T family in its scratch repo reads DMG figures. Suite-incident replays read the window's model.
- The trial families are DMG, so RUN-0002's generation curve measures DMG H learning on the CGB core, not CGB H learning.
- IDs restart at INC-0001 and ATT-0001 in RUN-0002's ledger, so a bare id names an item only together with its run.
