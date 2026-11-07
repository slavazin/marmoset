import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import type { Core, CreateCore, Splits } from "../src/schema.ts";
import { createCore as nopCore } from "./fixtures/nop-core/index.ts";
import { createCore as cgbNopCore } from "./fixtures/cgb-nop-core/index.ts";
import { loadReference, loadReferenceRgb, ReferenceLoadError, runRom, scoreFamilies, VReadRefused, vreadAuthorized } from "./score.ts";
import { CGB_RUN_ID, loadSplits, romsDir, SPLITS_CGB_PATH } from "./splits.ts";

const ROMS = romsDir();
const haveRoms = existsSync(join(ROMS, "VERSION"));
const skip = haveRoms ? false : `ROMs absent at ${ROMS}; run pnpm roms:fetch`;
const FAST = { wallMs: 60_000, cycles: 4_194_304 };

/** A fixture core built on the NOP core with overrides for one pass-rule test. */
function fixture(over: (c: Core) => void): CreateCore {
  return (rom) => { const c = nopCore(rom); over(c); return c; };
}

function tmpRoot(files: Record<string, Uint8Array | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), "ratchet-suites-"));
  for (const [p, b] of Object.entries(files)) { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), b); }
  return root;
}

function png(fill: [number, number, number]): Buffer {
  const img = new PNG({ width: 160, height: 144 });
  for (let i = 0; i < 160 * 144; i++) img.data.set([...fill, 255], i * 4);
  return PNG.sync.write(img);
}

test("NOP fixture core scores 0 passes on base, T and H without throwing", { skip }, () => {
  for (const split of ["base", "T", "H"] as const) {
    const readings = scoreFamilies(nopCore, { split, caps: FAST });
    assert.ok(readings.length >= 2, `${split} has families`);
    for (const r of readings) {
      assert.equal(r.pass, 0, `${r.family} pass`);
      assert.equal(r.exact, 0, `${r.family} exact`);
      assert.ok(r.roms > 0, `${r.family} has ROMs`);
    }
  }
});

test("shade map on dmg-acid2's reference PNG yields only shades 0-3", { skip }, () => {
  const ref = loadReference(join(ROMS, "dmg-acid2/dmg-acid2-dmg.png"));
  assert.equal(ref.length, 160 * 144);
  const seen = new Set(ref);
  for (const s of seen) assert.ok(s >= 0 && s <= 3, `shade ${s}`);
  assert.deepEqual([...seen].sort(), [0, 1, 2, 3]);
});

test("a reference colour outside the shade map is a ReferenceLoadError", () => {
  const root = tmpRoot({ "bad.png": png([0x56, 0x55, 0x55]) });
  assert.throws(() => loadReference(join(root, "bad.png")), ReferenceLoadError);
});

test("Mooneye rule passes only on B,C,D,E,H,L = 3/5/8/13/21/34 at LD B,B", () => {
  const rom = new Uint8Array(0x8000); rom[0x200] = 0x40;
  const root = tmpRoot({ "mooneye-test-suite/acceptance/x.gb": rom });
  const fib = fixture((c) => Object.assign(c.cpu, { b: 3, c: 5, d: 8, e: 13, h: 21, l: 34 }));
  assert.equal(runRom(fib, root, "mooneye-test-suite/acceptance/x.gb", FAST).pass, true);
  const fail = fixture((c) => Object.assign(c.cpu, { b: 0x42, c: 0x42, d: 0x42, e: 0x42, h: 0x42, l: 0x42 }));
  const r = runRom(fail, root, "mooneye-test-suite/acceptance/x.gb", FAST);
  assert.equal(r.pass, false);
  assert.equal(r.outcome, "fail");
});

test("Blargg rule passes on serial Passed and fails on serial Failed", () => {
  const root = tmpRoot({ "blargg/x.gb": new Uint8Array(0x8000) });
  assert.equal(runRom(fixture((c) => { c.serial = "x\nPassed\n"; }), root, "blargg/x.gb", FAST).pass, true);
  const r = runRom(fixture((c) => { c.serial = "Failed #2"; }), root, "blargg/x.gb", FAST);
  assert.equal(r.outcome, "fail");
});

