// Replay against cached oracle data, with no oracle process (SPEC §5 S5, G2): tools/replay.ts is its CLI and
// tools/replay.mjs its self-contained bundle. replayFrames runs a core from load through a counter window and
// returns the first counter whose frame (or recorded game-state RAM) differs from the cache, or clean.
// replaySuite reruns a suite incident's ROM; scoreRomList scores one family on an explicit ROM list.
// Truth-maker: lockstep/lockstep.test.ts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CreateCore, Split, SuiteReading, TraceInput } from "../src/schema.ts";
import { ratchetCache, sha256, traceSha } from "../oracle/client.ts";
import { runRom, type Caps, type RomResult } from "../suites/score.ts";
import { bytesEqual, coreGameRam, frameDiff, GAME_RAM, maskAt } from "./diff.ts";
import type { SuiteWindow } from "./evidence.ts";

export type ReplayOutcome =
  | { clean: true; compared: number }
  | { clean: false; counter: number; reason: "frame" | "logic" | "stall"; pixels: number };

export interface FramesReplay {
  rom: Uint8Array;
  align: "counter" | "frame";
  inputs: TraceInput[];
  window: [number, number];
  /** Oracle frame directory; defaults to $RATCHET_CACHE/oracle/<rom_sha>/<trace_sha>. */
  oracleDir?: string;
  /** Oracle game-state RAM per counter, hex; compared where present. */
  oracleRam?: Record<string, string>;
}

export function defaultOracleDir(rom: Uint8Array, align: "counter" | "frame", inputs: TraceInput[]): string {
  const rom_sha = sha256(rom);
  return join(ratchetCache(), "oracle", rom_sha, traceSha({ rom_sha, align, inputs }));
}

export function replayFrames(createCore: CreateCore, r: FramesReplay): ReplayOutcome {
  const dir = r.oracleDir ?? defaultOracleDir(r.rom, r.align, r.inputs);
  const [from, to] = r.window;
  for (let n = from; n <= to; n++) {
    if (!existsSync(join(dir, `${n}.bin`))) throw new Error(`oracle frame ${n} not cached in ${dir}`);
  }
  const core = createCore(r.rom);
  let compared = 0;
  for (let n = 1; n <= to; n++) {
    core.setButtons(maskAt(r.inputs, n - 1));
    const ok = r.align === "counter" ? core.runToCounter(n, GAME_RAM.addr) : (core.runFrame(), true);
    // A stall inside the window is a mismatch too: its stale frame can equal a static oracle frame.
    if (!ok) return { clean: false, counter: n, reason: "stall", pixels: 0 };
    if (n < from) continue;
    compared++;
    const ram = r.oracleRam?.[n];
    if (ram !== undefined && !bytesEqual(coreGameRam((a) => core.read(a)), new Uint8Array(Buffer.from(ram, "hex")))) {
      return { clean: false, counter: n, reason: "logic", pixels: 0 };
    }
    const d = frameDiff(core.frame(), new Uint8Array(readFileSync(join(dir, `${n}.bin`))));
    if (d.pixels) return { clean: false, counter: n, reason: "frame", pixels: d.pixels };
  }
  return { clean: true, compared };
}

export function formatOutcome(o: ReplayOutcome): string {
  if (o.clean) return "clean";
  const what = o.reason === "frame" ? `${o.pixels} pixels` : o.reason === "logic" ? "game-state RAM" : "core stalled";
  return `first mismatch: counter ${o.counter} (${what})`;
}

/** Reruns a suite incident's ROM; clean when it passes. The reading is printed beside the repro for G4 check 1. */
export function replaySuite(createCore: CreateCore, w: SuiteWindow, root: string, caps?: Caps): { clean: boolean; reading: RomResult; repro: RomResult } {
  const reading = runRom(createCore, root, w.rom_rel, caps);
  return { clean: reading.pass, reading, repro: w.repro };
}

/** Scores one family on an explicit ROM list (paths relative to `root`), shaped as a SuiteReading (SPEC §6.8). */
export function scoreRomList(createCore: CreateCore, split: Split, family: string, roms: string[], root: string, caps?: Caps, onRom?: (r: RomResult) => void): SuiteReading {
  const results = roms.map((rom) => {
    const r = runRom(createCore, root, rom, caps);
    onRom?.(r);
    return r;
  });
  const pass = results.filter((r) => r.pass).length;
  return {
    split, family, roms: roms.length, pass, exact: pass,
    pixel_match: results.length ? results.reduce((s, r) => s + r.pixel_match, 0) / results.length : 0,
  };
}
