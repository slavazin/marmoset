// The slow loop (SPEC §2.3 slow loop, §5 S9). Offers:
//   generationsDue(paths, run)  how many generations the ledger's incident count owes: floor(incidents / K) minus the
//                               generations already in runs/<run>/generations.jsonl;
//   runGeneration(deps)         one generation: T readings at core-live, consolidate (≤ MAX_NOMINATIONS shadow
//                               skills), a placebo twin per candidate, a shadow trial per pair, `.muse/hooks.json`
//                               recompiled from the graduated skills, and one line in runs/<run>/generations.jsonl;
//   CLI  node loop/slow.ts [--force]   runs every due generation (one with --force) under RATCHET_RUN, with the real
//                               consolidator, Muse runner and suites. --muse-native (D-0013) adds that arm after.
// Tests: loop/slow.test.ts runs one generation end to end on fixtures with the fake runner and a fake consolidator.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { K } from "./gate.ts";
import { all, runId } from "./ledger.ts";
import { git, LIVE_BRANCH, pathsFromEnv, type LoopPaths } from "./paths.ts";
import { consolidate, type ConsolidateOutput } from "./consolidate.ts";
import { makePlacebo, type Twin } from "./placebo.ts";
import { coreAt, defaultJudge, runTrial, type TrialDeps, type TrialJudge, type TrialOutput } from "./trial.ts";
import { compileLatches } from "./latches.ts";
import { removeScratch } from "./projection.ts";
import { museCli, type MuseRunner } from "./repair.ts";
import type { Llm } from "./llm.ts";
import { tlog } from "../src/telemetry.ts";
import type { Incident, SuiteReading } from "../src/schema.ts";

/** Scores T families at a core dir; the default runs suites/score.ts split T. */
export type TReader = (coreDir: string) => Promise<SuiteReading[]>;
export const defaultTReader: TReader = async (coreDir) => {
  const { scoreFamilies } = await import("../suites/score.ts");
  const { loadCore } = await import("./replay-seam.ts");
  const { createCore } = await loadCore(coreDir);
  return scoreFamilies(createCore, { split: "T" });
};

export interface SlowDeps extends Omit<TrialDeps, "generation"> { llm?: Llm; tReader?: TReader; hooksRoot?: string }
export interface GenerationOutput { generation: number; consolidation: ConsolidateOutput; twins: Twin[]; trials: TrialOutput[]; hooks: string }

function genFile(d: { paths: LoopPaths; runsDir?: string; run: string }): string { return join(d.runsDir ?? join(d.paths.root, "runs"), d.run, "generations.jsonl"); }

export function generationsDone(d: { paths: LoopPaths; runsDir?: string; run: string }): number {
  const f = genFile(d);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).length : 0;
}

export function generationsDue(d: { paths: LoopPaths; runsDir?: string; run: string }): number {
  const n = all<Incident>("incidents.jsonl", d.paths.ledger).filter((i) => i.source !== "sabotage").length;
  return Math.max(0, Math.floor(n / K) - generationsDone(d));
}

/** One generation (see the file header). */
export async function runGeneration(d: SlowDeps): Promise<GenerationOutput> {
  const generation = generationsDone(d) + 1;
  const base = git(d.paths.live, ["rev-parse", LIVE_BRANCH]);
  tlog("loop", "generation.start", { generation, run: d.run, base_commit: base });
  const tDir = join(d.paths.cache, "trial", `t-${base.slice(0, 12)}`);
  coreAt(d.paths, base, tDir);
  let tReadings: SuiteReading[] = [];
  try { tReadings = await (d.tReader ?? defaultTReader)(join(tDir, "core")); } catch (e) { tlog("loop", "generation.t-readings-failed", { error: (e as Error).message }); }
  removeScratch(tDir);

  const consolidation = await consolidate({ paths: d.paths, tReadings, llm: d.llm, generation });
  const paths = consolidation.nominated.map((n) => n.path);
  const twins = consolidation.nominated.map((n) => makePlacebo(n.path, paths.filter((p) => p !== n.path), d.paths.skills));
  tlog("loop", "placebo.written", { generation, twins: twins.map((t, i) => ({ candidate: consolidation.nominated[i].id, twin: t.id, source: t.source, bytes: t.bytes, candidate_bytes: t.candidateBytes })) });

  const trials: TrialOutput[] = [];
  for (let i = 0; i < twins.length; i++) trials.push(await runTrial(consolidation.nominated[i].id, twins[i].id, { ...d, generation }));
  const hooks = compileLatches(d.paths.skills, d.hooksRoot ?? d.paths.root).path;

  const f = genFile(d);
  mkdirSync(join(f, ".."), { recursive: true });
  const rec = { at: new Date().toISOString(), generation, run: d.run, base_commit: base, call_ok: consolidation.call.ok, call_error: consolidation.call.error ?? null,
    nominated: consolidation.nominated.map((n) => n.id), twins: twins.map((t) => t.id), verdicts: trials.map((t) => t.verdict.id), decisions: trials.map((t) => t.verdict.decision), detection: consolidation.detection };
  appendFileSync(f, JSON.stringify(rec) + "\n");
  tlog("loop", "generation.end", rec);
  return { generation, consolidation, twins, trials, hooks };
}

async function main(argv: string[]): Promise<void> {
  const paths = pathsFromEnv();
  const run = runId() ?? "prerun";
  const judge: TrialJudge = defaultJudge();
  const runner: MuseRunner = museCli;
  const d: SlowDeps = { paths, runner, judge, run };
  let due = argv.includes("--force") ? 1 : generationsDue(d);
  if (!due) console.log(`no generation due: ${all("incidents.jsonl", paths.ledger).length} incidents, ${generationsDone(d)} generations, K = ${K}`);
  while (due-- > 0) {
    const g = await runGeneration(d);
    console.log(JSON.stringify({ generation: g.generation, nominated: g.consolidation.nominated.map((n) => n.id), verdicts: g.trials.map((t) => `${t.verdict.id} ${t.verdict.decision}: ${t.verdict.reason}`), hooks: g.hooks }));
  }
  if (argv.includes("--muse-native")) {
    const { runMuseNative } = await import("./muse-native.ts");
    console.log(JSON.stringify(await runMuseNative({ paths, judge, run, generation: generationsDone(d) })));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