test("screenshot rule passes on an exact frame 2 frames after LD B,B; pixel_match reads the fraction", { skip }, () => {
  const rom = new Uint8Array(0x8000); rom[0x150] = 0x40;
  const ref = loadReference(join(ROMS, "dmg-acid2/dmg-acid2-dmg.png"));
  const root = tmpRoot({ "dmg-acid2/dmg-acid2.gb": rom, "dmg-acid2/dmg-acid2-dmg.png": readFileSync(join(ROMS, "dmg-acid2/dmg-acid2-dmg.png")) });
  let breakAt = -1, shotAt = -1;
  const good = fixture((c) => { c.frame = () => { shotAt = c.cycles; return ref; }; const s = c.step; c.step = () => { if (c.cpu.pc === 0x150 && breakAt < 0) breakAt = c.cycles; s(); }; });
  const r = runRom(good, root, "dmg-acid2/dmg-acid2.gb", FAST);
  assert.equal(r.pass, true);
  assert.equal(r.pixel_match, 1);
  assert.equal(shotAt - breakAt, 2 * 70_224);
  const half = ref.slice(); for (let i = 0; i < half.length / 2; i++) half[i] = (half[i] + 1) & 3;
  const r2 = runRom(fixture((c) => { c.frame = () => half; }), root, "dmg-acid2/dmg-acid2.gb", FAST);
  assert.equal(r2.pass, false);
  assert.equal(r2.pixel_match, 0.5);
});

test("a core that never ends is stopped by the wall cap and the ROM fails", () => {
  const root = tmpRoot({ "blargg/x.gb": new Uint8Array(0x8000) });
  const stuck = fixture((c) => { c.step = () => {}; });
  const t0 = Date.now();
  const r = runRom(stuck, root, "blargg/x.gb", { wallMs: 100, cycles: Infinity });
  assert.equal(r.outcome, "cap");
  assert.ok(Date.now() - t0 < 5_000);
});

test("a core that throws fails its ROM and the scorer does not throw", () => {
  const root = tmpRoot({ "mooneye-test-suite/x.gb": new Uint8Array(0x8000) });
  const r = runRom(fixture((c) => { c.step = () => { throw new Error("unimplemented opcode"); }; }), root, "mooneye-test-suite/x.gb", FAST);
  assert.equal(r.outcome, "error");
  assert.equal(r.pass, false);
});

test("split V is refused without a RATCHET_VREAD_TOKEN matching a vread.lock, before any core is created", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "ratchet-runs-"));
  const splits: Splits = { version: "t", families: { "v:x": { split: "V", roms: ["blargg/*.gb"] } }, dmg_suffixes: [], excluded: [] };
  let created = 0;
  const counting: CreateCore = (rom) => { created++; return nopCore(rom); };
  const saved = process.env.RATCHET_VREAD_TOKEN;
  try {
    delete process.env.RATCHET_VREAD_TOKEN;
    assert.throws(() => scoreFamilies(counting, { split: "V", splits, runsDir }), VReadRefused);
    mkdirSync(join(runsDir, "RUN-0001"));
    writeFileSync(join(runsDir, "RUN-0001", "vread.lock"), JSON.stringify({ run: "RUN-0001", at: "2026-11-07T15:45:00Z", token: "tok-a" }) + "\n");
    process.env.RATCHET_VREAD_TOKEN = "tok-b";
    assert.throws(() => scoreFamilies(counting, { split: "V", splits, runsDir }), VReadRefused);
    assert.equal(created, 0);
    assert.equal(vreadAuthorized("tok-a", runsDir), true);
    assert.equal(vreadAuthorized("tok-b", runsDir), false);
    assert.equal(vreadAuthorized(undefined, runsDir), false);
  } finally {
    if (saved === undefined) delete process.env.RATCHET_VREAD_TOKEN; else process.env.RATCHET_VREAD_TOKEN = saved;
  }
});

test("a ROM in a splits.json V family is refused without the token through runRom and through a caller's relabelled splits, before any core is created", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "ratchet-runs-"));
  const vRom = "mooneye-test-suite/acceptance/oam_dma/basic.gb";
  const root = tmpRoot({ [vRom]: new Uint8Array(0x8000) });
  let created = 0;
  const counting: CreateCore = (rom) => { created++; return nopCore(rom); };
  const relabelled: Splits = { version: "t", families: { x: { split: "base", roms: ["mooneye-test-suite/acceptance/oam_dma/*.gb"] } }, dmg_suffixes: [], excluded: [] };
  const saved = process.env.RATCHET_VREAD_TOKEN;
  try {
    delete process.env.RATCHET_VREAD_TOKEN;
    assert.throws(() => runRom(counting, root, vRom, FAST, runsDir), VReadRefused);
    assert.throws(() => scoreFamilies(counting, { split: "base", splits: relabelled, root, caps: FAST, runsDir }), VReadRefused);
    assert.equal(created, 0);
  } finally {
    if (saved === undefined) delete process.env.RATCHET_VREAD_TOKEN; else process.env.RATCHET_VREAD_TOKEN = saved;
  }
});

