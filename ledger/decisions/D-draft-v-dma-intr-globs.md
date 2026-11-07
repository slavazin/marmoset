---
id: D-draft-v-dma-intr-globs
title: V's mooneye:dma-timer-intr family reads OAM DMA as six ROMs and names its interrupt and HALT ROMs
status: draft
supersedes: null
---
**Decision:** `splits.json` family `mooneye:dma-timer-intr` lists `acceptance/oam_dma/*.gb` and `acceptance/oam_dma_*.gb` (6 ROMs), `acceptance/timer/*.gb` (13), and as "the interrupt and HALT ROMs" exactly `di_timing-GS`, `ei_sequence`, `ei_timing`, `halt_*` (4), `if_ie_registers`, `intr_timing`, `rapid_di_ei`, `reti_intr_timing` and `interrupts/ie_push` (12); 31 ROMs on c-sp game-boy-test-roms v7.0, counted by `familyRoms` in `suites/splits.ts`.
**Not this:** `acceptance/oam_dma/*` alone (3 ROMs), which drops `oam_dma_restart`, `oam_dma_start` and `oam_dma_timing`, the top-level OAM DMA timing ROMs.
**Warrant:** SPEC §1.4 F2 reports OAM DMA failures as "1–3 of 6", a population of 6 that only both globs reach. False if: the F2 scorer's OAM DMA population is the 3 ROMs under `acceptance/oam_dma/`.
**Revisit when:** {when: "the orchestrator admits or rejects this draft before S2 merges", then: "edit the V globs in splits.json once; V's list is frozen at S2 merge (D-0009)"}
**Residue:** `reti_timing` sits in T (`mooneye:instr-timing`) and `reti_intr_timing` in V; both exercise RETI, so T learning reaches one V ROM's instruction.
