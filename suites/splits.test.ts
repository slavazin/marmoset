import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Splits } from "../src/schema.ts";
import { computeExcluded, exclusionReason, familiesIn, familyRoms, loadSplits, modelSuffix, referencePath, romsDir } from "./splits.ts";

const ROMS = romsDir();
const skip = existsSync(join(ROMS, "VERSION")) ? false : `ROMs absent at ${ROMS}; run pnpm roms:fetch`;

function tmpRoot(files: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "ratchet-splits-"));
  for (const p of files) { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), ""); }
  return root;
}

test("splits.json names the base, T, H and V families of SPEC §5 S2", () => {
  const s = loadSplits();
  assert.deepEqual(familiesIn(s, "base"), ["blargg", "mooneye:mbc1", "dmg-acid2"]);
  assert.deepEqual(familiesIn(s, "T"), ["mealybug:palette-scroll-bg", "mooneye:instr-timing"]);
  assert.deepEqual(familiesIn(s, "H"), ["mealybug:window", "mooneye:ppu"]);
  assert.deepEqual(familiesIn(s, "V"), ["mealybug:wx-obj", "mooneye:dma-timer-intr"]);
  assert.deepEqual(s.dmg_suffixes, ["GS", "dmgABC", "dmgABCmgb"]);
});

test("splits.json excluded equals computeExcluded over the fetched ROMs", { skip }, () => {
  const s = loadSplits();
  assert.deepEqual(s.excluded, computeExcluded(s));
});

test("family ROM counts on c-sp v7.0: blargg 15, mbc1 12 without multicart, T 9 + 14, H 7 + 12", { skip }, () => {
  const s = loadSplits();
  const n = (f: string) => familyRoms(s, f).length;
  assert.equal(n("blargg"), 15);
  assert.equal(n("mooneye:mbc1"), 12);
  assert.ok(!familyRoms(s, "mooneye:mbc1").some((r) => r.includes("multicart")));
  assert.equal(n("dmg-acid2"), 1);
  assert.equal(n("mealybug:palette-scroll-bg"), 9);
  assert.equal(n("mooneye:instr-timing"), 14);
  assert.equal(n("mealybug:window"), 7);
  assert.equal(n("mooneye:ppu"), 12);
});

test("DMG-compatible means no suffix or a suffix in dmg_suffixes; only Mooneye names carry suffixes", () => {
  const sfx = ["GS", "dmgABC", "dmgABCmgb"];
  assert.equal(modelSuffix("mooneye-test-suite/acceptance/di_timing-GS.gb"), "GS");
  assert.equal(modelSuffix("mooneye-test-suite/acceptance/ei_timing.gb"), null);
  assert.equal(modelSuffix("blargg/cpu_instrs/individual/01-special.gb"), null);
  assert.equal(modelSuffix("dmg-acid2/dmg-acid2.gb"), null);
  const root = tmpRoot([]);
  assert.equal(exclusionReason(root, "mooneye-test-suite/acceptance/di_timing-GS.gb", sfx), null);
  assert.equal(exclusionReason(root, "mooneye-test-suite/acceptance/boot_regs-dmgABC.gb", sfx), null);
  assert.match(exclusionReason(root, "mooneye-test-suite/acceptance/boot_div-dmg0.gb", sfx)!, /dmg0/);
  assert.match(exclusionReason(root, "mooneye-test-suite/misc/boot_regs-cgb.gb", sfx)!, /cgb/);
});

test("Mealybug reference is _dmg_blob.png, falling back to _dmg_b.png; a ROM with neither is excluded with its reason", () => {
  const p = "mealybug-tearoom-tests/ppu/";
  const root = tmpRoot([`${p}a.gb`, `${p}a_dmg_blob.png`, `${p}a_dmg_b.png`, `${p}b.gb`, `${p}b_dmg_b.png`, `${p}c.gb`, `${p}c_cgb_c.png`]);
  assert.equal(referencePath(root, `${p}a.gb`), `${p}a_dmg_blob.png`);
  assert.equal(referencePath(root, `${p}b.gb`), `${p}b_dmg_b.png`);
  assert.equal(referencePath(root, `${p}c.gb`), null);
  const splits: Splits = { version: "t", families: { "mealybug:t": { split: "T", roms: [`${p}*.gb`] } }, dmg_suffixes: [], excluded: [] };
  assert.deepEqual(computeExcluded(splits, root), [{ rom: `${p}c.gb`, reason: "no _dmg_blob.png or _dmg_b.png reference" }]);
  assert.deepEqual(familyRoms(splits, "mealybug:t", root), [`${p}a.gb`, `${p}b.gb`]);
});
