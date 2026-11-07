# TASK: write a Game Boy (DMG) emulator core in `core/`

Write a complete DMG emulator core in TypeScript under `core/`. Its entry is `core/index.ts`, which exports `createCore` and `HANDLERS` exactly as specified below. Write it from your own knowledge; copy no existing emulator's code.

## Language and runtime rules
- TypeScript run by Node 22+ type stripping (`node file.ts`), and bundled for the browser by esbuild. Use only erasable syntax: no `enum`, no `namespace`, no constructor parameter properties, no `import =`. Import local files with their `.ts` extension (`import { Cpu } from "./cpu.ts"`). Import types with `import type`.
- Import the shared types from `../src/schema.ts` (`Core`, `CoreRegs`, `TelemetryTap`, `HandlerId`, `Handlers`, `CreateCore`). Never redeclare them, and never edit `src/schema.ts`.
- No Node APIs inside `core/` (no `fs`, `Buffer`, `process`): the core runs in a browser. Typed arrays only.
- Speed: the core runs at least 60 frames per second in Node on the game ROM (`game/game.gb`); aim for several hundred.

## Components
1. **CPU (SM83):** every opcode and every CB opcode with correct flags and M-cycle counts; `EI` delay of one instruction; `HALT` and the HALT bug (HALT with IME=0 and a pending interrupt: the next opcode byte is read twice); `STOP` is two bytes long. Start in the post-boot-ROM DMG state (A=01 F=B0 B=00 C=13 D=00 E=D8 H=01 L=4D SP=FFFE PC=0100, and the DMG post-boot IO register values); no boot ROM.
2. **M-cycle bus:** each memory access advances the rest of the machine (timer, PPU, DMA, serial) by 4 T-cycles at the moment of the access, so mid-instruction timing is right. Memory map: ROM via MBC1, VRAM, external RAM, WRAM, echo RAM, OAM, unusable FEA0–FEFF (reads FF), IO, HRAM, IE.
3. **Timer:** the 16-bit internal divider (DIV is its upper byte; writing DIV resets it), TIMA increments on the falling edge of the selected divider bit ANDed with TAC enable, overflow reload from TMA with the one-M-cycle delay, then IF bit 2.
4. **Interrupts:** IF (FF0F, upper bits read 1) and IE (FFFF); service order VBlank, STAT, Timer, Serial, Joypad; dispatch takes 5 M-cycles; HALT exits on any pending enabled interrupt even with IME=0.
5. **Serial:** writing FF02 with 0x81 transfers the FF01 byte: append it as a character to `core.serial`, set FF01 to 0xFF, and raise the serial interrupt (IF bit 3) after the transfer (an internal clock of 8192 Hz, or immediately).
6. **OAM DMA:** writing FF46 copies 160 bytes from `value << 8` to OAM, one byte per M-cycle, with OAM reads returning 0xFF during the transfer.
7. **Joypad:** FF00 with select bits 4/5; `setButtons(mask)` with bit0 right, 1 left, 2 up, 3 down, 4 A, 5 B, 6 select, 7 start (1 = pressed); a newly pressed button raises IF bit 4.
8. **MBC1:** RAM enable, 5-bit ROM bank (bank 0 maps to 1), 2-bit upper bank / RAM bank, banking mode 0/1 (mode 1 also banks the 0000–3FFF region and RAM), ROM size masking, RAM size from header byte 0x149. Cartridge type 0x00 (ROM only) also works. Header byte 0x147 selects.
9. **PPU:** modes 2 (80 dots) → 3 (172 dots plus sprite/scroll penalties as you model them) → 0 (rest of 456) per line, lines 144–153 mode 1; LY, LYC compare and the STAT interrupt sources (modes 0/1/2 and LYC, with the STAT IRQ blocking rule: one rising edge of the ORed line); VBlank interrupt at LY 144; LCDC bits (LCD on/off: off holds LY=0 and mode 0; BG/window tile map and tile data select; window enable; sprite enable and 8x16 size; BG enable); SCX/SCY scroll, WX/WY window with the internal window line counter; up to 10 sprites per line, X priority, OBP0/OBP1, flips, BG-over-OBJ priority; BGP palette. A scanline renderer that draws each line at the start of mode 0 (HBlank) is acceptable. The output frame is 160×144 shades 0..3 after the palette (0 = white, 3 = black).
10. **snapshot/restore:** `snapshot()` serialises every bit of machine state (CPU, all RAM, OAM, VRAM, IO, MBC, timer, PPU, DMA, serial, joypad, pending-EI, halt, cycles, the last completed frame, `serial` text) into one `Uint8Array`; `restore(s)` into a fresh core for the same ROM makes it continue identically, frame for frame and cycle for cycle.
11. **runToCounter(n, wramAddr = 0xC0F0):** runs whole frames (`runFrame`) until the little-endian 16-bit value at `wramAddr` equals `n`; returns true then. Returns false when that value has not changed for 5 consecutive frames (a stall).
12. **Telemetry tap and handler registry:** see §6.2 below. `handlerHits()` returns the count of hits per handler id since the previous call and resets the counts. Count a hit wherever that handler's code runs: `cpu.op` per executed base opcode, `cpu.cb` per CB opcode, `timer` per TIMA increment, `irq` per interrupt dispatch, `dma` per DMA byte, `mbc1` per MBC register write, `bus.io` per IO register write, `ppu.oam` per line's OAM scan, `ppu.fetcher`/`ppu.fifo` per line rendered (BG), `ppu.window` per line on which the window draws, `ppu.sprites` per line with at least one sprite. `onRegWrite` (when set) is called on every write to FF00–FF7F and FFFF with the PPU's current `ly` and `dot` and the total `cycles`. `ppu()` returns the PPU's current state. `HANDLERS` maps every handler id the tap can emit to the file under `core/` that implements it (path relative to the repository root, such as `"core/ppu.ts"`); every listed file exists.

