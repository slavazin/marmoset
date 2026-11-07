# Findings register

Cold-read findings, one line each: id, claim or property, reading, disposition (`fix`, `accept-residue`, or `reject` with a reason). Written by the orchestrator (WORKFLOW.md, Merge step 4).

| Id | Slice | Claim or property | Reading | Disposition |
|---|---|---|---|---|
| S2-F1 | S2 | G6: V ROMs scored without the vread token via `runRom` or relabelled splits | probe scored 8 V ROMs under split "base" with no token | fix: fix/s2-cold-read 9061b0d, test-first |
| S2-F2 | S2 | 60 s wall cap per ROM | post-`LD B,B` `runFrame()` ran outside the caps | fix: fix/s2-cold-read 9061b0d, frames stepped under caps |
| S2-F3 | S2 | V counts 8 and 31 | no test pinned V's lists | fix: fix/s2-cold-read 9061b0d, test pins lists |
| S2-F4 | S2 | V membership rests on a draft decision | D-draft-v-dma-intr-globs merged as draft | fix: admitted as D-0012, OAM DMA 6 ROMs matches F2's "of 6" |
| S2-F5 | S2 | read-once enforced by the scorer | any matching token in a lock authorizes repeat V scorings | accept-residue: read-once is loop/vread.ts's (S10) |
| S2-F6 | S2 | wall cap covers a hung `step()` | single-threaded; cap checked between steps | accept-residue |
| S2-F7 | S2 | CYCLE_CAP (30 emulated s) unspecified in SPEC | no base ROM measured against it | accept-residue: re-read when S1 runs base |
| S2-F8 | S2 | `reti_timing` in T, `reti_intr_timing` in V | listed in D-0012 residue | accept-residue |
| S5-F1 | S5 | G6: V refused on `replay --family` | `./` and letter-case spellings of a V ROM scored with no token | fix: fix/s5-cold-read 2c82192, real-path compare, test-first |
| S5-F2 | S5 | `tools/replay.mjs` self-contained in a scratch repo | ENOENT on splits.json when carried alone | fix: 2c82192, V globs compiled into the bundle |
| S5-F2b | S5 | G7: scratch bundle carries V ROM names (not readings) | consequence of the S5-F2 fix | accept-residue: names only; ROM paths in a scratch repo list only the task's ROMs (S8) |
| S5-F3 | S5 | G2: replay checks the ROM it runs | ROM sha never compared to incident/trace rom_sha | fix: 2c82192, mismatched sha refused |
| S5-F4 | S5 | a repro cannot pass on a stalled core | stall inside the window compared a stale frame as clean | fix: 2c82192, stall fails at any counter |
| S5-F5 | S5 | rule 2 / D-0008: ledger appends only through `loop/ledger.ts` | `JsonlIncidentSink` appends itself | fix: sent to S8, which swaps `loop/ledger.ts` in behind `IncidentSink` |
| S5-F6 | S5 | G4 check 1 / G7: a core under test can read the oracle cache at replay time | playback fixture shows the pattern | fix: sent to S8, gate replay without read access to the cache path, else stated residue |
| S5-F7 | S5 | H containment in `--family` | any H list scores; containment rests on S8's ROM paths | accept-residue |
| S5-F8 | S5 | oracle cache integrity | truncated `<n>.bin` kept; cache not keyed by oracle build | accept-residue: reads as mismatch, never clean |
| S8-F1 | S8 | G7: gate accepts only the `core/**` diff | `loop/a b.ts`, headerless hunk, symlink and binary all graduated | fix: fix/s8-cold-read df82db9, judges staged paths/modes/binaries |
| S8-F2 | S8 | G4: repro read in the parent cannot be forged by the core | core-printed protocol lines made a wrong core clean; stray stdout crashed the gate | fix: df82db9, ordered protocol, non-protocol lines skipped |
| S8-F3 | S8 | G4: every attempt gets a verdict | a throwing check left no Verdict and no tombstone | fix: df82db9, a throw fails its check |
| S8-F4 | S8 | G7: env paths hold the task's oracle frames only | whole-ROM cache dir linked writable; real oracle_dir in window.json | fix: df82db9, read-only copies of the trace's frames |
| S8-F5 | S8 | G4: missing readings are not a pass | family absent after repair skipped | fix: df82db9, absence is regression |
| S8-F6 | S8 | node_modules read-only in scratch | linked to writable repo node_modules | fix: df82db9, read-only copy |
| S8-F7 | S8 | admitted trace replays its window | replayed from counter 1 | fix: df82db9 |
| S8-F8 | S8 | veto reverts a GRADUATE fully | trace stayed admitted | fix: df82db9, traces retired with vetoed_by |
| S8-F9 | S8 | G7: scratch repo isolated from cache, readings, ledger | scratch under $RATCHET_CACHE; Muse shell scope unmeasured | fix: dispatched (scratch root moved out; Muse sandbox scope spike) |
| S8-F10 | S8 | suite repro, base-suites, H run in-process | full fs access incl. references | accept-residue (REPAIR_RESIDUE) |
| S8-F11 | S8 | binary hunks | trimmed hunk drops binary silently; merged equals judged | accept-residue (binaries refused by F1) |
| S8-F12 | S8 | GRADUATE side effects after merge | a throw leaves a merge with no Verdict | fix: dispatched with S8-F9 |
| S8-F13 | S8 | /fire forgery; lock stale-break race; veto run check with RATCHET_RUN unset; base readings cache key | probes | accept-residue; veto null-run check dispatched with S8-F9 |
| S9-F1 | S9 | G4: placebo indistinguishable from candidate | placebo packet/task.json read `"arm": "placebo"` | fix: fix/s9-cold-read 0abaf89, both skill arms' packets name "candidate" |
| S9-F2 | S9 | G7: consolidatorView holds no H reading | fast observations named the refusing check (H-no-regress) | fix: 0abaf89, check names scrubbed |
| S9-F3 | S9 | G4: base regression counted on missing readings | arm with no base reading graduated | fix: 0abaf89 |
| S9-F4 | S9 | G4: a crashed arm still ends in REFUSE | a scoring throw rejected the whole trial | fix: 0abaf89 |
| S9-F5 | S9 | placebo from a different failure shape | twin took an overlapping-path candidate's payload | fix: 0abaf89, overlapping paths skipped |
| S9-F6 | S9 | placebo name indistinguishable | slug of its own Do, mechanically checkable | fix: 0abaf89 |
| S9-F7 | S9 | curve per generation | Verdict.generation never written | fix: 0abaf89 |
| S9-F8 | S9 | id order and template checked-by reveal the twin | visible only across arms | accept-residue |
| S9-F9 | S9 | tie graduates with no floor and zero spread | reachable only via test override | accept-residue |
| S9-F10 | S9 | tombstone keeps every byte | true for single-file skills only | accept-residue |
| S9-F11 | S9 | calibration commit unrecorded | margin reused across core-live commits per SPEC | accept-residue |
| S15-F0 | S15 | frame: no SPEC slice | contract is D-0020 only | accept-residue: D-0020 is the contract |
| S15-F1 | S15 | G4: packet placebo size-matched | twin focus.json empty vs candidate's 1 file | fix: fix/s15-cold-read f8ecfad |
| S15-F2 | S15 | D-0020: policies in force need a GRADUATE verdict | a hand-placed POLICY.md applied | fix: f8ecfad |
| S15-F3 | S15 | order field tells twins apart | probability vs seeded:<hex> | fix: f8ecfad, opaque token on both |
| S15-F4 | S15 | G7: policies never change what the gate judges; never reach baseline | no truth-maker | fix: f8ecfad, tests + UNPOLICIED_ARMS |
| S15-F5 | S15 | diagram stage for policy verdicts | fell through to attempt gate | fix: 599baf5 |
| S15-F6 | S15 | history policy figures | not counted | fix: 599baf5 |
| S15-F7 | S15 | displayables and curve include policies | triggered on skill only | fix: 599baf5 |
| S15-R1..R5 | S15 | routing twin map readable as wrong; id order; subq route empty on family tasks; only ppu globs match real core; baseline shows no skills in policy trials | readings in cold read | accept-residue |
