// Loads splits.json (SPEC §6.16) and expands each family's globs into scored ROM paths under $RATCHET_ROMS.
// A ROM is scored when it is DMG-compatible, its pass rule is known, and its reference (screenshot rules) exists;
// every other ROM a glob reaches is listed by computeExcluded with its reason. suites/splits.test.ts asserts
// that splits.json's `excluded` equals computeExcluded over the fetched ROMs.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Split, Splits } from "../src/schema.ts";

export const SPLITS_PATH = resolve(import.meta.dirname, "..", "splits.json");

export function romsDir(): string {
  const v = process.env.RATCHET_ROMS;
  return v ? v.replace(/^~(?=\/|$)/, homedir()) : join(homedir(), ".cache", "ratchet", "roms");
}

export function loadSplits(path: string = SPLITS_PATH): Splits {
  return JSON.parse(readFileSync(path, "utf8")) as Splits;
}

/** The pass rule a ROM is scored by (SPEC §2.5), chosen by the suite directory it sits in. */
export type PassRule = "serial" | "registers" | "screenshot";

export function passRule(rom: string): PassRule | null {
  if (rom.startsWith("blargg/")) return "serial";
  if (rom.startsWith("mooneye-test-suite/")) return "registers";
  if (rom.startsWith("mealybug-tearoom-tests/") || rom.startsWith("dmg-acid2/")) return "screenshot";
  return null;
}

/** Expands one glob (`*` within a path segment only) relative to `root`; returns sorted relative paths of files. */
export function expandGlob(root: string, glob: string): string[] {
  const segs = glob.split("/");
  let paths = [""];
  for (const [i, seg] of segs.entries()) {
    const last = i === segs.length - 1;
    const next: string[] = [];
    for (const p of paths) {
      const abs = join(root, p);
      if (!seg.includes("*")) {
        const q = p ? `${p}/${seg}` : seg;
        if (existsSync(join(root, q)) && (last ? statSync(join(root, q)).isFile() : statSync(join(root, q)).isDirectory())) next.push(q);
        continue;
      }
      if (!existsSync(abs)) continue;
      const re = new RegExp("^" + seg.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$");
      for (const name of readdirSync(abs)) {
        if (!re.test(name)) continue;
        const q = p ? `${p}/${name}` : name;
        const st = statSync(join(root, q));
        if (last ? st.isFile() : st.isDirectory()) next.push(q);
      }
    }
    paths = next;
  }
  return paths.sort();
}

/**
 * The model suffix of a Mooneye ROM name (`di_timing-GS.gb` → `GS`), or null for no suffix.
 * Only Mooneye names carry suffixes; Blargg and dmg-acid2 names contain hyphens that are not suffixes.
 */
export function modelSuffix(rom: string): string | null {
  if (!rom.startsWith("mooneye-test-suite/")) return null;
  const stem = basename(rom).replace(/\.gb$/, "");
  const i = stem.lastIndexOf("-");
  return i < 0 ? null : stem.slice(i + 1);
}

/** The reference PNG for a screenshot-rule ROM, or null when none exists. Mealybug: `_dmg_blob.png`, then `_dmg_b.png`. */
export function referencePath(root: string, rom: string): string | null {
  const stem = rom.replace(/\.gb$/, "");
  const candidates = rom.startsWith("dmg-acid2/") ? [`${stem}-dmg.png`] : [`${stem}_dmg_blob.png`, `${stem}_dmg_b.png`];
  for (const c of candidates) if (existsSync(join(root, c))) return c;
  return null;
}

/** Why a ROM is not scored, or null when it is. */
export function exclusionReason(root: string, rom: string, dmgSuffixes: string[]): string | null {
  const rule = passRule(rom);
  if (!rule) return "no pass rule for this suite";
  const sfx = modelSuffix(rom);
  if (sfx !== null && !dmgSuffixes.includes(sfx)) return `model suffix ${sfx} is not DMG-compatible`;
  if (rule === "screenshot" && !referencePath(root, rom)) {
    return rom.startsWith("dmg-acid2/") ? "no -dmg.png reference" : "no _dmg_blob.png or _dmg_b.png reference";
  }
  return null;
}

/** Every ROM a family glob reaches that is not scored, with its reason, sorted by path. */
export function computeExcluded(splits: Splits, root: string = romsDir()): { rom: string; reason: string }[] {
  const out = new Map<string, string>();
  for (const fam of Object.values(splits.families)) {
    for (const g of fam.roms) {
      for (const rom of expandGlob(root, g)) {
        const r = exclusionReason(root, rom, splits.dmg_suffixes);
        if (r) out.set(rom, r);
      }
    }
  }
  return [...out].sort(([a], [b]) => (a < b ? -1 : 1)).map(([rom, reason]) => ({ rom, reason }));
}

/** The scored ROMs of one family: its globs expanded, minus `excluded` and any ROM with an exclusion reason. */
export function familyRoms(splits: Splits, family: string, root: string = romsDir()): string[] {
  const fam = splits.families[family];
  if (!fam) throw new Error(`unknown family ${family}`);
  const excluded = new Set(splits.excluded.map((e) => e.rom));
  const roms = new Set<string>();
  for (const g of fam.roms) {
    for (const rom of expandGlob(root, g)) {
      if (!excluded.has(rom) && exclusionReason(root, rom, splits.dmg_suffixes) === null) roms.add(rom);
    }
  }
  return [...roms].sort();
}

/** Family names in `split`, in splits.json order. */
export function familiesIn(splits: Splits, split: Split): string[] {
  return Object.entries(splits.families).filter(([, f]) => f.split === split).map(([n]) => n);
}
