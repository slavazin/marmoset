// The S1 kill read's driver (SPEC §5 S1, "Kill read"): drives muse-spark-1.3 through scripts/api-loop.ts
// (runApiLoop, D-0016) on a hand-built directory holding core/, src/schema.ts, tools/replay.mjs, roms.json (T's
// mealybug:palette-scroll-bg list only) and task.md, one round per runApiLoop call, keeping the best core between
// rounds, until MODEL_BUDGET_MS of model wall time is spent. It writes rounds.jsonl, calls.jsonl, summary.json and
// final.patch to OUT, and one tlog("llm", …) record per model call.
//
//   RATCHET_TELEMETRY_DIR=<OUT>/telemetry node evidence/kill-read/drive.ts <hand-built dir>
import { spawnSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runApiLoop } from "../../scripts/api-loop.ts";
import { tlog } from "../../src/telemetry.ts";

/** Model wall time the read may spend, in milliseconds (the brief's 15-minute timebox; a hard stop). */
const MODEL_BUDGET_MS = 15 * 60_000;
/** reasoning_effort per call; "low" is the setting D-0016's rounds 4–13 completed under (evidence/s1-core/calls.jsonl). */
const EFFORT = "low";
const MODEL = "muse-spark-1.3";
const FAMILY = "mealybug:palette-scroll-bg";

const DIR = resolve(process.argv[2] ?? "");
const OUT = resolve(import.meta.dirname);
const ROUNDS = join(OUT, "rounds.jsonl");
const CALLS = join(DIR, "calls.jsonl");
const SCORE = `node tools/replay.mjs --family ${FAMILY} --core-dir core --roms roms.json`;

interface Reading { exact: number; pixel_match: number; per_rom: Record<string, number>; output: string; error: string | null }

function score(): Reading {
  const r = spawnSync("sh", ["-c", SCORE], { cwd: DIR, encoding: "utf8", timeout: 5 * 60_000 });
  const output = `$ ${SCORE}\n(exit ${r.status})\n${r.stderr ?? ""}${r.stdout ?? ""}`;
  const per_rom: Record<string, number> = {};
  for (const m of (r.stderr ?? "").matchAll(/^\s+(\S+): (\w+) \(.*?pixel match ([\d.]+)\)/gm)) per_rom[m[1]] = Number(m[3]);
  for (const m of (r.stderr ?? "").matchAll(/^\s+(\S+): pass/gm)) per_rom[m[1]] = 1;
  const last = (r.stdout ?? "").trim().split("\n").at(-1) ?? "";
  try {
    const j = JSON.parse(last) as { exact: number; pixel_match: number };
    return { exact: j.exact, pixel_match: j.pixel_match, per_rom, output, error: null };
  } catch {
    return { exact: 0, pixel_match: 0, per_rom, output, error: output.slice(-2000) };
  }
}

const better = (a: Reading, b: Reading): boolean => a.exact > b.exact || (a.exact === b.exact && a.pixel_match > b.pixel_match);
const snap = (to: string): void => { rmSync(join(DIR, to), { recursive: true, force: true }); cpSync(join(DIR, "core"), join(DIR, to), { recursive: true }); };
const restoreBest = (): void => { rmSync(join(DIR, "core"), { recursive: true, force: true }); cpSync(join(DIR, ".best-core"), join(DIR, "core"), { recursive: true }); };

let loggedCalls = 0;
/** tlogs every calls.jsonl line not yet logged and returns the summed usage of those lines. */
function logNewCalls(): { n_prompt: number; n_completion: number; calls: number } {
  const lines = existsSync(CALLS) ? readFileSync(CALLS, "utf8").trim().split("\n").filter(Boolean) : [];
  const sum = { n_prompt: 0, n_completion: 0, calls: 0 };
  for (const l of lines.slice(loggedCalls)) {
    const c = JSON.parse(l);
    const n_prompt = Number(c.usage?.prompt_tokens ?? 0); const n_completion = Number(c.usage?.completion_tokens ?? 0);
    tlog("llm", "call", { role: "kill-read-repairer", model_requested: c.model, model_echoed: c.echoed_model, effort: c.effort, round: c.round, call: c.call,
      outcome: c.reply ? "ok" : "empty", finish_reason: c.finish_reason, n_prompt, n_completion, wall_ms: c.ms, request_chars: c.messages?.reduce((a: number, m: { content: string }) => a + m.content.length, 0), text: c.reply });
    sum.n_prompt += n_prompt; sum.n_completion += n_completion; sum.calls++;
  }
  loggedCalls = lines.length;
  return sum;
}