test("a V ROM named by an aliased path (dot segment, parent segment, symlink, letter case) is refused through runRom before any core is created", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "ratchet-runs-"));
  const vRom = "mooneye-test-suite/acceptance/oam_dma/basic.gb";
  const root = tmpRoot({ [vRom]: new Uint8Array(0x8000) });
  symlinkSync(join(root, vRom), join(root, "mooneye-test-suite/acceptance/alias.gb"));
  const aliases = [
    "mooneye-test-suite/./acceptance/oam_dma/basic.gb",
    "mooneye-test-suite/acceptance/../acceptance/oam_dma/basic.gb",
    "mooneye-test-suite/acceptance//oam_dma/basic.gb",
    "mooneye-test-suite/acceptance/alias.gb",
  ];
  // On a case-insensitive file system (APFS default) another letter case opens the same file.
  if (existsSync(join(root, "mooneye-test-suite/acceptance/OAM_DMA/basic.gb"))) aliases.push("mooneye-test-suite/acceptance/OAM_DMA/basic.gb");
  let created = 0;
  const counting: CreateCore = (rom) => { created++; return nopCore(rom); };
  const saved = process.env.RATCHET_VREAD_TOKEN;
  try {
    delete process.env.RATCHET_VREAD_TOKEN;
    for (const a of aliases) assert.throws(() => runRom(counting, root, a, FAST, runsDir), VReadRefused, a);
    assert.equal(created, 0);
  } finally {
    if (saved === undefined) delete process.env.RATCHET_VREAD_TOKEN; else process.env.RATCHET_VREAD_TOKEN = saved;
  }
});

test("the 2 frames after LD B,B are stepped under the wall cap, so a core whose runFrame never returns still ends", () => {
  const rom = new Uint8Array(0x8000); rom[0x150] = 0x40;
  const root = tmpRoot({ "dmg-acid2/dmg-acid2.gb": rom, "dmg-acid2/dmg-acid2-dmg.png": png([0xff, 0xff, 0xff]) });
  // runFrame runs until LY 143 -> 144 (SPEC §6.1); on a core whose LCD never gets there it does not return.
  const noFrame = fixture((c) => { c.runFrame = () => { throw new Error("runFrame called"); }; });
  const r = runRom(noFrame, root, "dmg-acid2/dmg-acid2.gb", FAST);
  assert.equal(r.outcome, "pass", r.detail);
  const stalled = fixture((c) => { const s = c.step; c.step = () => { if (c.cpu.pc < 0x150) s(); }; });
  const t0 = Date.now();
  const cap = runRom(stalled, root, "dmg-acid2/dmg-acid2.gb", { wallMs: 100, cycles: Infinity });
  assert.equal(cap.outcome, "cap");
  assert.ok(Date.now() - t0 < 5_000);
});

// --- CGB tier (D-0019) ---------------------------------------------------------------------------------------

function withToken<T>(token: string | undefined, fn: () => T): T {
  const saved = process.env.RATCHET_VREAD_TOKEN;
  try {
    if (token === undefined) delete process.env.RATCHET_VREAD_TOKEN; else process.env.RATCHET_VREAD_TOKEN = token;
    return fn();
  } finally {
    if (saved === undefined) delete process.env.RATCHET_VREAD_TOKEN; else process.env.RATCHET_VREAD_TOKEN = saved;
  }
}

function lock(runsDir: string, run: string, token: string): void {
  mkdirSync(join(runsDir, run), { recursive: true });
  writeFileSync(join(runsDir, run, "vread.lock"), JSON.stringify({ run, at: "2026-11-07T15:45:00Z", token }) + "\n");
}

const cgbSplits = (): Splits => loadSplits(SPLITS_CGB_PATH);

test("CGB NOP fixture core scores 0 passes on the CGB base, T and H families without throwing, each core created with model CGB", { skip }, () => {
  const models: (string | undefined)[] = [];
  const spy: CreateCore = (rom, opts) => { models.push(opts?.model); return cgbNopCore(rom, opts); };
  for (const split of ["base", "T", "H"] as const) {
    const readings = scoreFamilies(spy, { split, splits: cgbSplits(), caps: FAST });
    assert.ok(readings.length >= 1, `${split} has families`);
    for (const r of readings) {
      assert.equal(r.pass, 0, `${r.family} pass`);
      assert.ok(r.roms > 0, `${r.family} has ROMs`);
    }
  }
  assert.ok(models.length > 0);
  assert.ok(models.every((m) => m === "CGB"), `models ${[...new Set(models)]}`);
});

