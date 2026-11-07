// pnpm play [--gemini|--explore] [--frames N] [--seed S] [--rom <gb>] [--core-dir <dir>] [--ledger <file>] [--goal <text>] [--narrate]
// --explore (the default): the explorer (player/explore.ts) writes a trace from the seed, then lockstep
//   (lockstep/lockstep.ts) runs it against the core in --core-dir (default core/). With no incident opened it
//   prints the game effects the trace reached (player/game.ts effectsRun). Default --frames EXPLORE_FRAMES.
// --gemini: Gemini plays on the oracle (player/play.ts) for --frames (default GEMINI_FRAMES), writing a trace
//   and an intent feed; lockstep then runs that trace when --core-dir holds a core.
// --narrate: each incident the run opens gets one narrator sentence (player/narrate.ts).
// Prints one JSON summary line. Exit 0 on a finished run, 2 on a usage or run error.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import type { Trace } from "../src/schema.ts";
import { ratchetCache, sha256, traceSha } from "../oracle/client.ts";
import { loadCreateCore } from "../lockstep/core-dir.ts";
import { JsonlIncidentSink } from "../lockstep/incidents.ts";
import { lockstep } from "../lockstep/lockstep.ts";
import { explorerTrace } from "./explore.ts";
import { effectsRun } from "./game.ts";
import { narrate } from "./narrate.ts";
import { geminiPlay } from "./play.ts";

const REPO = resolve(import.meta.dirname, "..");
/** Explorer default: 3 minutes of play at 60 frames per second (SPEC §5 S7 Accept). */
export const EXPLORE_FRAMES = 3 * 60 * 60;
/** Gemini default segment, in game frames. */
export const GEMINI_FRAMES = 300;

function commitOf(dir: string): string {
  try { return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return "unknown"; }
}
const hasCore = (dir: string) => ["index.ts", "index.mjs", "index.js"].some((f) => existsSync(join(dir, f)));

async function main(): Promise<number> {
  const { values: v } = parseArgs({
    options: {
      gemini: { type: "boolean" }, explore: { type: "boolean" }, frames: { type: "string" }, seed: { type: "string" },
      rom: { type: "string" }, "core-dir": { type: "string" }, ledger: { type: "string" }, goal: { type: "string" }, narrate: { type: "boolean" },
    },
  });
  if (v.gemini && v.explore) { console.error("usage: pnpm play [--gemini|--explore] [--frames N] [--seed S]"); return 2; }
  const romPath = resolve(v.rom ?? join(REPO, "game", "game.gb"));
  const coreDir = resolve(v["core-dir"] ?? join(REPO, "core"));
  const run = process.env.RATCHET_RUN ?? null;
  const rom_sha = sha256(readFileSync(romPath));
  const out: Record<string, unknown> = { mode: v.gemini ? "gemini" : "explore" };

  let trace: Trace;
  if (v.gemini) {
    const r = await geminiPlay({ romPath, frames: Number(v.frames ?? GEMINI_FRAMES), goal: v.goal, run, log: (s) => console.error(s) });
    trace = r.trace;
    Object.assign(out, { trace: r.tracePath, intents: r.intentsPath, decisions: r.decisions, strides: [...new Set(r.strides)], models: r.models });
  } else {
    const seed = Number(v.seed ?? 1);
    trace = explorerTrace({ rom_sha, frames: Number(v.frames ?? EXPLORE_FRAMES), seed });
    const dir = join(ratchetCache(), "traces");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${traceSha(trace)}.json`);
    writeFileSync(path, JSON.stringify(trace) + "\n");
    Object.assign(out, { seed, frames: trace.counter_end, trace: path, inputs: trace.inputs.length });
  }

  if (!hasCore(coreDir)) {
    out.lockstep = `skipped: ${coreDir} holds no core index`;
  } else {
    const res = await lockstep({
      romPath, trace, createCore: await loadCreateCore(coreDir), coreCommit: commitOf(coreDir),
      sink: new JsonlIncidentSink(v.ledger ?? join(REPO, "ledger", "incidents.jsonl")), source: "play", run,
    });
    Object.assign(out, { compared: res.compared, opened: res.opened.map((i) => i.id), known: res.known, stopped: res.stopped, fps: Math.round(res.fps) });
    if (v.narrate) {
      out.narrations = [];
      for (const inc of res.opened) {
        const n = await narrate({ id: inc.id, dir: resolve(REPO, inc.files.dir), run, ledgerFile: v.ledger });
        (out.narrations as unknown[]).push(n);
      }
    }
    if (res.opened.length === 0) out.effects_ran = await effectsRun(romPath, trace);
  }
  if (!v.gemini && out.lockstep) out.effects_ran = await effectsRun(romPath, trace);
  console.log(JSON.stringify(out));
  return 0;
}

try {
  process.exitCode = await main();
} catch (e) {
  console.error(String(e instanceof Error ? e.message : e));
  process.exitCode = 2;
}
