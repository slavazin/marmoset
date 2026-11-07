// The muse-native watcher (D-0013). `node loop/muse-native-watch.ts --run RUN-NNNN --runs <runs dir>
// [--out <runs dir>] [--home <dir>] [--spend-also <ledger>,<runsDir>,<run>[,<jsonl>…]]… [--poll-s S] [--once]` waits on
// runs/<run>/generations.jsonl and, for the highest generation with no muse-native reading, runs loop/muse-native.ts
// runMuseNative on TRIAL_FAMILIES at that generation's base_commit. A pass takes up to TRIAL_FAMILIES × TRIAL_WALL_S,
// so generations finished meanwhile are skipped and listed in a "skip" line. Before each pass it reads
// server/spend.ts combinedMeter over this run (its ledger, runs dir and muse-native.jsonl) and every --spend-also run:
// at SPEND_ASK_USD it starts no pass and writes a "spend" line (D-0013 revisit: the arm drops at $60).
// It stops once runs/<run>/manifest.json holds s_star_sha, or campaign.jsonl holds a stop record, and every
// generation is covered or skipped. Readings go to <out>/<run>/muse-native.jsonl only (runMuseNative; --out defaults to
// --runs); the watcher's own lines go to <out>/<run>/muse-native-watch.jsonl. It writes nothing under ledger/ and
// nothing under --runs when --out differs (loop/muse-native.test.ts).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { pathsFromEnv, type LoopPaths } from "./paths.ts";
import { runMuseNative, nativeHome, type NativeReading } from "./muse-native.ts";
import { combinedMeter, meterLine, parseMeterPart, spendGate, type MeterPart } from "../server/spend.ts";
import type { TrialJudge } from "./trial.ts";
import type { MuseRunner } from "./repair.ts";

/** Seconds between generation reads while waiting. */
export const WATCH_POLL_S = 30;

interface GenLine { generation: number; base_commit: string; run: string }
export type WatchLine =
  | { t: "start"; at: string; run: string; home: string }
  | { t: "wait"; at: string; run: string; next: number }
  | { t: "skip"; at: string; run: string; generations: number[]; for: number }
  | { t: "spend"; at: string; run: string; usd: number; line: string }
  | { t: "pass"; at: string; run: string; generation: number; base_commit: string; readings: number }
  | { t: "error"; at: string; run: string; generation: number; error: string }
  | { t: "stop"; at: string; run: string; reason: string };

function jsonl<T>(f: string): T[] {
  if (!existsSync(f)) return [];
  const out: T[] = [];
  for (const l of readFileSync(f, "utf8").split("\n")) if (l.trim()) try { out.push(JSON.parse(l) as T); } catch { /* partial */ }
  return out;
}

export interface WatchDeps {
  paths: LoopPaths; run: string; runsDir: string; judge: TrialJudge;
  /** Where readings and watch lines go; default runsDir. */
  outDir?: string;
  home?: string; runner?: MuseRunner; families?: readonly string[]; familyRoms?: (f: string) => string[];
  spendAlso?: MeterPart[];
  pollS?: number; once?: boolean;
  sleep?: (ms: number) => Promise<void>;
  log?: (s: string) => void;
}

export const watchFile = (runsDir: string, run: string) => join(runsDir, run, "muse-native-watch.jsonl");
export const nativeFile = (runsDir: string, run: string) => join(runsDir, run, "muse-native.jsonl");

