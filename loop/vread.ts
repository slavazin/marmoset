// The V read (SPEC G6, §5 S10), V's only reader. `pnpm vread [--resume]`:
//   1. checks the lock first: runs/<run>/vread.lock must exist, name this run, and carry a token that suites/score.ts
//      vreadAuthorized accepts, and the manifest must hold s_star_sha (pnpm freeze); nothing runs otherwise;
//   2. refuses when runs/<run>/vread.json exists (V is read once), when skills/graduated plus policies/graduated no
//      longer hash to the manifest's s_star_sha, and a started read without --resume; the start record and vread.json
//      are written O_EXCL, so of two reads at once only one starts and only one writes (vread.test.ts "second V read");
//   3. runs two arms on each V family, one family-run per arm per family, from one core-live commit under one budget,
//      through the projection: vread-baseline (S₀: no skills, no policies) and vread-ratchet (S*: the graduated skills
//      under MAX_SHOWN and the graduated policies). Each family-run is an Attempt (task.kind "family") and writes no
//      observation; its core/** diff is applied to a copy of the base core and scored on its family, split V, with
//      RATCHET_VREAD_TOKEN set from the lock;
//   4. appends each finished family-run to runs/<run>/vread-progress.jsonl; --resume reruns only the arm-family pairs
//      not in it, from the commit the first start recorded there;
//   5. writes runs/<run>/vread.json (§6.19 VRead) once every pair has a reading.
// Tests (loop/vread.test.ts) run it with the fake runner on the fixture bed; the real read is the orchestrator's.

import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_SHOWN, MAX_STEPS } from "./gate.ts";
import { all, appendNew, runId, status } from "./ledger.ts";
import { git, LIVE_BRANCH, pathsFromEnv, type LoopPaths } from "./paths.ts";
import { removeScratch, repairPacket } from "./projection.ts";
import { runRepair, type MuseRunner } from "./repair.ts";
import { coreAt, TRIAL_WALL_S } from "./trial.ts";
import { listSkills, selectShown, type ShownSkill } from "./shown.ts";
import { policiesInForce } from "./policies.ts";
import { readLock, readManifest, RUN_ID, sDirs, setSha, writeExcl } from "./run-records.ts";
import { vreadAuthorized } from "../suites/score.ts";
import { tlog } from "../src/telemetry.ts";
import type { Attempt, Fire, RepairTask, SuiteReading, VRead } from "../src/schema.ts";

/** What the V read does not check (SPEC §6.8 residue). */
export const VREAD_RESIDUE: readonly string[] = ["audio", "CGB (RUN-0002 reads V-cgb)", "serial timing",
  "1 family-run per arm per family: a gap inside run-to-run noise is not separable from the arms",
  "the trial calibration's spread was measured on H families, not V"];

export type VArm = "vread-baseline" | "vread-ratchet";
export const V_ARMS: readonly VArm[] = ["vread-baseline", "vread-ratchet"];

/** Scores a core dir on one V family; the default runs suites/score.ts split V in process. */
export type VJudge = (coreDir: string, family: string) => Promise<SuiteReading>;
export const defaultVJudge: VJudge = async (coreDir, family) => {
  const { scoreFamilies } = await import("../suites/score.ts");
  const { loadCore } = await import("./replay-seam.ts");
  const { createCore } = await loadCore(coreDir);
  const [r] = await scoreFamilies(createCore, { split: "V", family });
  return r;
};

export interface VReadDeps {
  paths: LoopPaths; runsDir: string; run: string; runner: MuseRunner; judge: VJudge;
  /** V's families; default splits.json's V families. */
  families?: string[];
  /** ROM paths of a family; default splits.json's under paths.roms. */
  familyRoms?: (family: string) => string[];
  budget?: RepairTask["budget"];
  resume?: boolean;
}

interface Progress { t: "start"; at: string; core_commit: string; s0_sha: string; s_star_sha: string; families: string[] }
interface Done { t: "done"; at: string; arm: VArm; family: string; attempt: string; reading: SuiteReading }

export const progressFile = (runsDir: string, run: string) => join(runsDir, run, "vread-progress.jsonl");
export const vreadFile = (runsDir: string, run: string) => join(runsDir, run, "vread.json");

function readProgress(f: string): (Progress | Done)[] {
  if (!existsSync(f)) return [];
  const out: (Progress | Done)[] = [];
  for (const l of readFileSync(f, "utf8").split("\n")) { if (l.trim()) try { out.push(JSON.parse(l)); } catch { /* a line cut by a crash */ } }
  return out;
}

