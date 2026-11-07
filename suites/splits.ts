// Loads splits.json (SPEC §6.16) and expands each family's globs into scored ROM paths under $RATCHET_ROMS.
// A ROM is scored when it is DMG-compatible, its pass rule is known, and its reference (screenshot rules) exists;
// every other ROM a glob reaches is listed by computeExcluded with its reason. suites/splits.test.ts asserts
// that splits.json's `excluded` equals computeExcluded over the fetched ROMs.
// CGB tier (D-0019): splits-cgb.json has the same shape plus a per-family `model`. A family marked "CGB" is scored
// on a core created with { model: "CGB" } against its RGB reference: cgb-acid2/cgb-acid-hell's `<stem>.png`, and
// Mealybug's `_cgb_c.png` (CPU CGB C, the revision oracle/frontend.py runs SameBoy as).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Split, Splits } from "../src/schema.ts";

export const SPLITS_PATH = resolve(import.meta.dirname, "..", "splits.json");
export const SPLITS_CGB_PATH = resolve(import.meta.dirname, "..", "splits-cgb.json");
/** The run that reads V-cgb (D-0019): only a token from runs/<CGB_RUN_ID>/vread.lock opens a CGB-model V ROM. */
export const CGB_RUN_ID = "RUN-0002";

export type Model = "DMG" | "CGB";
/** The hardware a family's ROMs are scored on: its `model` field (splits-cgb.json), else DMG. */
export function familyModel(splits: Splits, family: string): Model {
  return (splits.families[family] as { model?: Model } | undefined)?.model ?? "DMG";
}

export function romsDir(): string {
  const v = process.env.RATCHET_ROMS;
  return v ? v.replace(/^~(?=\/|$)/, homedir()) : join(homedir(), ".cache", "ratchet", "roms");
}

/**
 * The splits files a default loadSplits() reads: RATCHET_SPLITS, comma-separated, each resolved against the repository
 * root, else [SPLITS_PATH]. RUN-0002 sets "splits.json,splits-cgb.json" (D-draft-concurrent-cgb-run; suites/splits.test.ts
 * "RATCHET_SPLITS merges").
 */
export function splitsPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  const v = env.RATCHET_SPLITS?.trim();
  if (!v) return [SPLITS_PATH];
  return v.split(",").map((s) => s.trim()).filter(Boolean).map((s) => resolve(import.meta.dirname, "..", s));
}

/** Merges splits files: families united (a name in two files throws), excluded and dmg_suffixes concatenated. */
export function mergeSplits(all: Splits[]): Splits {
  const out: Splits = { version: all.map((s) => s.version).join("+"), families: {}, dmg_suffixes: [], excluded: [] };
  for (const s of all) {
    for (const [f, fam] of Object.entries(s.families)) {
      if (out.families[f]) throw new Error(`mergeSplits: family ${f} is in two splits files`);
      out.families[f] = fam;
    }
    for (const x of s.dmg_suffixes ?? []) if (!out.dmg_suffixes.includes(x)) out.dmg_suffixes.push(x);
    out.excluded.push(...(s.excluded ?? []));
  }
  return out;
}

/** One splits file at `path`; with no path, splitsPaths() merged (one file reads exactly as loadSplits(SPLITS_PATH)). */
export function loadSplits(path?: string): Splits {
  if (path !== undefined) return JSON.parse(readFileSync(path, "utf8")) as Splits;
  const ps = splitsPaths();
  if (ps.length === 1) return JSON.parse(readFileSync(ps[0], "utf8")) as Splits;
  return mergeSplits(ps.map((p) => JSON.parse(readFileSync(p, "utf8")) as Splits));
}

/** The pass rule a ROM is scored by (SPEC §2.5), chosen by the suite directory it sits in. */
export type PassRule = "serial" | "registers" | "screenshot";

export function passRule(rom: string): PassRule | null {
  if (rom.startsWith("blargg/")) return "serial";
  if (rom.startsWith("mooneye-test-suite/")) return "registers";
  if (["mealybug-tearoom-tests/", "dmg-acid2/", "cgb-acid2/", "cgb-acid-hell/"].some((p) => rom.startsWith(p))) return "screenshot";
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

/** The reference candidates for a screenshot-rule ROM on `model`, in preference order. */
function referenceCandidates(rom: string, model: Model): string[] {
  const stem = rom.replace(/\.gbc?$/, "");
  if (model === "CGB") {
    if (rom.startsWith("cgb-acid2/") || rom.startsWith("cgb-acid-hell/")) return [`${stem}.png`];
    if (rom.startsWith("mealybug-tearoom-tests/")) return [`${stem}_cgb_c.png`];
    return [];
  }
  return rom.startsWith("dmg-acid2/") ? [`${stem}-dmg.png`] : [`${stem}_dmg_blob.png`, `${stem}_dmg_b.png`];
}

/**
 * The reference PNG for a screenshot-rule ROM, or null when none exists. DMG Mealybug: `_dmg_blob.png`, then
 * `_dmg_b.png`. CGB: Mealybug `_cgb_c.png`; cgb-acid2 and cgb-acid-hell `<stem>.png`.
 */
export function referencePath(root: string, rom: string, model: Model = "DMG"): string | null {
  for (const c of referenceCandidates(rom, model)) if (existsSync(join(root, c))) return c;
  return null;
}

/** Why a ROM is not scored on `model`, or null when it is. */
export function exclusionReason(root: string, rom: string, dmgSuffixes: string[], model: Model = "DMG"): string | null {
  const rule = passRule(rom);
  if (!rule) return "no pass rule for this suite";
  const sfx = modelSuffix(rom);
  if (model === "CGB" && rom.startsWith("mooneye-test-suite/")) return "the CGB tier has no Mooneye model-suffix rule";
  if (sfx !== null && !dmgSuffixes.includes(sfx)) return `model suffix ${sfx} is not DMG-compatible`;
  if (rule === "screenshot" && !referencePath(root, rom, model)) {
    if (model === "CGB") return rom.startsWith("mealybug-tearoom-tests/") ? "no _cgb_c.png reference" : "no .png reference";
    return rom.startsWith("dmg-acid2/") ? "no -dmg.png reference" : "no _dmg_blob.png or _dmg_b.png reference";
  }
  return null;
}

/** Every ROM a family glob reaches that is not scored, with its reason, sorted by path. */
export function computeExcluded(splits: Splits, root: string = romsDir()): { rom: string; reason: string }[] {
  const out = new Map<string, string>();
  for (const [name, fam] of Object.entries(splits.families)) {
    for (const g of fam.roms) {
      for (const rom of expandGlob(root, g)) {
        const r = exclusionReason(root, rom, splits.dmg_suffixes, familyModel(splits, name));
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
      if (!excluded.has(rom) && exclusionReason(root, rom, splits.dmg_suffixes, familyModel(splits, family)) === null) roms.add(rom);
    }
  }
  return [...roms].sort();
}

/** Family names in `split`, in splits.json order. */
export function familiesIn(splits: Splits, split: Split): string[] {
  return Object.entries(splits.families).filter(([, f]) => f.split === split).map(([n]) => n);
}
