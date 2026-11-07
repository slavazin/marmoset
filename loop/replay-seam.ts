// The repro seam the gate replays through (SPEC §5 S8; G4 checks 1 and 2). `toolReplayer(root)` runs main's
// tools/replay.mjs (S5) as a child process on a core directory:
//   incident: --incident <id> --core-dir <dir> --evidence-dir <evidence/incidents/<id>> [--rom <path>]
//   trace:    --trace <TRC-id> --core-dir <dir> --rom <path> --traces-dir <traces/>
// with RATCHET_CACHE set to the loop's cache, so it reads the cached oracle frames. Exit 0 reads clean, 1 a
// mismatch, 2 missing data; the printed line is the reading. A suite incident's fail line carries the pixel
// match and the repro's, from which the gate reads the gain against SUITE_MIN_GAIN.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { CreateCore } from "../src/schema.ts";

export interface ReplayReading { clean: boolean; exit: number; line: string; gain?: number }

export interface Replayer {
  incident(a: { coreDir: string; id: string; evidenceDir: string; rom?: string; cache: string }): Promise<ReplayReading>;
  trace(a: { coreDir: string; id: string; tracesDir: string; rom: string; cache: string }): Promise<ReplayReading>;
}

/** Imports createCore and HANDLERS from `<dir>/index.ts`; each distinct dir is a distinct module instance. */
export async function loadCore(dir: string): Promise<{ createCore: CreateCore; HANDLERS: Record<string, string> }> {
  const m = await import(pathToFileURL(join(dir, "index.ts")).href);
  return { createCore: m.createCore, HANDLERS: m.HANDLERS ?? {} };
}

/** Wall cap of one replay child, in milliseconds; a window is 181 frames, and a suite ROM runs under suites' 60 s cap. */
export const REPLAY_WALL_MS = 180_000;

function run(tool: string, args: string[], cache: string): Promise<ReplayReading> {
  return new Promise((res) => {
    const ch = spawn(process.execPath, [tool, ...args], { env: { ...process.env, RATCHET_CACHE: cache }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    const t = setTimeout(() => ch.kill("SIGKILL"), REPLAY_WALL_MS);
    ch.stdout.on("data", (d) => (out += d));
    ch.stderr.on("data", (d) => (err += d));
    ch.on("close", (code) => {
      clearTimeout(t);
      const line = (out.trim().split("\n").at(-1) || err.trim().split("\n").at(-1) || "").slice(0, 300);
      const m = /pixel match ([\d.]+) \(repro ([\d.]+)\)/.exec(line);
      res({ clean: code === 0, exit: code ?? 2, line, ...(m ? { gain: Number(m[1]) - Number(m[2]) } : {}) });
    });
  });
}

/** The Replayer over `<root>/tools/replay.mjs`; throws when the tool is absent. */
export function toolReplayer(root: string): Replayer {
  const tool = join(root, "tools", "replay.mjs");
  if (!existsSync(tool)) throw new Error(`no ${tool}: the gate's repro checks need S5's replay tool`);
  return {
    incident: (a) => run(tool, ["--incident", a.id, "--core-dir", a.coreDir, "--evidence-dir", a.evidenceDir, ...(a.rom ? ["--rom", a.rom] : [])], a.cache),
    trace: (a) => run(tool, ["--trace", a.id, "--core-dir", a.coreDir, "--rom", a.rom, "--traces-dir", a.tracesDir], a.cache),
  };
}

export function defaultReplayer(root = join(import.meta.dirname, "..")): Replayer {
  return toolReplayer(root);
}
