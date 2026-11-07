import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OracleClient, oracleFrames, RGB_FRAME_BYTES, sha256 } from "./client.ts";
import { readPngShades } from "./png.ts";
import {
  ACID2_FRAMES, ACID2_REF, ACID2_ROM, CGB_ACID2_FRAMES, CGB_ACID2_ROM, COUNTER_ROM, acid2Diff, cgbAcid2Diff, counterHashes,
} from "./smoke.ts";

const DYLIB = process.env.SAMEBOY_LIBRETRO ?? join(homedir(), ".cache/ratchet/tools/SameBoy/build/bin/sameboy_libretro.dylib");
const skip = !existsSync(DYLIB) ? `SameBoy libretro absent at ${DYLIB}` : false;

// counter.gb's background (oracle/fixtures/counter.asm): tile 1, a diagonal
// stripe, in map cells where the asm's 0,1,2,1,2,… sequence is odd.
function counterRow0(scx: number): Uint8Array {
  const cells: number[] = [];
  let c = 0;
  for (let i = 0; i < 32; i++) {
    const a = c++;
    if (a >= 3) c = 1;
    cells.push(a & 1);
  }
  const row = new Uint8Array(160);
  for (let x = 0; x < 160; x++) {
    const px = (x + scx) & 255;
    row[x] = cells[px >> 3] && (px & 7) === 0 ? 3 : 0;
  }
  return row;
}

test("dmg-acid2 emits exactly SameBoy's four greyscale palette values and matches its DMG reference pixel for pixel", { skip: skip || !existsSync(ACID2_ROM) }, async () => {
  const { pixels, colours } = await acid2Diff();
  assert.deepEqual(colours, [0x000000, 0x555555, 0xaaaaaa, 0xffffff]);
  assert.equal(pixels, 0);
});

test("cgb-acid2 under a CGB load matches its RGB reference pixel for pixel", { skip: skip || !existsSync(CGB_ACID2_ROM) }, async () => {
  const { pixels, rgb } = await cgbAcid2Diff();
  assert.equal(rgb.length, RGB_FRAME_BYTES);
  assert.equal(pixels, 0);
});

/** sha256 of the RGB frame at every 10th frame 10..CGB_ACID2_FRAMES of cgb-acid2, on a fresh oracle process. */
async function cgbRgbHashes(): Promise<string[]> {
  const oracle = OracleClient.spawn();
  try {
    await oracle.load(CGB_ACID2_ROM, "frame", "CGB");
    const out: string[] = [];
    for (let n = 10; n <= CGB_ACID2_FRAMES; n += 10) {
      await oracle.runToCounter(n);
      out.push(sha256(await oracle.frameRgb()));
    }
    return out;
  } finally {
    await oracle.close();
  }
}

test("two CGB oracle runs of cgb-acid2 give equal RGB frame hashes at every 10th frame to the compared one", { skip: skip || !existsSync(CGB_ACID2_ROM) }, async () => {
  const [a, b] = await Promise.all([cgbRgbHashes(), cgbRgbHashes()]);
  assert.equal(a.length, CGB_ACID2_FRAMES / 10);
  assert.deepEqual(a, b);
  assert.ok(new Set(a).size > 1, "the frames change through boot");
});

test("each load takes its own model: info reports CGB after a CGB load, and a DMG load after it in the same process still matches dmg-acid2 in shades", { skip: skip || !existsSync(CGB_ACID2_ROM) || !existsSync(ACID2_ROM) }, async () => {
  const oracle = OracleClient.spawn();
  try {
    await oracle.load(CGB_ACID2_ROM, "frame", "CGB");
    await oracle.runToCounter(10);
    assert.equal((await oracle.info()).model, "CGB");
    await oracle.load(ACID2_ROM, "frame");
    await oracle.runToCounter(ACID2_FRAMES);
    assert.equal((await oracle.info()).model, "DMG");
    const shades = await oracle.frame();
    const ref = readPngShades(ACID2_REF).shades;
    assert.deepEqual(shades, ref);
    // frame_rgb on a DMG load is the greyscale expansion of the same frame.
    const rgb = await oracle.frameRgb();
    const GREY = [0xff, 0xaa, 0x55, 0x00];
    for (let i = 0; i < shades.length; i++) for (let c = 0; c < 3; c++) assert.equal(rgb[i * 3 + c], GREY[shades[i]]);
  } finally {
    await oracle.close();
  }
});

