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
