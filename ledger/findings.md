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
| S1-F3 | S1 | G7: the scratch repo's `tools/replay.mjs` carries V's ROM globs | 37 matches in the bundle; loop/projection.ts copies it (S5-F2 compiled them in so the bundle refuses V) | accept-residue: names only, so the bundle can refuse V; no V ROM, reading or reference reaches the scratch repo |
| S10-F1 | S10 | G4: a GRADUATE is judged on the head it merges into | second parallel GRADUATE merged onto a core-live it never read | fix: 376d515, rebase onto head inside the gate mutex; conflict or empty REFUSED at merge |
| S10-F2 | S10 | an early throw counts against MAX_ATTEMPTS | 4143 retries in 0.6 s | fix: 0c175c8, attempt-error records, park at MAX_ATTEMPTS |
| S10-F3 | S10 | S0 = ∅ at open | openRun checked nothing | fix: eefc3df, refused unless --allow-nonempty-s0 |
| S10-F4 | S10 | override `at` in the future drops priced records | meter trusted `at` | fix: 12cb6d2, min(at, file mtime) plus a warning |
| S10-F5 | S10 | currentRun() needs manifest.json | no dedicated test | fix: 000338e |
| S10-F6 | S10 | ATTEMPT_WALL_S 1350 s read everywhere | no hard-coded 810/1215/13.5 | accept-residue: D-0026 supersedes D-0025 with the 1350 s, ~10-attempt arithmetic |
| S10-F7 | S10 | G6: the V read reads the frozen S* | ratchet arm took graduated skills at read time | fix: f61676b, refused when setSha ≠ s_star_sha |
| S10-F8 | S10 | G6: the V read cannot run twice | two processes could both start; plain writeFileSync | fix: f61676b, start record and vread.json O_EXCL |
| S10-F9 | S10 | the campaign stops learning at the freeze | attempts and generations kept starting | fix: c45b326 |
| S10-F10 | S10 | G4: rule constants unchanged after open | only visible as differing rule_version | fix: a7374da, --resume refused on ruleVersion mismatch |
| S10-F11 | S10 | the vread token is set only while scoring | set for the whole parallel block; repairEnv excludes it (test) | accept-residue: absolute-path read of vread.lock covered by D-0018/D-0021 |
| S10-F12 | S10 | spend guard under parallel starts | up to 3 attempts can start at $59.99 | fix: 34c17aa, reserve per in-flight attempt (ATTEMPT_RESERVE_USD 5 until a finished attempt exists) |
| S10-F13 | S10 | G9: UI figures | meter, V card from files; thresholds are constants | accept-residue |
| S10-F14 | S10 | V-read arm whose diff fails to apply | silently scores the base core | fix: 277ed12, apply_failed in vread.json, progress and both V cards |
| S10-F15 | S10 | play during a merge | realPlay reads live/core without the gate lock | accept-residue: short window |
| S10-F16 | S10 | a post-merge re-check that throws | logged to telemetry `recheck-error`, incident left as it was, not on the verdict | accept-residue: the incident stays open and is retried, so nothing is miscounted |
| S17b-F1 | S17b | shape 1: the decoy is unmarked | every decoy's not-this named the picture; live decoy p 0.005 | fix: 348c490, not-this names a nearby mechanism in its own subsystem |
| S17b-F2 | S17b | shape 1: decoy position | placed ahead of mid_line and severity | fix: 348c490, inside the run of applies: questions |
| S17b-F3 | S17b | shape 1: the twin is the subsystem question reworded | twin criteria 2–3× longer, added mechanism | fix: 348c490, matched-length paraphrases (≤ 1.5×) |
| S17b-F4 | S17b | shape 4: a stalled SubQ call | no timeout; a hang stalls the fast loop | fix: 348c490, SUBQ_TIMEOUT_MS 30000 |
| S17b-F5 | S17b | shape 4: error vs abstain | partial failure looked like an answer | fix: 348c490, `failed` count on the call meter |
| S17b-F6 | S17b | the mechanism forecast cannot see the verdict | asked after the verdict and status flip | fix: 348c490, asked before the gate, awaited after |
| S17b-F7 | S17b | the wrong-route truth-maker | circular under packet focus; per-file truth lets oam_dma score ≈ 1 | fix: 348c490 partial, steered routes excluded, chance shown; accept-residue: truth per file until provenance is per handler |
| S17b-F8 | S17b | a forecast record re-emits attempt end | diagram went back to gate | fix: 348c490, StageTracker lights each phase once |
| S17b-F9 | S17b | ppu.fifo, ppu.oam, ppu.sprites in no focus set | mapping them breaks D-0020's size match | accept-residue: D-0020 size match outranks reach; a sprite failure routes to dma |
| S17b-F10 | S17b | the decoy's SKL label | weak tell; cache keys can collide with a later real skill | accept-residue (D-0027) |
| S17b-F11 | S17b | a failed family route | null on both arms, symmetric; not in the ledger | accept-residue |
| S17b-F12 | S17b | INC-0003 twin disagreement | measured against the old twin | accept-residue: dated reading |
| R1-F1 | RUN-0001 | a resume steer lifts only the pause it answers | STR-0001 (written 13:59 PST) lifted a later pause at 14:43 and ATT-0021 started past the owner's budget; the orchestrator killed ATT-0021 and the muse-native watcher | fix: open — resumeSteer must take steers after the latest pause, and askLifted must reset on a new pause |
