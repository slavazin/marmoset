# Failure shapes in the cold-read findings

This file clusters the rows of `ledger/findings.md` into recurring defect shapes. Each shape that earns a rule has one self-check in `.claude/agents/implementer.md` § Known failure shapes (the home of the check's wording) and one probe in `.claude/agents/cold-reader.md` § What to read, step 0. The register is the home of every finding's reading and disposition; this file carries only ids and a few words naming each one.

Population: the 51 finding rows of `ledger/findings.md` at the base commit `1e8a2a8`, the S15-R1..R5 row counted as one. A count below is a count of register rows; a row named as a residue counts toward its shape but did not earn the rule alone.

**Rule for earning a check:** two or more rows, or one row whose property is a G4, G6, G7 or SPEC rule 2 contract (cold-reader severity `blocks-merge`).

## Shapes that earn a check

| # | Shape | Finding ids (a few words each) | Rows | What the implementer would have had to check | Self-check added |
|---|---|---|---|---|---|
| 1 | **Twin tells.** The candidate arm and its placebo differ in a field other than the payload. | S9-F1 placebo packet read `arm: placebo`; S9-F5 twin took an overlapping candidate's payload; S9-F6 placebo name mechanically checkable; S15-F1 twin focus.json empty against the candidate's 1 file; S15-F3 order field `probability` against `seeded:<hex>`. Residues: S9-F8 id order and checked-by; S15-R1, S15-R2 routing twin map, id order. | 5 + 3 | Build both arms and diff them byte for byte; every difference is payload, matched in size and form. | implementer 1; cold-reader 0.1 |
| 2 | **Guard keyed on a spelling.** A guard compares the string or label it is handed, not the thing's identity. | S2-F1 V ROMs scored under split "base"; S5-F1 `./` and letter-case spellings of a V ROM; S5-F3 replay never compared the ROM sha; S8-F1 `loop/a b.ts`, headerless hunk, symlink and binary graduated. | 4 | Compare by realpath, sha or the git index; test with aliased spellings and relabelled inputs. | implementer 2; cold-reader 0.2 |
| 3 | **Guard on one path.** A cap or authorisation holds on one route to the resource and another route goes around it. | S2-F2 post-`LD B,B` `runFrame()` outside the wall cap; S15-F2 a hand-placed POLICY.md applied with no GRADUATE verdict. Residue: S2-F6 hung `step()` outside the cap. | 2 + 1 | Grep every site that reaches the guarded thing; test the guard through each; state is in force only with its authorising record. | implementer 3; cold-reader 0.3 |
| 4 | **Fail-open.** Missing, stalled or throwing input becomes a pass, a skip, no record, or an abort wider than its item. | S5-F4 stall compared a stale frame as clean; S8-F3 a throwing check left no Verdict; S8-F5 absent family skipped; S9-F3 arm with no base reading graduated; S9-F4 one scoring throw rejected the whole trial. | 5 | For each check, a test per degenerate input reading the recorded REFUSE or mismatch for that item alone. | implementer 4; cold-reader 0.4 |
| 5 | **Half-done effects.** An action or its inverse leaves some of its records behind. | S8-F8 veto left the trace admitted; S8-F12 a throw after merge left a merge with no Verdict. | 2 | List every record the action writes; test its inverse and a throw after each step against all of them. | implementer 5; cold-reader 0.5 |
| 6 | **Forgeable channel.** The parent trusts output the judged code can write. | S8-F2 core-printed protocol lines made a wrong core clean. Residue: S8-F13 `/fire` forgery. | 1 + 1 | A test where the judged code prints the success lines itself. G4 property: earns the check on severity. | implementer 6; cold-reader 0.6 |
| 7 | **Isolation leak.** The scratch repo, env or consolidator view holds or can write more than its allowlist. | S5-F6 core can read the oracle cache at replay; S8-F4 whole cache dir linked writable, real oracle_dir in window.json; S8-F6 node_modules writable; S8-F9 scratch root under `$RATCHET_CACHE`; S9-F2 consolidatorView named the refusing H check. Residues: S5-F7 H containment; S8-F10 in-process repro; S5-F2b and S1-F3 V names in the scratch bundle. | 5 + 4 | List what the projected tree reaches and can write, symlinks followed; grep file contents, not names only. | implementer 7; cold-reader 0.7 |
| 8 | **Writer bypass.** A ledger or register write goes around its named writer. | S5-F5 `JsonlIncidentSink` appended to the ledger itself. | 1 | Grep the diff's file writes and trace each target. SPEC rule 2 contract: earns the check on severity. | implementer 8; cold-reader 0.8 |
| 9 | **Unthreaded variant.** A kind, enum value or schema field lands and a consumer that switches on its siblings ignores it, or nobody writes it. | S9-F7 `Verdict.generation` never written; S15-F5 policy verdicts fell to the attempt-gate stage in the diagram; S15-F6 history did not count policies; S15-F7 curve and displayables triggered on skill only. Residue: S15-R5 baseline shows no skills in policy trials. | 4 + 1 | Grep the siblings (`kind === "skill"`) across loop, server, ui and displayables; a field a slice owns has a writer and a test reading it back. | implementer 9; cold-reader 0.9 |
| 10 | **Artifact out of context.** A tool works in the repo and fails where it is carried, or a committed bundle lags its inputs. | S5-F2 `tools/replay.mjs` hit ENOENT on splits.json in a scratch repo. Consequences: S5-F2b, S1-F3 V globs compiled into the bundle (counted under shape 7 as residues). | 1 + 2 | Run the carried tool in a scratch repo built by `loop/projection.ts`; rebuild bundles whose inputs changed and run `lockstep/lockstep.test.ts`. | implementer 10; cold-reader 0.10 |
| 11 | **Claim with no truth-maker.** A report claim or SPEC property has no assertion that fails when it turns false. | S2-F3 no test pinned V's lists; S15-F4 G7 policy properties had no test. | 2 | A test per report claim, or the claim moves to Not checked. | implementer "Add a focused test" bullet, folded; cold-reader step 2 (claim sheet) already probes it |

## One-offs and residues outside the shapes

| Finding | Why no rule |
|---|---|
| S2-F4 V membership on a draft decision | An admission step at merge, which WORKFLOW.md Merge gives the orchestrator, not the implementer. |
| S8-F7 admitted trace replayed from counter 1, not its window | One row, `fix-before-demo` reach; shape 11's per-claim test covers it. |
| S2-F5 read-once rests on `loop/vread.ts` | Residue by design: S10 owns read-once. |
| S2-F7 CYCLE_CAP unmeasured; S2-F8 `reti_timing` in T | Residues of a measurement and of D-0012; no build defect. |
| S5-F8 oracle cache integrity | Fails closed (reads as mismatch); stated residue. |
| S8-F11 binary hunks trimmed | Covered by shape 2's fix (binaries refused). |
| S9-F9 tie with zero spread; S9-F10 tombstone bytes; S9-F11 calibration commit | Residues stated against SPEC, each reachable only outside the normal run. |
| S15-F0 no SPEC slice | Frame residue: D-0020 is the contract. |
| S15-R3 subq route empty on family tasks; S15-R4 only ppu globs match the core | Residues of the core's present state, not of the slice's code. |

## Brief template field owed

`WORKFLOW.md` is gitignored, so this pass cannot carry an edit to it. Shapes 3, 9 and 10 each name a site outside the slice's own paths that the implementer has to find; the brief can name it up front. The proposed line, after `Inputs on main:` in WORKFLOW.md § Dispatch:

```
Same guard elsewhere: <other paths that enforce the caps and guards this slice touches, or switch on the kinds it adds, by path; "none">. Rebuild: <committed bundles whose inputs it changes, with their build command; "none">.
```
