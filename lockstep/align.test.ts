// The core side of counter alignment (SPEC §5 S3): the compared frame at counter n is the frame completed
// before the VBlank that wrote n, and the counter is live only after it first changes following load.
// A synthetic core models the shape core/index.ts has: runFrame ends at LY 144, so the VBlank handler that
// writes the counter runs at the start of the next runFrame, before that frame's lines render.
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Core, HandlerId } from "../src/schema.ts";
import { counterStepper } from "./align.ts";
import { replayFrames } from "./replay.ts";

/** Frame k (k = runFrame calls so far) has every pixel = k & 3 and byte 1 = k; the counter starts at `noise`,
 * stays there for `lag` frames, then the VBlank opening frame k writes k - lag. From `stallAt` on it stops. */
function vblankCore(o: { lag: number; noise: number; stallAt?: number }): Core & { k: () => number } {
  let k = 0, counter = o.noise;
  const fb = new Uint8Array(160 * 144);
  const core = {
    cpu: { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, h: 0, l: 0, sp: 0xfffe, pc: 0x100 }, serial: "", cycles: 0,
    step() {},
    runFrame() {
      k++;
      if (k > o.lag && (o.stallAt === undefined || k - o.lag < o.stallAt)) counter = k - o.lag; // the VBlank handler
      fb.fill(k & 3); fb[1] = k & 0xff;                                                          // lines 0…143
    },
    runToCounter(n: number) { for (let i = 0; i < 1000; i++) { core.runFrame(); if (counter === n) return true; } return false; },
    read(a: number) { return a === 0xc0f0 ? counter & 0xff : a === 0xc0f1 ? counter >> 8 : 0; },
    frame() { return fb.slice(); },
    setButtons() {}, snapshot() { return new Uint8Array(0); }, restore() {},
    tap: { handlerHits() { return {} as Record<HandlerId, number>; }, ppu() { return { ly: 144, mode: 1 as const, dot: 0, stat: 0, lcdc: 0x91 }; } },
    k: () => k,
  };
  return core;
}

test("counterStepper returns, at counter n, the frame completed before the runFrame whose VBlank wrote n", () => {
  const core = vblankCore({ lag: 3, noise: 0 });
  const s = counterStepper(core);
  for (let n = 1; n <= 10; n++) {
    const f = s.to(n);
    assert.ok(f, `counter ${n} reached`);
    // n is written by the VBlank opening frame n + lag, so the compared frame is frame n + lag - 1
    assert.equal(f[1], n + 3 - 1, `counter ${n}`);
    assert.equal(core.k(), n + 3);
  }
});

test("counterStepper ignores a power-on counter value equal to n until the counter first changes", () => {
  // WRAM noise reads 2 at load; the game's first write is 1, then 2
  const core = vblankCore({ lag: 3, noise: 2 });
  const s = counterStepper(core);
  assert.equal(s.to(1)?.[1], 3);
  assert.equal(s.to(2)?.[1], 4);
});

test("counterStepper returns null after STALL_FRAMES frames with an unchanged live counter", () => {
  const core = vblankCore({ lag: 0, noise: 0, stallAt: 5 });
  const s = counterStepper(core);
  for (let n = 1; n <= 4; n++) assert.ok(s.to(n));
  assert.equal(s.to(5), null);
});

test("replayFrames compares the frame completed before the VBlank that wrote n: clean against an oracle cache in that convention", () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-align-"));
  const lag = 3;
  for (let n = 1; n <= 12; n++) {
    const f = new Uint8Array(160 * 144).fill((n + lag - 1) & 3);
    f[1] = n + lag - 1;
    writeFileSync(join(dir, `${n}.bin`), f);
  }
  const out = replayFrames(() => vblankCore({ lag, noise: 0 }), { rom: new Uint8Array(0x8000), align: "counter", inputs: [], window: [1, 12], oracleDir: dir });
  assert.deepEqual(out, { clean: true, compared: 12 });
});
