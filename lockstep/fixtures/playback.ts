// A playback core for lockstep tests: it implements the SPEC §6.1 Core interface by playing back a
// recording of the oracle's own frames and game-state RAM per counter, so it matches the oracle by
// construction. It is not an emulator: lockstep logic tested against it says nothing about any core.
// recordPlayback writes the recording at $RATCHET_CACHE/playback/<rom_sha>/<n>.bin and <n>.ram from a
// fresh oracle run with no inputs. A Mutation plants one difference: a PPU band of flipped shades, or one
// game-state byte XORed, from a chosen counter on.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Core, CoreRegs, HandlerId } from "../../src/schema.ts";
import { OracleClient, ratchetCache, sha256 } from "../../oracle/client.ts";
import { GAME_RAM } from "../diff.ts";

export type Mutation =
  | { kind: "ppu-band"; from: number; lines: [number, number]; xs: [number, number] } // half-open ranges
  | { kind: "ram"; from: number; offset: number; xor: number };

export const playbackDir = (rom_sha: string) => join(ratchetCache(), "playback", rom_sha);

export async function recordPlayback(romPath: string, last: number): Promise<string> {
  const dir = playbackDir(sha256(readFileSync(romPath)));
  if (existsSync(join(dir, `${last}.ram`))) return dir;
  mkdirSync(dir, { recursive: true });
  const oracle = OracleClient.spawn();
  try {
    await oracle.load(romPath, "counter");
    for (let n = 1; n <= last; n++) {
      const r = await oracle.runToCounter(n);
      if (r.stalled) throw new Error(`oracle stalled at ${r.counter} before ${n}`);
      writeFileSync(join(dir, `${n}.bin`), await oracle.frame());
      writeFileSync(join(dir, `${n}.ram`), await oracle.ram(GAME_RAM.addr, GAME_RAM.len));
    }
  } finally {
    await oracle.close();
  }
  return dir;
}

export function createPlaybackCore(rom: Uint8Array, mutation?: Mutation): Core {
  const dir = playbackDir(sha256(rom));
  const cpu: CoreRegs = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, h: 0, l: 0, sp: 0xfffe, pc: 0x100 };
  let counter = 0;
  const has = (n: number) => existsSync(join(dir, `${n}.bin`));
  const ram = (n: number) => {
    const r = new Uint8Array(readFileSync(join(dir, `${n}.ram`)));
    if (mutation?.kind === "ram" && n >= mutation.from) r[mutation.offset] ^= mutation.xor;
    return r;
  };
  const core: Core = {
    cpu, serial: "", cycles: 0,
    step() { core.cycles += 4; },
    runFrame() { counter++; core.cycles += 70224; },
    runToCounter(n) {
      while (counter < n) {
        if (!has(counter + 1)) return false;
        core.runFrame();
      }
      return counter === n;
    },
    read(addr) {
      if (addr < 0x8000) return rom[addr] ?? 0xff;
      const off = addr - GAME_RAM.addr;
      if (counter > 0 && off >= 0 && off < GAME_RAM.len && has(counter)) return ram(counter)[off];
      return 0;
    },
    frame() {
      const f = counter > 0 && has(counter) ? new Uint8Array(readFileSync(join(dir, `${counter}.bin`))) : new Uint8Array(160 * 144);
      if (mutation?.kind === "ppu-band" && counter >= mutation.from) {
        for (let y = mutation.lines[0]; y < mutation.lines[1]; y++)
          for (let x = mutation.xs[0]; x < mutation.xs[1]; x++) f[y * 160 + x] ^= 3;
      }
      return f;
    },
    setButtons() {},
    snapshot() { return Uint8Array.of(counter & 255, counter >> 8); },
    restore(s) { counter = s[0] | (s[1] << 8); },
    tap: {
      handlerHits() { return {} as Record<HandlerId, number>; },
      ppu() { return { ly: 0, mode: 0, dot: 0, stat: 0, lcdc: 0x91 }; },
    },
  };
  return core;
}