/** Step 1 of the file header: the lock and its token, before anything else. Returns the token. */
export function checkLock(runsDir: string, run: string): string {
  const lock = readLock(runsDir, run);
  if (!lock) throw new Error(`no ${join(runsDir, run, "vread.lock")}: freeze the curve first (pnpm freeze)`);
  if (lock.run !== run) throw new Error(`vread.lock names ${lock.run}, not ${run}`);
  if (!lock.token || !vreadAuthorized(lock.token, runsDir, run)) throw new Error("vread.lock's token does not authorize V (suites/score.ts vreadAuthorized)");
  const m = readManifest(runsDir, run);
  if (!m?.s_star_sha) throw new Error(`${run}'s manifest has no s_star_sha: the curve is not frozen`);
  return lock.token;
}

async function familyRun(arm: VArm, family: string, base: string, shown: ShownSkill[], policies: string[], d: VReadDeps, roms: string[]): Promise<Done> {
  const task: RepairTask = { kind: "family", family, base_commit: base, arm, skills: shown.map((s) => s.id), policies, budget: d.budget ?? { max_steps: MAX_STEPS, wall_s: TRIAL_WALL_S } };
  const att = appendNew<Attempt>("attempts.jsonl", "ATT", (id) => ({
    id, at: new Date().toISOString(), run: runId(), task, branch: `vread/${id}`, model: "", fires: [],
    spent: { steps: 0, wall_s: 0, tokens_in: 0, tokens_out: 0, usd: 0 }, scratch_files: [],
    isolation: { home: "", skills_list: "", observers: "on-identical", web_tools: "on" },
  }), d.paths.ledger);
  const S = (f: string, v: unknown) => status("attempts.jsonl", att.id, f, v, d.paths.ledger);
  tlog("loop", "vread.arm.start", { arm, family, attempt: att.id, base_commit: base, skills: task.skills, policies });
  const packet = repairPacket(task, { attempt: att.id, paths: d.paths, familyRoms: roms, shown });
  S("scratch_files", packet.files);
  const rep = await runRepair(task, packet, { attempt: att.id, server: d.paths.server, runner: d.runner });
  S("model", rep.model); S("spent", rep.spent); S("isolation", rep.isolation);
  S("fires", all<Fire>("fires.jsonl", d.paths.ledger).filter((f) => f.attempt === att.id).map((f) => f.id));
  S("result", rep.result ?? { dispositions: {}, off_map: null, beliefs: [], summary: `no packet/RESULT.json (muse exit ${rep.exitCode})` });
  const coreDir = join(d.paths.cache, "vread", att.id);
  try { coreAt(d.paths, base, coreDir, rep.diff); } catch (e) { tlog("loop", "vread.arm.apply-failed", { attempt: att.id, error: (e as Error).message }); coreAt(d.paths, base, coreDir); }
  let reading: SuiteReading;
  try { reading = await d.judge(join(coreDir, "core"), family); }
  finally { removeScratch(packet.dir); removeScratch(coreDir); rmSync(`${packet.dir}.home`, { recursive: true, force: true }); }
  tlog("loop", "vread.arm.end", { arm, family, attempt: att.id, reading, model: rep.model, exit: rep.exitCode });
  return { t: "done", at: new Date().toISOString(), arm, family, attempt: att.id, reading };
}

