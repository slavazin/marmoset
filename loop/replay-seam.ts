// The repro seam the gate replays through (SPEC §5 S8; G4 checks 1 and 2). `isolatedReplayer(root)`, the
// default, runs the core under test in a child (loop/frames-child.mjs) under Node's permission model, reading
// only its core dir and the ROM, and compares its frames and game RAM with the cached oracle data in this
// process, so the core cannot read $RATCHET_CACHE/oracle, the evidence dir or traces/ (S5-F6). The comparison
// follows lockstep/replay.ts replayFrames: counters 1 … to run, from … to compared, a stall anywhere is a mismatch.
// Suite incidents go to `toolReplayer(root)`, which runs main's tools/replay.mjs (S5) as a child:
//   --incident <id> --core-dir <dir> --evidence-dir <evidence/incidents/<id>> [--rom <path>]
//   --trace <TRC-id> --core-dir <dir> --rom <path> --traces-dir <traces/>
// with RATCHET_CACHE set to the loop's cache. Exit 0 reads clean, 1 a mismatch, 2 missing data; the printed line
// is the reading. A suite incident's fail line carries the pixel match and the repro's, from which the gate reads
// the gain against SUITE_MIN_GAIN; there the core runs in-process with the tool (verdict residue names it).

import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sha256, traceSha } from "../oracle/client.ts";
import { GAME_RAM } from "../lockstep/diff.ts";
import type { CreateCore, Trace, TraceInput } from "../src/schema.ts";

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

/** The frame producer the isolated replay runs under --permission. */
export const FRAMES_CHILD = join(import.meta.dirname, "frames-child.mjs");

export interface ReplayWindow {
  rom: string; rom_sha: string; align: "counter" | "frame"; inputs: TraceInput[];
  from: number; to: number; oracleDir: string; oracleRam: Record<string, string>;
}

/** Runs the core in the permission-limited child and compares each window counter with the cache. */
export function isolatedReplay(coreDir: string, w: ReplayWindow): Promise<ReplayReading> {
  return new Promise((res) => {
    if (sha256(readFileSync(w.rom)) !== w.rom_sha) return res({ clean: false, exit: 2, line: `${w.rom} is not the ROM (sha ${w.rom_sha.slice(0, 12)})` });
    for (let n = w.from; n <= w.to; n++) if (!existsSync(join(w.oracleDir, `${n}.bin`))) return res({ clean: false, exit: 2, line: `oracle frame ${n} not cached` });
    const core = realpathSync(coreDir), rom = realpathSync(w.rom), child = realpathSync(FRAMES_CHILD);
    const ch = spawn(process.execPath, ["--permission", `--allow-fs-read=${core}`, `--allow-fs-read=${rom}`, `--allow-fs-read=${child}`,
      child, core, rom, w.align, String(w.from), String(w.to), JSON.stringify(w.inputs), String(GAME_RAM.addr), String(GAME_RAM.len)],
      { cwd: core, env: { PATH: process.env.PATH ?? "" }, stdio: ["ignore", "pipe", "pipe"] });
    let buf = "", err = "", compared = 0;
    let done: ReplayReading | null = null;
    const t = setTimeout(() => ch.kill("SIGKILL"), REPLAY_WALL_MS);
    const finish = (r: ReplayReading) => { if (!done) { done = r; ch.kill("SIGKILL"); } };
    ch.stdout.on("data", (d) => {
      buf += d;
      let i: number;
      while (!done && (i = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 1);
        // a line without a numeric n is the core's own output (a console.log), not the producer's: skip it
        let o: { n: number; stall?: boolean; ram?: string; frame?: string };
        try { o = JSON.parse(l); } catch { continue; }
        if (!o || typeof o.n !== "number") continue;
        if (o.stall) { finish({ clean: false, exit: 1, line: `first mismatch: counter ${o.n} (core stalled)` }); break; }
        // counters arrive in order, each once: a core that prints a line it got right for a counter it gets wrong
        // reads as a mismatch, never as a compared counter
        const want = w.from + compared;
        if (o.n !== want) { finish({ clean: false, exit: 1, line: `first mismatch: counter ${want} (child wrote counter ${o.n} out of order)` }); break; }
        compared++;
        const ram = w.oracleRam[o.n];
        if (ram !== undefined && ram !== o.ram) { finish({ clean: false, exit: 1, line: `first mismatch: counter ${o.n} (game-state RAM)` }); break; }
        const a = Buffer.from(o.frame ?? "", "base64"), b = readFileSync(join(w.oracleDir, `${o.n}.bin`));
        let px = 0;
        for (let k = 0; k < b.length; k++) if (a[k] !== b[k]) px++;
        if (px) finish({ clean: false, exit: 1, line: `first mismatch: counter ${o.n} (${px} pixels)` });
      }
    });
    ch.stderr.on("data", (d) => (err += d));
    ch.on("close", () => {
      clearTimeout(t);
      if (done) return res(done);
      if (compared === w.to - w.from + 1) return res({ clean: true, exit: 0, line: "clean" });
      res({ clean: false, exit: 2, line: `core child ended after ${compared} counters: ${err.split("\n").find((l) => /Error/.test(l))?.trim() ?? err.trim().split("\n").at(-1) ?? ""}`.slice(0, 300) });
    });
  });
}

function oracleDirFor(cache: string, rom_sha: string, align: ReplayWindow["align"], inputs: TraceInput[], fallback?: string): string {
  const d = join(cache, "oracle", rom_sha, traceSha({ rom_sha, align, inputs }));
  return existsSync(d) || !fallback ? d : fallback;
}

/** The default Replayer: frame incidents and admitted traces isolated, suite incidents through tools/replay.mjs. */
export function isolatedReplayer(root: string): Replayer {
  const tool = toolReplayer(root);
  return {
    async incident(a) {
      const w = JSON.parse(readFileSync(join(a.evidenceDir, "window.json"), "utf8"));
      if (w.kind === "suite") return tool.incident(a);
      const inc = w.incident as { rom_sha: string; window: [number, number] };
      return isolatedReplay(a.coreDir, {
        rom: a.rom ?? w.rom.path, rom_sha: inc.rom_sha, align: w.trace.align, inputs: w.trace.inputs, from: inc.window[0], to: inc.window[1],
        oracleDir: oracleDirFor(a.cache, inc.rom_sha, w.trace.align, w.trace.inputs, w.oracle_dir), oracleRam: w.oracle_ram ?? {},
      });
    },
    async trace(a) {
      const t = JSON.parse(readFileSync(join(a.tracesDir, `${a.id}.json`), "utf8")) as Trace & { window?: [number, number] };
      // an admitted trace is its window (SPEC §5 S8 "admit the trace window"): counters before it may hold other,
      // unrepaired divergences on the same play trace; a trace without a window compares from its first input
      const first = t.window?.[0] ?? Math.min(...t.inputs.map((i) => i.from_counter), t.counter_end);
      return isolatedReplay(a.coreDir, {
        rom: a.rom, rom_sha: t.rom_sha, align: t.align, inputs: t.inputs, from: Math.max(1, first), to: t.window?.[1] ?? t.counter_end,
        oracleDir: oracleDirFor(a.cache, t.rom_sha, t.align, t.inputs), oracleRam: {},
      });
    },
  };
}

export function defaultReplayer(root = join(import.meta.dirname, "..")): Replayer {
  return isolatedReplayer(root);
}
