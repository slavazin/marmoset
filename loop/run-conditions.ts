// A run's starting conditions (owner requirement 2026-11-07: runs are isolated and start from the same conditions).
// Offers:
//   runConditions(o)          what this process would run with: run id, ROM (real path and sha), incident source, seed
//                             schedule, live clone (real path), branch and its head, splits files and their sha,
//                             rule_version, and every per-run directory (scratch, cache, subq-cache, telemetry, skills,
//                             evidence, traces), plus the ledger and runs dir;
//   openConditions(o)         first open: refuses when the live branch head is not the declared S0 core commit, or a
//                             per-run directory is another run's (isolationClashes); writes runs/<run>/conditions.json
//                             under O_EXCL;
//   checkConditions(o)        --resume: refuses when any field differs from runs/<run>/conditions.json, except the
//                             branch head (the gate moves it), and on the same isolation clashes;
//   isolationClashes(c, dir)  the per-run directories `c` shares with another run under `dir`: each run's
//                             conditions.json, and for a run with a manifest and no conditions.json, the defaults
//                             loop/paths.ts pathsFromEnv gives a process started in that runs dir's repository.
// Truth-maker: loop/run-conditions.test.ts.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { git, pathsFromEnv, scratchRoot, type LoopPaths } from "./paths.ts";
import { writeExcl } from "./run-records.ts";

/** Where a run's incidents come from: explorer play on a ROM, or the CGB T families' failing ROMs (D-draft-concurrent-cgb-run). */
export type IncidentSource = "play" | "cgb-suite";

export interface RunConditions {
  run: string;
  source: IncidentSource;
  rom: string; rom_sha: string;
  /** First explorer seed; segment i plays seed0 + i (loop/campaign.ts CAMPAIGN_SEED0). */
  seed0: number;
  live: string; live_branch: string;
  /** The live branch head when the run first opened: the core S0 starts from. */
  s0_core_commit: string;
  splits: string[]; splits_sha: string;
  rule_version: string;
  ledger: string; runs_dir: string;
  scratch: string; cache: string; subq_cache: string; telemetry: string; skills: string; evidence: string; traces: string;
}

/** The fields that name a directory one run owns alone. */
export const PER_RUN_DIRS = ["scratch", "cache", "subq_cache", "telemetry", "skills", "evidence", "traces", "live"] as const;

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
/** The real path of `p`, or of its deepest existing ancestor joined with the rest when `p` does not exist yet. */
function real(p: string): string {
  const abs = resolve(p);
  try { return realpathSync(abs); } catch { /* not there yet */ }
  const up = dirname(abs);
  return up === abs ? abs : join(real(up), basename(abs));
}

export interface ConditionsInput {
  run: string; paths: LoopPaths; runsDir: string; rom: string; source: IncidentSource; seed0: number;
  liveBranch: string; splits: string[]; ruleVersion: string; env?: NodeJS.ProcessEnv;
}

/** This process's conditions (see the file header). Telemetry and subq-cache follow src/telemetry.ts and loop/subq.ts. */
export function runConditions(o: ConditionsInput): RunConditions {
  const env = o.env ?? process.env;
  const telemetry = env.RATCHET_TELEMETRY_DIR ? resolve(env.RATCHET_TELEMETRY_DIR) : join(o.paths.root, "runs", o.run, "telemetry");
  const subq_cache = env.RATCHET_SUBQ_CACHE ? resolve(env.RATCHET_SUBQ_CACHE) : join(o.paths.root, "runs", o.run, "subq-cache");
  return {
    run: o.run, source: o.source, rom: real(o.rom), rom_sha: sha(readFileSync(o.rom)), seed0: o.seed0,
    live: real(o.paths.live), live_branch: o.liveBranch, s0_core_commit: git(o.paths.live, ["rev-parse", o.liveBranch]),
    splits: o.splits.map(real), splits_sha: sha(o.splits.map((p) => readFileSync(p, "utf8")).join("")), rule_version: o.ruleVersion,
    ledger: real(o.paths.ledger), runs_dir: real(o.runsDir),
    scratch: real(scratchRoot(o.paths, env)), cache: real(o.paths.cache), subq_cache: real(subq_cache), telemetry: real(telemetry),
    skills: real(o.paths.skills), evidence: real(o.paths.evidence), traces: real(o.paths.traces),
  };
}