Write exactly four files, in this order: `core/mbc1.ts` (the cartridge: MBC1 and ROM-only), `core/ppu.ts` (the PPU), `core/cpu.ts` (the SM83, calling a bus interface for every memory access and for internal M-cycles), and `core/index.ts` (the bus with timer, interrupts, serial, OAM DMA and joypad, snapshot/restore, the tap, `HANDLERS` and `createCore`). Map each handler id in `HANDLERS` to the one of these four files that implements it (timer, irq, dma and bus.io map to `core/index.ts`). Keep the code compact: tables and switch statements over long if-chains.

## Interface (SPEC §6.1, verbatim)
```ts
export interface CoreRegs { a: number; b: number; c: number; d: number; e: number; f: number; h: number; l: number; sp: number; pc: number }
export interface Core {
  step(): void;                         // one instruction or HALT idle step; advances timer/PPU/DMA; services an interrupt
  runFrame(): void;                     // until the PPU completes the next frame (LY 143 → 144)
  runToCounter(n: number, wramAddr?: number): boolean; // until the game's counter (§6.17) equals n; false on a 5-frame stall
  cpu: CoreRegs;
  read(addr: number): number;           // bus read, no side effects
  frame(): Uint8Array;                  // 160*144 shades 0..3 (0 = white), last completed frame
  serial: string;
  cycles: number;                       // total T-cycles
  setButtons(mask: number): void;       // bit0 right,1 left,2 up,3 down,4 A,5 B,6 select,7 start (1 = pressed)
  snapshot(): Uint8Array; restore(s: Uint8Array): void;   // same-commit only; cross-commit resume replays the trace (N3)
  tap: TelemetryTap;
}
export function createCore(rom: Uint8Array): Core;
export const HANDLERS: Record<HandlerId, string>;          // handler id → implementing file under core/
```
`cpu` reflects the live registers (a getter object or one kept in sync after each `step`). `cycles` is a live value. With the LCD off, `runFrame` returns after 70,224 T-cycles.

## Telemetry (SPEC §6.2, verbatim)
```ts
export type HandlerId = string;   // "cpu.op", "cpu.cb", "ppu.oam", "ppu.fetcher", "ppu.fifo", "ppu.window", "ppu.sprites", "timer", "irq", "dma", "mbc1", "bus.io"
export interface TelemetryTap {
  onRegWrite?: (e: { addr: number; value: number; ly: number; dot: number; cycles: number }) => void;
  handlerHits(): Record<HandlerId, number>;            // per frame, reset on read
  ppu(): { ly: number; mode: 0 | 1 | 2 | 3; dot: number; stat: number; lcdc: number };
}
```

## Provenance (SPEC §6.3, verbatim; the gate writes it, you only keep `HANDLERS` exact)
```ts
export interface ProvenanceEntry { handler: HandlerId; file: string; commit: string; attempt?: string; skill?: string }
// commit = last core-live commit touching `file`; attempt/skill from that commit's trailer lines "Attempt: ATT-…", "Skills: SKL-…"
```

## Game RAM contract (SPEC §6.17)
`0xC0F0`, 2 bytes little-endian: the game's frame counter, written once per VBlank.

## How you are checked
Run these from the repository root, read the output, and fix what fails. Do not edit any file outside `core/`.
- `node suites/run.ts --split base --core-dir core` must print `blargg 15/15`, `mbc1 12/12` and dmg-acid2 `1/1` (exact screenshot). Per-ROM results go to stderr. Blargg passes on serial "Passed"; Mooneye MBC1 passes when, at the first `LD B,B` (opcode 0x40), B,C,D,E,H,L = 3,5,8,13,21,34; dmg-acid2 compares `frame()` two frames after `LD B,B` with the reference image.
- `node --test core/contract.test.ts` must pass: snapshot/restore determinism over 1,000 frames, `HANDLERS` coverage, `runToCounter`, frame length.
- `npx tsc --noEmit -p .` must report no error under `core/`.
