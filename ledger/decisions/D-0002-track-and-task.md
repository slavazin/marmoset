---
id: D-0002
title: Track 1, with a cycle-accurate DMG emulator as the task
status: admitted
supersedes: null
---
**Decision:** the build enters Track 1 ("The System That Gets Better"); the hard, tightly coupled task is a cycle-accurate DMG emulator (CPU, bus, timer, interrupts, pixel-FIFO PPU, MBC1), and the improvement room is PPU and timing accuracy.
**Not this:** a CPU-only task; a task whose correctness is judged by an LLM.
**Warrant:** pre-event readings (2026-11-06, SPEC §1.4 F1–F3): blind SM83 CPUs pass 99.8% of SingleStepTests; blind full systems pass the base suites and fail Mealybug and Mooneye timing. False if: S1's kill read reaches exact on 7 or more of 9 T tests within 15 minutes.
**Revisit when:** {when: "S1's kill read shows ≥7/9 T exact in 15 minutes", then: "the owner decides whether the headline becomes cost to pass"}
**Residue:** audio and CGB are outside the task.
