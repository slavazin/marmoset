// A fixture core for suites tests: every instruction executes as a 4-cycle NOP (PC += 1), registers stay 0,
// the frame stays all white (shade 0) and serial stays empty. read() returns ROM bytes, so the scorer's
// LD B,B detection fires wherever a 0x40 byte sits in the ROM.
import type { Core, CoreRegs, HandlerId } from "../../../src/schema.ts";

export function createCore(rom: Uint8Array): Core {
  const cpu: CoreRegs = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, h: 0, l: 0, sp: 0xfffe, pc: 0x100 };
  const frame = new Uint8Array(160 * 144);
  const core: Core = {
    cpu, serial: "", cycles: 0,
    step() { cpu.pc = (cpu.pc + 1) & 0xffff; core.cycles += 4; },
    runFrame() { for (let i = 0; i < 70224 / 4; i++) core.step(); },
    runToCounter() { return false; },
    read(addr) { return addr < rom.length && addr < 0x8000 ? rom[addr] : 0; },
    frame() { return frame; },
    setButtons() {},
    snapshot() { return new Uint8Array(0); },
    restore() {},
    tap: {
      handlerHits() { return {} as Record<HandlerId, number>; },
      ppu() { return { ly: 0, mode: 0, dot: 0, stat: 0, lcdc: 0 }; },
    },
  };
  return core;
}
