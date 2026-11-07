# Task: make the PPU pass nine Mealybug screenshot tests exactly

You edit a DMG (original Game Boy) emulator written in TypeScript under `core/`. It runs under Node 22+ type stripping: no enums, no parameter properties, no `namespace`; type-only imports use `import type`.

The core passes Blargg cpu_instrs/instr_timing, Mooneye MBC1 and dmg-acid2. Its PPU (`core/ppu.ts`) is ticked once per dot by `core/index.ts`, but it renders each scanline at once, so register writes the CPU makes during mode 3 land on the wrong pixels.

The scored tests are nine Mealybug Tearoom PPU ROMs (`mealybug-tearoom-tests/ppu/`). Each writes a PPU register during mode 3 on every line and the screenshot taken at the end must match the DMG reference image pixel for pixel:

- `m3_bgp_change.gb`, `m3_bgp_change_sprites.gb`: BGP written mid mode 3 (the second with sprites on the line).
- `m3_obp0_change.gb`: OBP0 written mid mode 3.
- `m3_scx_high_5_bits.gb`, `m3_scx_low_3_bits.gb`: SCX written mid mode 3.
- `m3_scy_change.gb`: SCY written mid mode 3.
- `m3_lcdc_bg_en_change.gb`, `m3_lcdc_bg_map_change.gb`, `m3_lcdc_tile_sel_change.gb`: LCDC bits 0, 3 and 4 written mid mode 3.

The scorer is `node tools/replay.mjs --family mealybug:palette-scroll-bg --core-dir core --roms roms.json`. It prints one line per ROM with its pixel match (1.0000 is exact) and a final JSON reading with `exact` (ROMs matching exactly) and `pixel_match` (mean over the nine). Its output on the current files is below. The goal is `exact: 9`.

Real hardware renders mode 3 with a background/window tile fetcher feeding a pixel FIFO, one pixel shifted out per dot, with sprite fetches stalling the background fetcher; each register is read at the dot the fetcher or the pixel output uses it, not once per line. Model that.

Keep the rest of the contract: `core/index.ts` exports `createCore` and `HANDLERS` with the same handler ids, `snapshot()`/`restore()` cover all PPU state you add, the framebuffer `fb` holds shade indices 0–3 as before, and Blargg, MBC1 and dmg-acid2 must still pass. Change only what the PPU needs; send `core/ppu.ts` (and `core/index.ts` only if the wiring must change).

Between rounds the harness keeps the best-scoring core: a reply that scores lower than the best is reverted, and the next round starts from the best files.
