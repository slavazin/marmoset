// The suite scorer as a function: scoreFamilies runs a core factory over splits.json families and returns
// SuiteReading[] (SPEC §6.8). suites/run.ts is its CLI; S5 bundles this module into tools/replay.mjs.
//
// Pass rules (SPEC §2.5), chosen per ROM by passRule in suites/splits.ts:
//   serial      Blargg: passes when core.serial contains "Passed"; fails when it contains "Failed".
//   registers   Mooneye: at the first LD B,B (opcode 0x40 at PC before a step), passes when
//               B,C,D,E,H,L = 3,5,8,13,21,34.
//   screenshot  Mealybug and dmg-acid2: at the first LD B,B, steps 2 more frames (2 × 70,224 T-cycles, under the
//               caps; not runFrame, which never returns on a core that never reaches LY 144), then compares
//               core.frame() with the reference PNG under SHADE_MAP. Passes on an exact match.
// Per-ROM fields: `exact` is 1 on a pass under any rule; `pixel_match` is the fraction of equal pixels for
// screenshot rules (read from the frame at the cap when LD B,B never comes) and 1 or 0 for the other rules.
// A core that throws fails that ROM; the scorer does not throw for it.
// V (SPEC G6): a ROM that a V family of the repository's splits.json reaches is refused without the vread token,
// under whatever split, family or caller-supplied Splits it arrives, and through runRom directly.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import type { CreateCore, Split, SuiteReading, Splits } from "../src/schema.ts";
import { expandGlob, familiesIn, familyRoms, loadSplits, passRule, referencePath, romsDir, SPLITS_PATH } from "./splits.ts";

/** Wall-clock cap per ROM, in milliseconds (SPEC §5 S2: "A 60-second wall cap per ROM"). */
export const WALL_CAP_MS = 60_000;
/**
 * Emulated-time cap per ROM, in T-cycles: 30 emulated seconds at 4,194,304 Hz. It bounds a core that never
 * reaches its end condition faster than the wall cap. Set above the longest single ROM in the base, T, H and V
 * lists (Blargg individual cpu_instrs ROMs end within a few emulated seconds on hardware); held by review.
 */
export const CYCLE_CAP = 30 * 4_194_304;
/** Steps between wall-clock, cycle-cap and serial checks. */
const CHECK_EVERY = 1024;
/** Frames run after LD B,B before the screenshot (SPEC §2.5). */
export const FRAMES_AFTER_BREAK = 2;
/** T-cycles in one DMG frame (SPEC §2.5). The frames after LD B,B are stepped, so the caps still apply. */
const FRAME_CYCLES = 70_224;
const LD_B_B = 0x40;
const MOONEYE_PASS = [3, 5, 8, 13, 21, 34] as const;

/** The exact reference-colour map (SPEC §5 S2). Any other colour is a ReferenceLoadError. */
export const SHADE_MAP: Readonly<Record<number, number>> = { 0xffffff: 0, 0xaaaaaa: 1, 0x555555: 2, 0x000000: 3 };

export class ReferenceLoadError extends Error {}
export class VReadRefused extends Error {}

/** Decodes a 160×144 reference PNG into shades 0..3 under SHADE_MAP; throws ReferenceLoadError otherwise. */
export function loadReference(path: string): Uint8Array {
  const png = PNG.sync.read(readFileSync(path));
  if (png.width !== 160 || png.height !== 144) throw new ReferenceLoadError(`${path}: ${png.width}x${png.height}, want 160x144`);
  const out = new Uint8Array(160 * 144);
  for (let i = 0; i < out.length; i++) {
    const rgb = (png.data[i * 4] << 16) | (png.data[i * 4 + 1] << 8) | png.data[i * 4 + 2];
    const shade = SHADE_MAP[rgb];
    if (shade === undefined) throw new ReferenceLoadError(`${path}: pixel ${i} colour #${rgb.toString(16).padStart(6, "0")} is outside the shade map`);
    out[i] = shade;
  }
  return out;
}

export interface RomResult {
  rom: string;
  pass: boolean;
  pixel_match: number;
  outcome: "pass" | "fail" | "cap" | "error";
  detail: string;
}

export interface Caps { wallMs: number; cycles: number }

function pixelMatch(frame: Uint8Array, ref: Uint8Array): number {
  let eq = 0;
  for (let i = 0; i < ref.length; i++) if (frame[i] === ref[i]) eq++;
  return eq / ref.length;
}

/** The ROMs under `root` that the repository's splits.json V families reach, before any exclusion. */
export function vRoms(root: string): Set<string> {
  const splits = loadSplits(SPLITS_PATH);
  const out = new Set<string>();
  for (const f of familiesIn(splits, "V")) for (const g of splits.families[f].roms) for (const r of expandGlob(root, g)) out.add(r);
  return out;
}

function refuseV(): never {
  throw new VReadRefused("split V refused: RATCHET_VREAD_TOKEN matches no runs/<id>/vread.lock (loop/vread.ts is V's only reader)");
}

/**
 * Runs one ROM to its pass rule's end condition or a cap. Throws ReferenceLoadError, and VReadRefused for a V ROM
 * without the token, before the core is created; a core's failure is a result, not a throw.
 */