test("two oracle runs of counter.gb give equal frame hashes at every counter 1..600", { skip }, async () => {
  const [a, b] = await Promise.all([counterHashes(600), counterHashes(600)]);
  assert.equal(a.length, 600);
  assert.deepEqual(a, b);
  assert.ok(new Set(a).size > 1, "the frames vary with SCX");
});

test("the frame compared at counter n is the one completed before the VBlank that wrote n (counter.gb shows SCX = n-1)", { skip }, async () => {
  const oracle = OracleClient.spawn();
  try {
    await oracle.load(COUNTER_ROM, "counter");
    for (const n of [2, 3, 100, 257, 300]) {
      const r = await oracle.runToCounter(n);
      assert.deepEqual(r, { counter: n, stalled: false });
      const counter = await oracle.ram(0xc0f0, 2);
      assert.equal(counter[0] | (counter[1] << 8), n);
      const row0 = (await oracle.frame()).subarray(0, 160);
      assert.deepEqual(row0, counterRow0((n - 1) & 255), `counter ${n}`);
    }
  } finally {
    await oracle.close();
  }
});

test("restore of a save at counter 100 reproduces the uninterrupted frame at counter 200", { skip }, async () => {
  const oracle = OracleClient.spawn();
  try {
    await oracle.load(COUNTER_ROM, "counter");
    await oracle.runToCounter(100);
    const at100 = sha256(await oracle.frame());
    const state = await oracle.save();
    await oracle.runToCounter(200);
    const straight = sha256(await oracle.frame());
    await oracle.restore(state);
    assert.equal(sha256(await oracle.frame()), at100);
    await oracle.runToCounter(200);
    assert.equal(sha256(await oracle.frame()), straight);
  } finally {
    await oracle.close();
  }
});

test("ram answers WRAM 0xC000-0xDFFF and refuses any address outside it", { skip }, async () => {
  const oracle = OracleClient.spawn();
  try {
    await oracle.load(COUNTER_ROM, "counter");
    assert.equal((await oracle.ram(0xdfff, 1)).length, 1);
    const res = await oracle.request({ op: "ram", addr: 0xff40, len: 1 });
    assert.equal(res.ok, false);
    const info = await oracle.info();
    assert.equal(info.model, "DMG");
    assert.equal(info.core, "SameBoy");
  } finally {
    await oracle.close();
  }
});

test("oracleFrames writes <n>.bin under $RATCHET_CACHE/oracle/<rom_sha>/<trace_sha>/ and serves the same bytes from it", { skip }, async () => {
  const prev = process.env.RATCHET_CACHE;
  process.env.RATCHET_CACHE = mkdtempSync(join(tmpdir(), "ratchet-oracle-"));
  try {
    const trace = { align: "counter" as const, inputs: [{ from_counter: 0, mask: 0 }] };
    const first = await oracleFrames(COUNTER_ROM, trace, [10, 20]);
    const romDir = join(process.env.RATCHET_CACHE, "oracle");
    const [romSha] = readdirSync(romDir);
    const [traceDir] = readdirSync(join(romDir, romSha));
    assert.deepEqual(readdirSync(join(romDir, romSha, traceDir)).sort(), ["10.bin", "20.bin"]);
    const again = await oracleFrames(COUNTER_ROM, trace, [10, 20]);
    assert.deepEqual(again.get(10), first.get(10));
    assert.equal(first.get(20)?.length, 160 * 144);
  } finally {
    if (prev === undefined) delete process.env.RATCHET_CACHE;
    else process.env.RATCHET_CACHE = prev;
  }
});