export const conditionsPath = (runsDir: string, run: string) => join(runsDir, run, "conditions.json");

export function readConditions(runsDir: string, run: string): RunConditions | null {
  const p = conditionsPath(runsDir, run);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) as RunConditions : null;
}

/** Conditions of a run opened before conditions.json existed: pathsFromEnv's defaults in the runs dir's repository. */
function legacyConditions(runsDir: string, run: string): Pick<RunConditions, (typeof PER_RUN_DIRS)[number]> {
  const root = resolve(runsDir, "..");
  const p = pathsFromEnv({}, root);
  return {
    scratch: real(scratchRoot(p, {})), cache: real(p.cache), subq_cache: real(join(root, "runs", run, "subq-cache")), telemetry: real(join(root, "runs", run, "telemetry")),
    skills: real(p.skills), evidence: real(p.evidence), traces: real(p.traces), live: real(p.live),
  };
}

/** Every "<field>: <path> is <run>'s" where `c` shares a per-run directory with another run under `runsDir` (see the file header). */
export function isolationClashes(c: RunConditions, runsDir: string, extraRunsDirs: string[] = []): string[] {
  const out: string[] = [];
  for (const dir of [runsDir, ...extraRunsDirs]) {
    if (!existsSync(dir)) continue;
    for (const other of readdirSync(dir).sort()) {
      if (other === c.run || !/^RUN-\d+$/.test(other)) continue;
      const theirs = readConditions(dir, other) ?? (existsSync(join(dir, other, "manifest.json")) ? legacyConditions(dir, other) : null);
      if (!theirs) continue;
      for (const f of PER_RUN_DIRS) if (theirs[f] === c[f]) out.push(`${f}: ${c[f]} is ${other}'s`);
    }
  }
  return out;
}

/** First open (see the file header); returns the conditions written. */
export function openConditions(c: RunConditions, o: { s0Commit?: string; extraRunsDirs?: string[] } = {}): RunConditions {
  if (o.s0Commit && !c.s0_core_commit.startsWith(o.s0Commit)) throw new Error(`${c.live_branch} in ${c.live} is at ${c.s0_core_commit.slice(0, 12)}, not the declared S0 core commit ${o.s0Commit}`);
  const clash = isolationClashes(c, c.runs_dir, o.extraRunsDirs);
  if (clash.length) throw new Error(`${c.run} shares per-run directories: ${clash.join("; ")}`);
  writeExcl(conditionsPath(c.runs_dir, c.run), JSON.stringify(c, null, 2) + "\n");
  return c;
}

/** The fields where `actual` differs from `declared`, s0_core_commit excepted (the gate moves the branch head). */
export function conditionDiffs(declared: RunConditions, actual: RunConditions): string[] {
  const out: string[] = [];
  for (const k of Object.keys(declared) as (keyof RunConditions)[]) {
    if (k === "s0_core_commit") continue;
    if (JSON.stringify(declared[k]) !== JSON.stringify(actual[k])) out.push(`${k}: declared ${JSON.stringify(declared[k])}, this process ${JSON.stringify(actual[k])}`);
  }
  return out;
}

/** --resume (see the file header). */
export function checkConditions(actual: RunConditions, o: { extraRunsDirs?: string[] } = {}): RunConditions {
  const declared = readConditions(actual.runs_dir, actual.run);
  if (!declared) throw new Error(`${conditionsPath(actual.runs_dir, actual.run)} is missing: ${actual.run} was opened without declared conditions`);
  const diffs = conditionDiffs(declared, actual);
  const clash = isolationClashes(actual, actual.runs_dir, o.extraRunsDirs);
  if (diffs.length || clash.length) throw new Error(`${actual.run} conditions differ from ${conditionsPath(actual.runs_dir, actual.run)}: ${[...diffs, ...clash].join("; ")}`);
  return declared;
}
