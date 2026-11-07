// Incident evidence under evidence/incidents/<id>/ (SPEC §6.5): core.png, oracle.png, diff.png,
// regwrites.jsonl and window.json. window.json is what tools/replay.mjs reads to rerun the incident.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PNG } from "pngjs";
import type { Incident, TraceInput } from "../src/schema.ts";
import type { RomResult } from "../suites/score.ts";
import { HEIGHT, WIDTH } from "./diff.ts";

export const EVIDENCE_ROOT = resolve(import.meta.dirname, "..", "evidence", "incidents");

/** Shade 0..3 → RGB, the inverse of suites/score.ts SHADE_MAP. */
const RGB = [0xffffff, 0xaaaaaa, 0x555555, 0x000000];
/** diff.png marks a differing pixel in this colour over the oracle frame. */
const DIFF_RGB = 0xff0000;

export interface FrameWindow {
  kind: "frames";
  incident: Incident;
  rom: { path: string; sha: string };
  trace: { align: "counter" | "frame"; inputs: TraceInput[]; counter_end: number };
  /** The directory holding the cached oracle frames <n>.bin for this trace (oracle/client.ts oracleFrames layout). */
  oracle_dir: string;
  /** Oracle game-state RAM per window counter, hex: the game's mapped bytes (lockstep/games.ts mappedRam; GAME_RAM for a §6.17 game). */
  oracle_ram: Record<string, string>;
  /** Present for a ROM with a registry map (lockstep/games.ts): the ranges oracle_ram concatenates. */
  map?: { game: string; logic: { addr: number; len: number }[] };
  /** Present when both sides started from a start state (lockstep/start-state.ts): its cache file and that file's sha256. */
  start?: { file: string; sha: string; key: string };
}
export interface SuiteWindow {
  kind: "suite";
  incident: Incident;
  rom: { path: string; sha: string };
  family: string;
  /** The ROM's path relative to $RATCHET_ROMS, as splits.json lists it. */
  rom_rel: string;
  /** The reading the incident was opened on; G4 check 1 compares a repair against it. */
  repro: RomResult;
  /** The hardware the ROM is scored on (suites/splits.ts familyModel); absent reads DMG (lockstep/replay.ts replaySuite). */
  model?: "DMG" | "CGB";
}
export type WindowFile = FrameWindow | SuiteWindow;

function png(shades: Uint8Array, mark?: Uint8Array): Buffer {
  const p = new PNG({ width: WIDTH, height: HEIGHT });
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    const rgb = mark && mark[i] !== shades[i] ? DIFF_RGB : RGB[shades[i] & 3];
    p.data[i * 4] = rgb >> 16; p.data[i * 4 + 1] = (rgb >> 8) & 255; p.data[i * 4 + 2] = rgb & 255; p.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(p);
}

/** A PNG of a 160×144 RGB888 frame; a pixel where `mark` differs from `rgb` is DIFF_RGB (CGB evidence, D-0019). */
function pngRgb(rgb: Uint8Array, mark?: Uint8Array): Buffer {
  const p = new PNG({ width: WIDTH, height: HEIGHT });
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    const k = i * 3;
    const diff = mark && (mark[k] !== rgb[k] || mark[k + 1] !== rgb[k + 1] || mark[k + 2] !== rgb[k + 2]);
    p.data[i * 4] = diff ? DIFF_RGB >> 16 : rgb[k]; p.data[i * 4 + 1] = diff ? (DIFF_RGB >> 8) & 255 : rgb[k + 1];
    p.data[i * 4 + 2] = diff ? DIFF_RGB & 255 : rgb[k + 2]; p.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(p);
}

export interface RegWrite { addr: number; value: number; ly: number; dot: number; cycles: number }

/**
 * Writes an incident's evidence files. `core` and `oracle` are shade frames (160×144, 0..3), or RGB888 frames
 * (160×144×3) when `rgb` is true (a CGB suite incident; lockstep/lockstep.test.ts "CGB suite incident").
 */
export function writeEvidence(dir: string, w: WindowFile, core: Uint8Array | null, oracle: Uint8Array | null, regwrites: RegWrite[], rgb = false): void {
  mkdirSync(dir, { recursive: true });
  const draw = rgb ? pngRgb : png;
  if (core) writeFileSync(join(dir, "core.png"), draw(core));
  if (oracle) writeFileSync(join(dir, "oracle.png"), draw(oracle));
  if (core && oracle) writeFileSync(join(dir, "diff.png"), draw(oracle, core));
  writeFileSync(join(dir, "regwrites.jsonl"), regwrites.map((r) => JSON.stringify(r) + "\n").join(""));
  writeFileSync(join(dir, "window.json"), JSON.stringify(w, null, 2) + "\n");
}

export function readWindow(dir: string): WindowFile {
  return JSON.parse(readFileSync(join(dir, "window.json"), "utf8")) as WindowFile;
}