const t0 = Date.now();
let modelMs = 0;
let tokens = { n_prompt: 0, n_completion: 0 };
const base = score();
let best = base; let bestRound = 0;
snap(".best-core");
writeFileSync(ROUNDS, "");
appendFileSync(ROUNDS, JSON.stringify({ round: 0, kind: "baseline", exact: base.exact, pixel_match: base.pixel_match, per_rom: base.per_rom }) + "\n");
process.stderr.write(`[kill-read] baseline exact ${base.exact}/9, pixel match ${base.pixel_match.toFixed(4)}\n`);

let finished = false;
function finalize(stop: string): void {
  if (finished) return; finished = true;
  const cut = logNewCalls();
  restoreBest();
  const final = score();
  const patch = spawnSync("diff", ["-ruN", ".base-core", "core"], { cwd: DIR, encoding: "utf8" }).stdout ?? "";
  writeFileSync(join(OUT, "final.patch"), patch.replaceAll(".base-core/", "a/core/").replaceAll(" core/", " b/core/"));
  cpSync(CALLS, join(OUT, "calls.jsonl"));
  const summary = {
    family: FAMILY, split: "T", model: MODEL, effort: EFFORT, budget_model_ms: MODEL_BUDGET_MS, stop,
    model_ms: modelMs, wall_ms: Date.now() - t0, rounds: round - 1, calls: loggedCalls, tokens: { n_prompt: tokens.n_prompt + cut.n_prompt, n_completion: tokens.n_completion + cut.n_completion },
    baseline: { exact: base.exact, pixel_match: base.pixel_match, per_rom: base.per_rom },
    final: { exact: final.exact, pixel_match: final.pixel_match, per_rom: final.per_rom, from_round: bestRound },
    room_thin: final.exact >= 7, threshold_exact: 7, roms: 9,
  };
  writeFileSync(join(OUT, "summary.json"), JSON.stringify(summary, null, 1) + "\n");
  process.stderr.write(`[kill-read] ${stop}: final exact ${final.exact}/9, pixel match ${final.pixel_match.toFixed(4)} (round ${bestRound})\n`);
  process.exit(0);
}

let round = 1;
let feedback = base.output;
while (modelMs < MODEL_BUDGET_MS) {
  const remaining = MODEL_BUDGET_MS - modelMs;
  const roundStart = Date.now();
  // Hard stop: a call still streaming when the budget runs out is cut, and its round is not scored.
  const timer = setTimeout(() => {
    modelMs += Date.now() - roundStart;
    appendFileSync(ROUNDS, JSON.stringify({ round, kind: "cut", model_ms_in_round: Date.now() - roundStart }) + "\n");
    finalize("hard stop mid-round");
  }, remaining);
  const [rec] = await runApiLoop({ task: readFileSync(join(DIR, "task.md"), "utf8"), dir: DIR, prefix: "core/", model: MODEL, checks: [], rounds: 1,
    startRound: round, previousOutput: feedback, effort: EFFORT, log: join(DIR, "loop-rounds.jsonl") });
  clearTimeout(timer);
  modelMs += rec.ms;
  const u = logNewCalls();
  tokens = { n_prompt: tokens.n_prompt + u.n_prompt, n_completion: tokens.n_completion + u.n_completion };
  const r = score();
  const kept = better(r, best);
  if (kept) { best = r; bestRound = round; snap(".best-core"); } else restoreBest();
  appendFileSync(ROUNDS, JSON.stringify({ round, kind: "round", calls: rec.calls, model_ms: rec.ms, cum_model_ms: modelMs, finish_reason: rec.finish_reason, echoed_model: rec.echoed_model,
    n_prompt: u.n_prompt, n_completion: u.n_completion, files_written: rec.files_written, files_refused: rec.files_refused,
    exact: r.exact, pixel_match: r.pixel_match, per_rom: r.per_rom, error: r.error, kept, best_exact: best.exact, best_pixel_match: best.pixel_match }) + "\n");
  process.stderr.write(`[kill-read] round ${round}: exact ${r.exact}/9, pixel ${r.pixel_match.toFixed(4)}, ${kept ? "kept" : "reverted"}; model ${Math.round(modelMs / 1000)} s\n`);
  feedback = kept ? r.output
    : `${r.output}\nThat reply scored exact ${r.exact}, pixel_match ${r.pixel_match.toFixed(4)}, below the best (exact ${best.exact}, pixel_match ${best.pixel_match.toFixed(4)}); it was reverted. The current files are the best core; its reading:\n${best.output}`;
  if (best.exact === 9) { round++; finalize("all nine exact"); }
  round++;
}
finalize("budget spent");