/** The V read (see the file header). */
export async function runVRead(d: VReadDeps): Promise<VRead> {
  const token = checkLock(d.runsDir, d.run);
  const out = vreadFile(d.runsDir, d.run);
  if (existsSync(out)) throw new Error(`${out} exists: V is read once`);
  const pf = progressFile(d.runsDir, d.run);
  let prog = readProgress(pf);
  if (prog.length && !d.resume) throw new Error(`${pf} exists: a V read started; pass --resume to finish its unfinished arms`);
  const m = readManifest(d.runsDir, d.run)!;
  // the ratchet arm reads skills/graduated and policies/graduated as they stand: they must still be the frozen S*
  const onDisk = setSha(d.paths.root, sDirs(d.paths.skills, d.paths.root));
  if (onDisk !== m.s_star_sha) throw new Error(`S* on disk (${onDisk.slice(0, 12)}) is not the manifest's s_star_sha (${m.s_star_sha!.slice(0, 12)}): a skill or policy moved after the freeze`);
  let start = prog.find((p): p is Progress => p.t === "start");
  if (!start) {
    if (existsSync(pf) && !d.resume) throw new Error(`${pf} exists without a start record: another V read holds it`);
    let families = d.families;
    if (!families) { const { loadSplits, familiesIn } = await import("../suites/splits.ts"); families = familiesIn(loadSplits(), "V"); }
    start = { t: "start", at: new Date().toISOString(), core_commit: git(d.paths.live, ["rev-parse", LIVE_BRANCH]), s0_sha: m.s0_sha, s_star_sha: m.s_star_sha!, families };
    // O_EXCL: of two reads started at once, one writes the start record and the other throws EEXIST
    if (existsSync(pf)) appendFileSync(pf, JSON.stringify(start) + "\n"); else writeExcl(pf, JSON.stringify(start) + "\n");
    prog = [start];
  }
  let romsOf = d.familyRoms ?? ((): string[] => []);
  if (!d.familyRoms) {
    const { loadSplits, familyRoms } = await import("../suites/splits.ts");
    const splits = loadSplits();
    romsOf = (f) => familyRoms(splits, f, d.paths.roms).map((r) => join(d.paths.roms, r));
  }
  const done = new Map(prog.filter((p): p is Done => p.t === "done").map((p) => [`${p.arm}|${p.family}`, p]));
  const graduated = listSkills(d.paths.skills, "graduated");
  const policies = policiesInForce(d.paths);
  const draft: RepairTask = { kind: "family", base_commit: start.core_commit, arm: "vread-ratchet", skills: [], policies, budget: d.budget ?? { max_steps: MAX_STEPS, wall_s: TRIAL_WALL_S } };
  const sStar = graduated.filter((s) => new Set(selectShown(graduated.map((g) => g.id), all<Fire>("fires.jsonl", d.paths.ledger), MAX_SHOWN, { task: draft, ctx: { paths: d.paths, skills: graduated, site: "shown" } })).has(s.id));
  const todo = start.families.flatMap((f) => V_ARMS.map((a) => [a, f] as const)).filter(([a, f]) => !done.has(`${a}|${f}`));
  tlog("loop", "vread.start", { run: d.run, core_commit: start.core_commit, todo: todo.map(([a, f]) => `${a}|${f}`), resumed: done.size });
  const prevToken = process.env.RATCHET_VREAD_TOKEN;
  process.env.RATCHET_VREAD_TOKEN = token;
  try {
    const settled = await Promise.allSettled(todo.map(async ([a, f]) => {
      const r = a === "vread-baseline" ? await familyRun(a, f, start!.core_commit, [], [], d, romsOf(f)) : await familyRun(a, f, start!.core_commit, sStar, policies, d, romsOf(f));
      appendFileSync(pf, JSON.stringify(r) + "\n");
      done.set(`${a}|${f}`, r);
    }));
    const failed = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    if (failed.length) throw new Error(`V read unfinished: ${failed.length} of ${todo.length} family-runs failed (${failed.map((f) => (f.reason as Error)?.message ?? String(f.reason)).join("; ")}); rerun with --resume`);
  } finally {
    if (prevToken === undefined) delete process.env.RATCHET_VREAD_TOKEN; else process.env.RATCHET_VREAD_TOKEN = prevToken;
  }
  const pick = (a: VArm) => start!.families.map((f) => done.get(`${a}|${f}`)!.reading);
  const v: VRead = {
    run: d.run, at: new Date().toISOString(), core_commit: start.core_commit, s0_sha: start.s0_sha, s_star_sha: start.s_star_sha,
    arms: { baseline: pick("vread-baseline"), ratchet: pick("vread-ratchet") }, n_family_runs_per_arm: 1, residue: [...VREAD_RESIDUE],
  };
  try { writeExcl(out, JSON.stringify(v, null, 2) + "\n"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${out} exists: V is read once (another read wrote it first; this read's arms are in ${pf})`); throw e; }
  tlog("loop", "vread.written", v);
  return v;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.env.RATCHET_RUN ??= RUN_ID;
  (await import("../src/telemetry-process.ts")).processStart("vread");
  const paths = pathsFromEnv();
  const runsDir = resolve(paths.root, process.env.RATCHET_RUNS ?? "runs");
  try {
    const { museCli } = await import("./repair.ts");
    const v = await runVRead({ paths, runsDir, run: process.env.RATCHET_RUN, runner: museCli, judge: defaultVJudge, resume: process.argv.includes("--resume") });
    console.log(`${vreadFile(runsDir, v.run)}: n ${v.n_family_runs_per_arm} family-run per arm; baseline ${JSON.stringify(v.arms.baseline)}; ratchet ${JSON.stringify(v.arms.ratchet)}`);
  } catch (e) { console.error(String(e instanceof Error ? e.message : e)); process.exitCode = 1; }
}
