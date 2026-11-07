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
