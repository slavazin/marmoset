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
// CGB tier (D-0019): a family whose `model` is "CGB" (splits-cgb.json) creates its core with { model: "CGB" } and
// compares core.frameRgb() with the reference's RGB888 exactly, with no shade map. A core without frameRgb scores 0
// on that ROM with detail "no CGB support". On a CGB-model run, a ROM that any V family of splits.json or
// splits-cgb.json reaches is refused unless the token matches runs/RUN-0002/vread.lock (CGB_RUN_ID).
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import type { Core, CreateCore, Split, SuiteReading, Splits } from "../src/schema.ts";
import {
  CGB_RUN_ID, expandGlob, familiesIn, familyModel, familyRoms, loadSplits, passRule, referencePath, romsDir, SPLITS_CGB_PATH, SPLITS_PATH,
  type Model,
} from "./splits.ts";

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

/** Decodes a 160×144 reference PNG into RGB888 (160*144*3 bytes), colours exactly as stored; for CGB references. */
export function loadReferenceRgb(path: string): Uint8Array {
  const png = PNG.sync.read(readFileSync(path));
  if (png.width !== 160 || png.height !== 144) throw new ReferenceLoadError(`${path}: ${png.width}x${png.height}, want 160x144`);
  const out = new Uint8Array(160 * 144 * 3);
  for (let i = 0; i < 160 * 144; i++) {
    out[i * 3] = png.data[i * 4];
    out[i * 3 + 1] = png.data[i * 4 + 1];
    out[i * 3 + 2] = png.data[i * 4 + 2];
  }
  return out;
}

/** The fraction of pixels whose R, G and B all equal the reference's. */
function rgbPixelMatch(frame: Uint8Array, ref: Uint8Array): number {
  if (frame.length !== ref.length) return 0;
  let eq = 0;
  for (let i = 0; i < ref.length; i += 3) if (frame[i] === ref[i] && frame[i + 1] === ref[i + 1] && frame[i + 2] === ref[i + 2]) eq++;
  return eq / (ref.length / 3);
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
  const out = new Set<string>();
  for (const g of vGlobs()) for (const r of expandGlob(root, g)) out.add(r);
  return out;
}

/**
 * V's ROM globs, set by lockstep/build-replay.ts from splits.json when it bundles tools/replay.mjs, so the bundle
 * refuses V in a scratch repo that holds no splits.json (SPEC §5 S8). Undefined when this module runs unbundled.
 */
declare const __RATCHET_V_GLOBS__: string[] | undefined;

/** V's ROM globs: from the repository's splits.json, else the ones bundled into tools/replay.mjs; throws with neither. */
export function vGlobs(): string[] {
  if (existsSync(SPLITS_PATH)) {
    const splits = loadSplits(SPLITS_PATH);
    return familiesIn(splits, "V").flatMap((f) => splits.families[f].roms);
  }
  if (typeof __RATCHET_V_GLOBS__ !== "undefined") return __RATCHET_V_GLOBS__;
  throw new Error(`${SPLITS_PATH} absent and no V globs bundled: V cannot be refused, so nothing is scored`);
}

/** V-cgb's ROM globs: the V families of the repository's splits-cgb.json, or none when that file is absent. */
export function cgbVGlobs(): string[] {
  if (!existsSync(SPLITS_CGB_PATH)) return [];
  const splits = loadSplits(SPLITS_CGB_PATH);
  return familiesIn(splits, "V").flatMap((f) => splits.families[f].roms);
}

/** The ROMs under `root` that a CGB-model run refuses without the RUN-0002 token: V and V-cgb together. */
export function cgbVRoms(root: string): Set<string> {
  const out = vRoms(root);
  for (const g of cgbVGlobs()) for (const r of expandGlob(root, g)) out.add(r);
  return out;
}

/** A file's real path (symlinks, dot segments and letter case resolved), or null when it does not exist. */
function realPath(p: string): string | null {
  try { return realpathSync.native(p); } catch { return null; }
}

/** True when `rom` under `root`, however spelled, opens the same file as a ROM of `set`. */
function inSetByRealPath(root: string, rom: string, set: Set<string>): boolean {
  const target = realPath(join(root, rom));
  if (target === null) return false;
  for (const r of set) if (realPath(join(root, r)) === target) return true;
  return false;
}

function refuseV(): never {
  throw new VReadRefused("split V refused: RATCHET_VREAD_TOKEN matches no runs/<id>/vread.lock (loop/vread.ts is V's only reader)");
}

