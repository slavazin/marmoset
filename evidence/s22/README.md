# S22: a run on an owner-supplied ROM

All readings were measured on 2026-11-07. Their figures are in `readings.json` and the RAM map's evidence is in `ram-map.md`. The PNGs here are the only frames of the ROM in the repository. Whether Nintendo content is shown publicly is the owner's call (held by review).

## Identical starting conditions

`lockstep/start-state.ts` builds one start state that both sides load.

- The oracle loads the ROM with power-on RAM zeroed (`oracle/frontend.py` `RAM_INIT` `"zero"`).
- It runs the entry's input prefix and saves its own state.
- It reports the machine as SameBoy's BESS footer states it: registers, IO, WRAM, VRAM, OAM, HRAM and the MBC writes.
- The core receives that machine through its own `restore`. The oracle restores its saved state with `rebase`.

Both sides stop at LY 144, the frame boundary.

`loadIntoCore` reads the core back through its bus. It refuses any difference in registers, WRAM, VRAM, OAM, HRAM, IO or IE.

There is residue. BESS carries DIV as its upper byte only, so the core's internal divider starts at `DIV << 8`. In a 300-frame no-input reading from the title state, the stack bytes at `0xDFFB–0xDFFC` differed by one return address (the interrupted instruction). Every frame and every mapped byte matched.

Power-on without a start state is not the same starting condition. Under frame align, SameBoy runs its DMG boot ROM, and oracle frames 102–104 equal core frames 5–7 with zeroed RAM: an offset of 97 frames. That offset, together with SameBoy's seeded RAM noise against the core's zeroed RAM, made up the orchestrator's frame-1 `logic` incident and its every-frame differences.

## The desync after Start: a core bug, left for the repairer

- **Observation.** The S0 core never leaves the title. Over 600 frames with Start pressed at 120, 210 and 300, it stays at PC `0x4BCA`.
- **What the game does.** On a Start press it writes `FF01 = 0x01` and then `FF02 = 0x81`, an internal-clock serial transfer that probes for a link partner.
- **What the core does.** `core/index.ts` `ioWrite` `0xFF02` completes the transfer within the write. It sets SB to `0xFF` and raises the serial IF bit, and it never clears SC bit 7.
- **What SameBoy does.** SameBoy shifts the 8 bits on the serial clock, clears SC bit 7 and raises the interrupt when the transfer ends.
- **Check.** A scratch copy of the core, never committed, completed the transfer 4096 T-cycles after the write and cleared SC bit 7. With it, the core leaves the title, and its frames match the oracle's from frame 32 of a Start-at-20 reading from the title state.
- **Lockstep reading.** From the title start state, a frame incident opens at frame 23 (scene 48, band 0) and a logic incident at frame 28 (mode: oracle menu `0x38`, core title `0x30`). Both are in `readings.json`. `title-start-serial-core.png` and `title-start-serial-oracle.png` are the frame-23 pair. The registry start state begins at level 1, so a run on it does not reach this incident. Reaching it takes a trace that returns to the title.

## Lockstep after the fixes

From the registry start state on the S0 core, three puzzle traces of 1800, 5400 and 5400 frames opened 0 incidents. Every frame and the mapped mode, score, board and level bytes were compared. The frames varied: 236 distinct oracle frames appeared in the 1800-frame trace.

## game.gb and RUN-0001

`games.json` gives game.gb `contract: "s6.17"`, `align: "counter"`, `ram_init: "seeded"` and `start: null`. Lockstep therefore reads it exactly as before: the same oracle load request, map and cache directory. `lockstep/games.test.ts` asserts this.

From a start state, game.gb's frame-0 machine and GAME_RAM match for 60 frames. Its frames differ in the same effect bands as at power-on, which is the S0 core's own PPU divergence.
