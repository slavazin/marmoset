// A fixture core for loop/ gate tests (SPEC §6.1 shape, no real CPU): each runFrame advances the §6.17 counter
// at 0xC0F0 by one, runToCounter(n) succeeds for every n,
// and frame() is 160*144 pixels of ppu.ts shadeFor(rom[0]). HANDLERS maps two handler ids to their files.
import { shadeFor } from "./ppu.ts";

export const HANDLERS: Record<string, string> = { "cpu.op": "index.ts", "ppu.fifo": "ppu.ts" };

export function createCore(rom: Uint8Array) {
  const frame = new Uint8Array(160 * 144);
  const render = () => frame.fill(shadeFor(rom[0] ?? 0));
  let counter = 0;
  const core = {
    cpu: { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, h: 0, l: 0, sp: 0xfffe, pc: 0x100 },
    serial: "", cycles: 0,
    step() { core.cycles += 4; },
    runFrame() { render(); counter = (counter + 1) & 0xffff; },
    runToCounter(_n: number) { render(); return true; },
    read(addr: number) { return addr === 0xc0f0 ? counter & 0xff : addr === 0xc0f1 ? counter >> 8 : rom[addr] ?? 0; },
    frame() { return frame; },
    setButtons(_mask: number) {},
    snapshot() { return new Uint8Array(0); },
    restore(_s: Uint8Array) {},
    tap: { handlerHits() { return {}; }, ppu() { return { ly: 0, mode: 0 as const, dot: 0, stat: 0, lcdc: 0 }; } },
  };
  return core;
}