export function runRom(createCore: CreateCore, root: string, rom: string, caps: Caps = { wallMs: WALL_CAP_MS, cycles: CYCLE_CAP }, runsDir?: string): RomResult {
  if (vRoms(root).has(rom) && !vreadAuthorized(process.env.RATCHET_VREAD_TOKEN, runsDir)) refuseV();
  const rule = passRule(rom);
  if (!rule) throw new Error(`no pass rule for ${rom}`);
  let ref: Uint8Array | null = null;
  if (rule === "screenshot") {
    const rp = referencePath(root, rom);
    if (!rp) throw new ReferenceLoadError(`${rom}: no reference`);
    ref = loadReference(join(root, rp));
  }
  const res = (pass: boolean, outcome: RomResult["outcome"], detail: string, pm?: number): RomResult =>
    ({ rom, pass, outcome, detail, pixel_match: pm ?? (pass ? 1 : 0) });
  const frameMatch = (core: { frame(): Uint8Array }): number => {
    try { return pixelMatch(core.frame(), ref!); } catch { return 0; }
  };

  let core;
  try { core = createCore(new Uint8Array(readFileSync(join(root, rom)))); } catch (e) { return res(false, "error", `createCore threw: ${String(e)}`); }
  const deadline = Date.now() + caps.wallMs;
  /** The cycle count at which the screenshot is taken; set at LD B,B under the screenshot rule. */
  let shotAt: number | null = null;
  try {
    for (let n = 1; ; n++) {
      if (shotAt !== null && core.cycles >= shotAt) {
        const pm = frameMatch(core);
        return res(pm === 1, pm === 1 ? "pass" : "fail", `screenshot pixel match ${pm.toFixed(4)}`, pm);
      }
      if (n % CHECK_EVERY === 0) {
        if (rule === "serial") {
          if (core.serial.includes("Passed")) return res(true, "pass", "serial Passed");
          if (core.serial.includes("Failed")) return res(false, "fail", "serial Failed");
        }
        const capped = Date.now() > deadline ? `wall cap ${caps.wallMs} ms` : core.cycles > caps.cycles ? `cycle cap ${caps.cycles}` : null;
        if (capped) return res(false, "cap", capped, ref ? frameMatch(core) : 0);
      }
      if (rule !== "serial" && shotAt === null && core.read(core.cpu.pc) === LD_B_B) {
        if (rule === "registers") {
          const c = core.cpu;
          const regs = [c.b, c.c, c.d, c.e, c.h, c.l];
          const ok = regs.every((v, i) => v === MOONEYE_PASS[i]);
          return res(ok, ok ? "pass" : "fail", `LD B,B regs ${regs.join("/")}`);
        }
        shotAt = core.cycles + FRAMES_AFTER_BREAK * FRAME_CYCLES;
      }
      core.step();
    }
  } catch (e) {
    if (e instanceof ReferenceLoadError) throw e;
    return res(false, "error", `core threw: ${String(e)}`, ref ? frameMatch(core) : 0);
  }
}

/** The token check for V (SPEC §5 S10): true when some `<runsDir>/<id>/vread.lock` first record carries `token`. */
export function vreadAuthorized(token: string | undefined, runsDir: string = resolve(import.meta.dirname, "..", "runs")): boolean {
  if (!token || !existsSync(runsDir)) return false;
  for (const id of readdirSync(runsDir)) {
    const lock = join(runsDir, id, "vread.lock");
    if (!existsSync(lock)) continue;
    const first = readFileSync(lock, "utf8").split("\n").find((l) => l.trim());
    try { if (first && JSON.parse(first).token === token) return true; } catch { /* a malformed lock authorizes nothing */ }
  }
  return false;
}

export interface ScoreOptions {
  split: Split;
  family?: string;
  splits?: Splits;
  root?: string;
  caps?: Caps;
  /** Directory holding runs/<id>/vread.lock; defaults to the repository's runs/. */
  runsDir?: string;
  onRom?: (family: string, r: RomResult) => void;
}

/**
 * Scores every family of `split` (or one, `family`) and returns one SuiteReading per family.
 * Throws VReadRefused for split V, or for a family reaching any splits.json V ROM, unless env
 * RATCHET_VREAD_TOKEN matches a vread.lock token, before any ROM is loaded.
 */
export function scoreFamilies(createCore: CreateCore, opts: ScoreOptions): SuiteReading[] {
  const splits = opts.splits ?? loadSplits();
  const root = opts.root ?? romsDir();
  let fams = familiesIn(splits, opts.split);
  if (opts.family) {
    if (splits.families[opts.family]?.split !== opts.split) throw new Error(`family ${opts.family} is not in split ${opts.split}`);
    fams = [opts.family];
  }
  const famRoms = new Map(fams.map((f) => [f, familyRoms(splits, f, root)]));
  const v = vRoms(root);
  const touchesV = opts.split === "V" || [...famRoms.values()].some((rs) => rs.some((r) => v.has(r)));
  if (touchesV && !vreadAuthorized(process.env.RATCHET_VREAD_TOKEN, opts.runsDir)) refuseV();
  return fams.map((family) => {
    const roms = famRoms.get(family)!;
    const results = roms.map((rom) => {
      const r = runRom(createCore, root, rom, opts.caps, opts.runsDir);
      opts.onRom?.(family, r);
      return r;
    });
    const pass = results.filter((r) => r.pass).length;
    return {
      split: opts.split, family, roms: roms.length, pass, exact: pass,
      pixel_match: results.length ? results.reduce((s, r) => s + r.pixel_match, 0) / results.length : 0,
    };
  });
}
