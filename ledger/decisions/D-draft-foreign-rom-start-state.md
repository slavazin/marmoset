---
id: D-draft-foreign-rom-start-state
title: A registry game runs both sides from one oracle-built start state, compared on a RAM map found by search
status: draft
supersedes: null
---
**Decision:** S22 takes these Wiggle choices:
- **Registry.** `games.json` lists each game by ROM sha256 (`lockstep/games.ts`). `contract: "s6.17"` reads SPEC §6.17's GAME_RAM, which is how game.gb and every unregistered ROM are read. `contract: "map"` reads the entry's `map`: the `logic` byte ranges lockstep compares, the scene byte, and the counter, where `null` means frame align.
- **RAM init.** The oracle zeroes power-on RAM by disabling SameBoy's noise source (`oracle/frontend.py` `RAM_INIT` `"zero"`), matching `core/index.ts`. The core is not changed to SameBoy's noise.
- **Start state.** The oracle runs the entry's input prefix from zeroed RAM, then saves its state and its BESS machine (`lockstep/start-state.ts`). The core loads that machine through its own `restore`. The cache file `$RATCHET_CACHE/start/<rom_sha>/<key>.json` is never committed, and a run on a registry game records its sha in the manifest as `start:<id>`.
- **Mario & Yoshi map.** It holds mode `0xC029`, score `0xC61D` (3 bytes), board `0xC630` (48 bytes) and level `0xC6B3`. The scene is the mode byte. The game has no frame counter, so it aligns by frame (`evidence/s22/ram-map.md`).
- **Mario & Yoshi start (orchestrator decision, 2026-11-07).** `games.json` `start` is the title: frame 104 after load with no input, zeroed RAM. RUN-0004 uses this start, so the serial-transfer bug is reachable: the S0 core stays on the title after START (`evidence/s22/README.md`).
  - The owner's level-1 start (frame 200 of a two-START prefix) stays registered as `other_starts["level-1"]`. Lockstep and the gate use `start` alone.
  - From a title start, `loop/game-trace.ts` `puzzleTrace` presses START at frames 20 and 90, then plays the puzzle from frame 120.

**Not this:**
- Matching the core's power-on to SameBoy's seeded noise. That edits `core/**`, which only the repairer and gate may change.
- A custom boot ROM to time SameBoy's post-boot state to the core's. It needs cycle-exact DIV and LCD phase in hand-written code, and leaves RAM and VRAM to it as well.
- A whole-WRAM logic compare. The stack bytes `0xDFFB–0xDFFC` hold the interrupted return address, which differs by an instruction across the transfer (evidence/s22/README.md).
- Selecting a game by file name or path. `gameBySha` hashes the bytes (`lockstep/games.test.ts`).

**Warrant:**
- Owner requirement, 2026-11-07: identical starting conditions on every run. Owner amendment, same day: a per-game memory contract for Mario & Yoshi, and a start at the first level.
- From the level-1 start, three puzzle traces (1800, 5400 and 5400 frames) opened 0 incidents on the S0 core (`evidence/s22/readings.json`). False if: a no-input run from the start state opens an incident on a core that matches SameBoy (`lockstep/start-state.test.ts`).
- With 0 incidents from level 1, a run there gives the repairer nothing to repair. From the title start, a START press opens a frame incident at frame 23 and a logic incident at frame 28 on the S0 core (`evidence/s22/readings.json`).

**Revisit when:**
- {when: "RUN-0001 freezes", then: "decide whether game.gb's entry takes a start state; until then its entry keeps start null and seeded RAM so RUN-0001's comparison is unchanged"}
- {when: "a repaired core changes its snapshot layout", then: "loadIntoCore and frames-child refuse the start state; update lockstep/start-state.ts coreSnapshotOf"}

**Residue:**
- BESS gives DIV's upper byte only. Window line counter and STAT-line phase are set at the boundary, not read.
- Admitted traces (`Trace`, SPEC §6.5) carry no start state. The gate's trace replay (`loop/replay-seam.ts` `isolatedReplayer`) takes the start state from the registry entry for the trace's ROM sha, so a change to that entry's `start` breaks the replay of traces admitted under the old one. `tools/replay.ts --trace` replays from power-on.
- The board layout inside `0xC630–0xC65F` is unconfirmed.
