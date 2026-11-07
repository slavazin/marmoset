// Fixture core: a stand-in for S1's `core/index.ts` with the §6.1 Core API shape. It renders a scrolling
// test pattern, moves a block with the d-pad, writes the game counter (§6.17) once per frame, and reports
// handler hits and PPU state so every panel has data. It emulates nothing; `ui/core-seam.ts` swaps it out.

import type { Core, CoreRegs, Handlers, TelemetryTap } from "../../src/schema.ts";
import { GAME_RAM } from "../../src/schema.ts";

export const LCD_W = 160;
export const LCD_H = 144;
/** T-cycles per DMG frame: 154 lines × 456 dots. */
export const FRAME_CYCLES = 154 * 456;

export const HANDLERS: Handlers = {
  "cpu.op": "core/cpu.ts", "cpu.cb": "core/cpu.ts", "ppu.oam": "core/ppu.ts", "ppu.fetcher": "core/ppu.ts",
  "ppu.fifo": "core/ppu.ts", "ppu.window": "core/ppu.ts", "ppu.sprites": "core/ppu.ts", timer: "core/timer.ts",
  irq: "core/irq.ts", dma: "core/dma.ts", mbc1: "core/mbc1.ts", "bus.io": "core/bus.ts",
};

/** The pattern frame `frame` draws, with the block at (bx, by); exported so fixture evidence matches the fixture core. */
export function testPattern(out: Uint8Array, frame: number, bx: number, by: number): void {
  for (let y = 0; y < LCD_H; y++) {
    for (let x = 0; x < LCD_W; x++) {
      const band = ((x + y + frame) >> 3) & 3;
      const border = x < 4 || y < 4 || x >= LCD_W - 4 || y >= LCD_H - 4;
      out[y * LCD_W + x] = border ? 3 : band === 3 ? 1 : 0;
    }
  }
  for (let y = by; y < by + 16 && y < LCD_H; y++) for (let x = bx; x < bx + 16 && x < LCD_W; x++) out[y * LCD_W + x] = 3;
}

// A short loop the fixture "executes", so PC and the disassembler have real bytes: LD A,(FF44); CP $90; JR NZ,-6; HALT; JP $0150
const PROGRAM = [0xf0, 0x44, 0xfe, 0x90, 0x20, 0xfa, 0x76, 0xc3, 0x50, 0x01];

export function createCore(rom: Uint8Array): Core {
  const fb = new Uint8Array(LCD_W * LCD_H);
  const wram = new Uint8Array(0x2000);
  const hram = new Uint8Array(0x80);
  let frames = 0; let buttons = 0; let bx = 72; let by = 64; let ip = 0; let ly = 0;
  const hits: Record<string, number> = {};
  const cpu: CoreRegs = { a: 0x01, b: 0, c: 0x13, d: 0, e: 0xd8, f: 0xb0, h: 0x01, l: 0x4d, sp: 0xfffe, pc: 0x0150 };
  const hit = (h: string, n: number) => { hits[h] = (hits[h] ?? 0) + n; };

  const tap: TelemetryTap = {
    handlerHits() { const r = { ...hits }; for (const k of Object.keys(hits)) delete hits[k]; return r; },
    ppu() {
      const mode = ly >= LCD_H ? 1 : ((frames + ly) % 3 === 0 ? 2 : (frames + ly) % 3 === 1 ? 3 : 0);
      return { ly, mode: mode as 0 | 1 | 2 | 3, dot: (frames * 7) % 456, stat: 0x80 | (mode & 3) | (ly === 0x90 ? 4 : 0), lcdc: 0x91 };
    },
  };

  const core: Core = {
    cpu, tap, serial: "", cycles: 0,
    step() { ip = (ip + 2) % PROGRAM.length; cpu.pc = 0x0150 + ip; core.cycles += 8; hit("cpu.op", 1); },
    runFrame() {
      if (buttons & 1) bx = Math.min(LCD_W - 16, bx + 1);
      if (buttons & 2) bx = Math.max(0, bx - 1);
      if (buttons & 4) by = Math.max(0, by - 1);
      if (buttons & 8) by = Math.min(LCD_H - 16, by + 1);
      testPattern(fb, frames, bx, by);
      frames++;
      const counter = frames & 0xffff;
      wram[GAME_RAM.counter - 0xc000] = counter & 0xff;
      wram[GAME_RAM.counter - 0xc000 + 1] = counter >> 8;
      ly = (frames * 37) % 154;
      ip = (frames * 2) % (PROGRAM.length - 2);
      cpu.pc = 0x0150 + ip;
      cpu.a = (cpu.a + frames) & 0xff;
      core.cycles += FRAME_CYCLES;
      hit("cpu.op", 17556 / 2); hit("ppu.fetcher", 144 * 20); hit("ppu.fifo", 144 * 160); hit("ppu.oam", 144 * 10);
      hit("timer", 64); hit("irq", 1 + (frames % 3)); hit("bus.io", 200 + (frames % 50));
      if (by < 72) hit("ppu.window", 144 * 2);
      if (buttons) hit("ppu.sprites", 40);
    },
    runToCounter(n) { for (let i = 0; i < 5 * 60 && (frames & 0xffff) !== n; i++) core.runFrame(); return (frames & 0xffff) === n; },
    read(addr) {
      addr &= 0xffff;
      if (addr >= 0x0150 && addr < 0x0150 + PROGRAM.length) return PROGRAM[addr - 0x0150];
      if (addr < 0x8000) return rom[addr] ?? 0xff;
      if (addr >= 0xc000 && addr < 0xe000) return wram[addr - 0xc000];
      if (addr === 0xff44) return ly;
      if (addr === 0xff41) return tap.ppu().stat;
      if (addr === 0xff0f) return 0xe0 | (ly >= LCD_H ? 1 : 0) | (frames & 1 ? 2 : 0);
      if (addr >= 0xff80 && addr < 0xffff) return hram[addr - 0xff80];
      if (addr === 0xffff) return 0x05;
      return 0xff;
    },
    frame() { return fb; },
    setButtons(mask) { buttons = mask & 0xff; },
    snapshot() { return new Uint8Array([frames & 0xff, frames >> 8, bx, by]); },
    restore(s) { frames = s[0] | (s[1] << 8); bx = s[2]; by = s[3]; },
  };
  return core;
}