function refuseVCgb(): never {
  throw new VReadRefused(`split V-cgb refused: RATCHET_VREAD_TOKEN does not match runs/${CGB_RUN_ID}/vread.lock (loop/vread.ts is V's only reader)`);
}

/**
 * Refuses `rom` on `model` when it is a V ROM (by real path) and the token does not open it. On CGB, V and V-cgb
 * need the RUN-0002 token. On DMG, a splits.json V ROM needs any run's token (RUN-0001 reads V on DMG, D-0019),
 * and a V-cgb ROM that is not also in V needs the RUN-0002 token.
 */
function guardV(root: string, rom: string, model: Model, runsDir?: string): void {
  const token = process.env.RATCHET_VREAD_TOKEN;
  const inV = inSetByRealPath(root, rom, vRoms(root));
  if (model === "CGB") {
    if ((inV || inSetByRealPath(root, rom, cgbVRoms(root))) && !vreadAuthorized(token, runsDir, CGB_RUN_ID)) refuseVCgb();
    return;
  }
  if (inV) { if (!vreadAuthorized(token, runsDir)) refuseV(); return; }
  if (inSetByRealPath(root, rom, cgbVRoms(root)) && !vreadAuthorized(token, runsDir, CGB_RUN_ID)) refuseVCgb();
}

/**
 * Runs one ROM to its pass rule's end condition or a cap. Throws ReferenceLoadError, and VReadRefused for a V ROM
 * without the token, before the core is created; a core's failure is a result, not a throw.
 */
export function runRom(
  createCore: CreateCore, root: string, rom: string, caps: Caps = { wallMs: WALL_CAP_MS, cycles: CYCLE_CAP }, runsDir?: string,
  model: Model = "DMG",
): RomResult {
  guardV(root, rom, model, runsDir);
  const rule = passRule(rom);
  if (!rule) throw new Error(`no pass rule for ${rom}`);
  let ref: Uint8Array | null = null;
  if (rule === "screenshot") {
    const rp = referencePath(root, rom, model);
    if (!rp) throw new ReferenceLoadError(`${rom}: no reference`);
    ref = model === "CGB" ? loadReferenceRgb(join(root, rp)) : loadReference(join(root, rp));
  }
  const res = (pass: boolean, outcome: RomResult["outcome"], detail: string, pm?: number): RomResult =>
    ({ rom, pass, outcome, detail, pixel_match: pm ?? (pass ? 1 : 0) });
  const frameMatch = (core: Core): number => {
    try { return model === "CGB" ? rgbPixelMatch(core.frameRgb!(), ref!) : pixelMatch(core.frame(), ref!); } catch { return 0; }
  };

  let core: Core;
  try {
    const bytes = new Uint8Array(readFileSync(join(root, rom)));
    core = model === "CGB" ? createCore(bytes, { model: "CGB" }) : createCore(bytes);
  } catch (e) { return res(false, "error", `createCore threw: ${String(e)}`); }
  if (model === "CGB" && typeof core.frameRgb !== "function") return res(false, "error", "no CGB support");
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
/** With `runId`, only `<runsDir>/<runId>/vread.lock` is read. */
export function vreadAuthorized(token: string | undefined, runsDir: string = resolve(import.meta.dirname, "..", "runs"), runId?: string): boolean {
  if (!token || !existsSync(runsDir)) return false;
  for (const id of runId ? [runId] : readdirSync(runsDir)) {
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
  const cgbFams = fams.filter((f) => familyModel(splits, f) === "CGB");
  const dmgFams = fams.filter((f) => familyModel(splits, f) === "DMG");
  const token = process.env.RATCHET_VREAD_TOKEN;
  if (cgbFams.length) {
    const cv = cgbVRoms(root);
    const touchesCgbV = opts.split === "V" || cgbFams.some((f) => famRoms.get(f)!.some((r) => cv.has(r)));
    if (touchesCgbV && !vreadAuthorized(token, opts.runsDir, CGB_RUN_ID)) refuseVCgb();
  }
  if (dmgFams.length) {
    const v = vRoms(root);
    const touchesV = opts.split === "V" || dmgFams.some((f) => famRoms.get(f)!.some((r) => v.has(r)));
    if (touchesV && !vreadAuthorized(token, opts.runsDir)) refuseV();
  }
  return fams.map((family) => {
    const roms = famRoms.get(family)!;
    const model = familyModel(splits, family);
    const results = roms.map((rom) => {
      const r = runRom(createCore, root, rom, opts.caps, opts.runsDir, model);
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