test("a DMG-only core (no frameRgb) scores 0 on every CGB base and H ROM with detail \"no CGB support\" and does not throw", { skip }, () => {
  const details: string[] = [];
  for (const split of ["base", "H"] as const) {
    const readings = scoreFamilies(nopCore, { split, splits: cgbSplits(), caps: FAST, onRom: (_f, r) => details.push(r.detail) });
    for (const r of readings) { assert.equal(r.pass, 0); assert.equal(r.pixel_match, 0); }
  }
  assert.ok(details.length >= 2);
  assert.ok(details.every((d) => d === "no CGB support"), details.join("; "));
});

test("a CGB ROM passes when frameRgb equals its RGB reference exactly and fails with one channel of one pixel off", () => {
  const rom = new Uint8Array(0x8000); rom[0x150] = 0x40;
  const colour: [number, number, number] = [0x10, 0x84, 0xff];
  const root = tmpRoot({ "cgb-acid2/cgb-acid2.gbc": rom, "cgb-acid2/cgb-acid2.png": png(colour) });
  const want = new Uint8Array(160 * 144 * 3);
  for (let i = 0; i < 160 * 144; i++) want.set(colour, i * 3);
  assert.deepEqual(loadReferenceRgb(join(root, "cgb-acid2/cgb-acid2.png")), want);
  const good: CreateCore = (r, o) => { const c = cgbNopCore(r, o); c.frameRgb = () => want; return c; };
  const ok = runRom(good, root, "cgb-acid2/cgb-acid2.gbc", FAST, undefined, "CGB");
  assert.equal(ok.outcome, "pass", ok.detail);
  const off = want.slice(); off[5] ^= 1;
  const bad: CreateCore = (r, o) => { const c = cgbNopCore(r, o); c.frameRgb = () => off; return c; };
  const r = runRom(bad, root, "cgb-acid2/cgb-acid2.gbc", FAST, undefined, "CGB");
  assert.equal(r.outcome, "fail");
  assert.equal(r.pixel_match, (160 * 144 - 1) / (160 * 144));
});

test("split V of splits-cgb.json is refused without a token from runs/RUN-0002/vread.lock (a RUN-0001 token does not open it), before any core is created", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "ratchet-runs-"));
  let created = 0;
  const counting: CreateCore = (rom, o) => { created++; return cgbNopCore(rom, o); };
  lock(runsDir, "RUN-0001", "tok-dmg");
  withToken(undefined, () => assert.throws(() => scoreFamilies(counting, { split: "V", splits: cgbSplits(), runsDir }), VReadRefused));
  withToken("tok-dmg", () => assert.throws(() => scoreFamilies(counting, { split: "V", splits: cgbSplits(), runsDir }), VReadRefused));
  assert.equal(created, 0);
  lock(runsDir, CGB_RUN_ID, "tok-cgb");
  assert.equal(vreadAuthorized("tok-cgb", runsDir, CGB_RUN_ID), true);
  assert.equal(vreadAuthorized("tok-dmg", runsDir, CGB_RUN_ID), false);
});

test("a V-cgb ROM path is refused through runRom on CGB without the RUN-0002 token, by real path, and runs with it", () => {
  const runsDir = mkdtempSync(join(tmpdir(), "ratchet-runs-"));
  const vRom = "mealybug-tearoom-tests/ppu/m3_lcdc_obj_en_change.gb";
  const rom = new Uint8Array(0x8000); rom[0x150] = 0x40;
  const root = tmpRoot({ [vRom]: rom, [vRom.replace(/\.gb$/, "_cgb_c.png")]: png([0, 0, 0]) });
  let created = 0;
  const counting: CreateCore = (r, o) => { created++; return cgbNopCore(r, o); };
  lock(runsDir, "RUN-0001", "tok-dmg");
  lock(runsDir, CGB_RUN_ID, "tok-cgb");
  const alias = "mealybug-tearoom-tests/./ppu/m3_lcdc_obj_en_change.gb";
  withToken("tok-dmg", () => {
    assert.throws(() => runRom(counting, root, vRom, FAST, runsDir, "CGB"), VReadRefused);
    assert.throws(() => runRom(counting, root, alias, FAST, runsDir, "CGB"), VReadRefused);
  });
  assert.equal(created, 0);
  // This root's file is a synthetic stand-in, so running it reads nothing of V-cgb.
  const r = withToken("tok-cgb", () => runRom(counting, root, vRom, FAST, runsDir, "CGB"));
  assert.equal(r.outcome, "pass", r.detail);
  assert.equal(created, 1);
});
