# Mario & Yoshi (Europe) RAM map

The game is ROM sha256 `062c243e167e819bcbea29c63158d1c616d185fd400ce94cbbef6f35cfd990b4`, MBC1, 64 KiB, no cartridge RAM. The ROM is owner-supplied and never committed; `games.json` names it by sha and finds it through `$RATCHET_ROM_MARIO_YOSHI_EU` or `$RATCHET_CACHE/games/mario-yoshi-eu.gb`. `games.json` entry `mario-yoshi-eu` is the map's home. This file holds the evidence behind each address.

## Method (oracle, 2026-11-07)

SameBoy (`oracle/frontend.py`) loaded the ROM with `ram_init: "zero"` in frame align. Every frame it recorded WRAM `0xC000–0xDFFF` and HRAM `0xFF80–0xFFFE` (HRAM from the BESS `machine` op). Two scripted traces drove it, with frame indices counted from load:

- **Trace A.** No input to frame 300, then Start for 6 frames, then 100 idle. Down and Right ×2 select level 3. Start begins play, followed by 3000 idle frames, so the board fills and the score rises.
- **Trace B.** Same opening. Right ×4 selects level 5 and Down, Right selects HIGH speed. Start begins play for 600 frames, Start pauses for 120, Start resumes, then 6000 idle frames. Over those frames the stack reaches the top, GAME OVER shows, then BEST RECORDS.

An address is in the map only when both traces agree on it. The score address was also confirmed by writing to it.

## Addresses

| Name | Address | Len | Trace A | Trace B | Confirmation |
|---|---|---|---|---|---|
| mode (scene) | `0xC029` | 1 | title `0x30`, menu `0x38`, play `0x34` | title `0x30`, menu `0x38`, play and pause `0x34`, game over and records `0x00` | Constant inside each screen in both traces. Writing `0x00` during play froze the board without redrawing, so the byte is a state index, not a display copy. |
| score | `0xC61D` | 3 | `05 00 00` at frame 1500 (screen 00005), `60 00 00` at 3500 (screen 00060) | `20 00 00` at frame 2700 (screen 00020) | BCD, low byte first. Writing `0xC61E = 0x12, 0xC61F = 0x03` during play redrew the score as 31205 within 10 frames. |
| level | `0xC6B3` | 1 | menu level 1/2/3 reads `0`/`1`/`2`, play reads `2` | menu level 5 reads `4`, play reads `4` | Zero-based. Constant through play in both traces. HRAM `0xFF8D` mirrors it in the menu and holds `0` in play, so it is left out. |
| board | `0xC630` | 48 | piece codes 1–4 at odd offsets, changing as pieces land | same | Compared as bytes. The row and column layout is unconfirmed. |

**Frame counter: none.** No WRAM or HRAM byte rises by exactly 1 every frame. Neither trace A's play frames 600–1500 nor trace B's 720–1260 has one, and neither do the title or the pause. The entry therefore aligns by frame (`counter: null`, `align: "frame"`).

## Start states

`games.json` `start` is the title: frame 104 after load, no input, mode `0x30`. `other_starts["level-1"]` is the owner's level-1 start. Its prefix presses Start at frames 104–109 (title to menu) and 170–175 (menu to level 1, low speed), and the state is taken at frame 200. In trace C, which is this prefix, mode first reads `0x34` at frame 178, and the play screen finishes drawing at frame 183. `lockstep/start-state.test.ts` asserts mode `0x30` for the title start, and mode `0x34` with level `0` for the level-1 start.

`start-level1-oracle-frame1.png` is the oracle's first frame after the start state.