/** One watcher step: the pass it ran, or the line it wrote instead (see the file header). */
export async function watchStep(d: WatchDeps): Promise<WatchLine> {
  const at = () => new Date().toISOString();
  const out = d.outDir ?? d.runsDir;
  const rec = (l: WatchLine): WatchLine => { mkdirSync(join(out, d.run), { recursive: true }); appendFileSync(watchFile(out, d.run), JSON.stringify(l) + "\n"); (d.log ?? console.log)(JSON.stringify(l)); return l; };
  const gens = jsonl<GenLine>(join(d.runsDir, d.run, "generations.jsonl"));
  const done = new Set(jsonl<NativeReading>(nativeFile(out, d.run)).map((r) => r.generation));
  const skipped = new Set(jsonl<WatchLine>(watchFile(out, d.run)).flatMap((l) => (l.t === "skip" ? l.generations : [])));
  const todo = gens.filter((g) => !done.has(g.generation) && !skipped.has(g.generation));
  const frozen = existsSync(join(d.runsDir, d.run, "manifest.json")) && !!(JSON.parse(readFileSync(join(d.runsDir, d.run, "manifest.json"), "utf8")) as { s_star_sha?: string }).s_star_sha;
  const stopped = jsonl<{ t: string }>(join(d.runsDir, d.run, "campaign.jsonl")).some((r) => r.t === "stop");
  if (!todo.length) {
    if (frozen || stopped) return rec({ t: "stop", at: at(), run: d.run, reason: frozen ? "curve frozen" : "campaign stopped" });
    return rec({ t: "wait", at: at(), run: d.run, next: Math.max(0, ...gens.map((g) => g.generation)) + 1 });
  }
  const target = todo.at(-1)!;
  const self: MeterPart = { ledger: d.paths.ledger, runsDir: d.runsDir, run: d.run, extraFiles: [nativeFile(out, d.run)] };
  const m = combinedMeter([self, ...(d.spendAlso ?? [])]);
  if (spendGate(m.usd) !== "go") return rec({ t: "spend", at: at(), run: d.run, usd: m.usd, line: `muse-native arm dropped at the spend ask (D-0013): ${meterLine(m)}` });
  if (todo.length > 1) rec({ t: "skip", at: at(), run: d.run, generations: todo.slice(0, -1).map((g) => g.generation), for: target.generation });
  try {
    const readings = await runMuseNative({ paths: d.paths, judge: d.judge, run: d.run, runsDir: out, generation: target.generation, base: target.base_commit, home: d.home, runner: d.runner, families: d.families, familyRoms: d.familyRoms });
    return rec({ t: "pass", at: at(), run: d.run, generation: target.generation, base_commit: target.base_commit, readings: readings.length });
  } catch (e) {
    // a failed pass is recorded as skipped, so the watcher moves on rather than retrying one generation forever
    rec({ t: "skip", at: at(), run: d.run, generations: [target.generation], for: target.generation });
    return rec({ t: "error", at: at(), run: d.run, generation: target.generation, error: String((e as Error)?.message ?? e).split("\n")[0].slice(0, 300) });
  }
}

/** Runs watchStep until a stop line (or once with `once`). */
export async function watch(d: WatchDeps): Promise<WatchLine[]> {
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const home = d.home ?? nativeHome(d.paths.cache);
  const dir = d.outDir ?? d.runsDir;
  mkdirSync(join(dir, d.run), { recursive: true });
  const out: WatchLine[] = [];
  const startLine: WatchLine = { t: "start", at: new Date().toISOString(), run: d.run, home };
  appendFileSync(watchFile(dir, d.run), JSON.stringify(startLine) + "\n");
  (d.log ?? console.log)(JSON.stringify(startLine));
  for (;;) {
    const l = await watchStep({ ...d, home });
    out.push(l);
    if (l.t === "stop" || d.once) return out;
    if (l.t !== "pass") await sleep((d.pollS ?? WATCH_POLL_S) * 1000);
  }
}

async function main(argv: string[]): Promise<void> {
  const { values: v } = parseArgs({ args: argv, options: { run: { type: "string" }, runs: { type: "string" }, out: { type: "string" }, home: { type: "string" }, "spend-also": { type: "string", multiple: true }, "poll-s": { type: "string" }, once: { type: "boolean" } } });
  const run = v.run ?? process.env.RATCHET_RUN;
  if (!run || !/^RUN-\d{4,}$/.test(run)) throw new Error("--run RUN-NNNN is required");
  const runsDir = resolve(v.runs ?? process.env.RATCHET_RUNS ?? "runs");
  if (!existsSync(join(runsDir, run, "manifest.json"))) throw new Error(`${join(runsDir, run, "manifest.json")} is missing: the watcher serves an open run`);
  process.env.RATCHET_RUN = run;
  const { defaultJudge } = await import("./trial.ts");
  await watch({ paths: pathsFromEnv(), run, runsDir, outDir: v.out ? resolve(v.out) : undefined, judge: defaultJudge(), home: v.home ? resolve(v.home) : undefined, spendAlso: (v["spend-also"] ?? []).map(parseMeterPart), pollS: v["poll-s"] ? Number(v["poll-s"]) : undefined, once: !!v.once });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)); } catch (e) { console.error(String(e instanceof Error ? e.message : e)); process.exitCode = 1; }
}
