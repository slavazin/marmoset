---
id: D-draft-game2-timer
title: Game 2 runs the timer interrupt from a DIV reset and keeps its count out of game state
status: draft
supersedes: null
---
**Decision:** `game2/game2.gb` ("HALOGEN", S21) starts the timer (TAC 0x04, TMA 0xC0, 64 overflows per second) right after resetting DIV, one VBlank after the LCD comes on (`game2/src/main.c` `main`). The timer interrupt drives the music on APU channels 2 and 4 and the HUD beat lamp tile. No game-state variable and no §6.17 contract byte reads the beat count; `game2/game2.test.ts` asserts the beat and the music step appear in none of `vbl_isr`, `publish`, `update_play`, `update_title`, `update_bolts`, `update_sparks`, `update_sprites` and `enter_scene`, and that the source reads neither DIV nor TIMA.

**Not this:**
- A game 2 with no timer interrupt, as D-0007 words it for `game.gb`. The timer interrupt is a hardware path game 1 never reaches, and S21 exists to reach paths game 1 does not.
- A timer started without the DIV reset. Its phase would then follow the DIV value at load, which differs between the oracle (boot ROM run) and a core started post-boot.
- Enemy waves or any play timing driven by the timer. A core's timer error would then end the trace as a `logic` incident at the first divergence, hiding every frame incident after it.

**Warrant:**
- D-0007's warrant holds for game 2: lockstep compares frames at equal counter values, and the timer's phase is fixed by the DIV write at a fixed point after LCD-on on both machines.
- Reading 2026-11-07, `evidence/s21/lockstep.json`: game 2 on the S1 core against SameBoy, explorer seed 21, 3000 counters compared, no `logic` incident.
- False if: two oracle runs of `game2.gb` from equal inputs differ in the beat lamp tile at an equal counter.

**Revisit when:** {when: "a lockstep frame incident on game 2 sits only on the beat lamp tile (window row 1, column 19)", then: "read the core's timer and interrupt dispatch against the oracle before calling it a PPU fault"}

**Residue:**
- The APU output is not compared by lockstep; a core's music fault opens no incident.
