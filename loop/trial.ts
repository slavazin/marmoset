// The shadow trial (SPEC §2.3 shadow trial, baseline arm; §5 S9; G4). Offers:
//   ensureCalibration(deps, base)  at the run's first trial, the baseline arm twice on each TRIAL_FAMILIES family;
//                                  per family margin = max(MARGIN_FLOOR[f], 2 × spread) in its unit (gate-skill.ts),
//                                  appended once to runs/<run>/calibration.jsonl. A family already in that file is
//                                  read, never re-run or rewritten (slow.test.ts);
//   runTrial(candidate, placebo, deps)  3 arms × TRIAL_FAMILIES, each a family repair task from one core-live commit
//                                  under one budget, in parallel scratch repos (loop/projection.ts, loop/repair.ts);
//                                  each arm's core/** diff is applied to a copy of the base core and scored on its
//                                  family (split H) and the base suites; loop/gate-skill.ts decides; one Verdict with
//                                  `arms` goes to ledger/verdicts.jsonl; the candidate graduates or is tombstoned, the
//                                  placebo is tombstoned as retired; runs/<run>/trials.jsonl pairs candidate and twin.
// An arm whose policies include a route-by-subq-applies policy reads SubQ's route of its family task, asked once per
// family and shared by both policy arms (familyRouteOnce, loop/route.ts routeFamily; S15-R3).
// Each arm run is an Attempt in ledger/attempts.jsonl (task.kind "family", task.arm the arm) and writes no observation;
// the placebo arm's packet/task.json reads arm "candidate", so its repairer cannot tell it from the candidate arm.
// Each skill verdict carries its `generation` and `arms`; server/events.ts curveEvents plots the arms at that generation.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { TRIAL_FAMILIES, MAX_SHOWN, MAX_STEPS } from "./gate.ts";
import { all, appendNew, current, runId, status } from "./ledger.ts";
import { git, LIVE_BRANCH, type LoopPaths } from "./paths.ts";
import { repairPacket, removeScratch } from "./projection.ts";
import { runRepair, type MuseRunner } from "./repair.ts";
import { loadCore } from "./replay-seam.ts";
import { ruleVersion } from "./gate-repair.ts";
import { listSkills, selectShown, type ShownSkill } from "./shown.ts";
import { loadPolicies, needsSubqRoute, policiesDir } from "./policies.ts";
import { routableSkills, routeFamily } from "./route.ts";
import { decideSkill, graduateSkill, marginFor, tombstoneSkill, type TrialArm } from "./gate-skill.ts";
import { loadSplits, familyRoms } from "../suites/splits.ts";
import { tlog } from "../src/telemetry.ts";
import type { Attempt, Calibration, Fire, Incident, RepairTask, SuiteReading, Verdict } from "../src/schema.ts";

/** Wall-clock budget of one trial arm's family-run, equal across arms; its home is loop/budget.ts. */
export { TRIAL_WALL_S } from "./budget.ts";
import { TRIAL_WALL_S } from "./budget.ts";
/** What every skill verdict does not check (SPEC §6.8 residue). */
export const SKILL_RESIDUE: readonly string[] = ["audio", "CGB", "V (sealed)", "H families outside TRIAL_FAMILIES",
  "1 family-run per arm per family: a gap inside run-to-run noise beyond the calibrated spread is not read"];

/** Scores a core directory (the one holding index.ts); `defaultJudge` runs suites/score.ts in-process, tests pass fakes. */
export interface TrialJudge { score(coreDir: string, split: "base" | "H", family?: string): Promise<SuiteReading[]> }
export function defaultJudge(): TrialJudge {
  return {
    async score(coreDir, split, family) {
      const { scoreFamilies } = await import("../suites/score.ts");
      const { createCore } = await loadCore(coreDir);
      return scoreFamilies(createCore, { split, family });
    },
  };
}

export interface TrialDeps {
  paths: LoopPaths; runner: MuseRunner; judge: TrialJudge;
  /** Run id the calibration and trials files live under; runs dir defaults to <root>/runs. */
  run: string; runsDir?: string;
  families?: readonly string[];
  budget?: RepairTask["budget"];
  /** ROM paths of a family; defaults to splits.json's under paths.roms. */
  familyRoms?: (family: string) => string[];
  generation: number;
}

export interface ArmRun { arm: TrialArm | "muse-native"; family: string; attempt: string; reading: SuiteReading; base: SuiteReading[]; diffPaths: string[] }

function runsDir(d: TrialDeps): string { return d.runsDir ?? join(d.paths.root, "runs"); }
function famRoms(d: TrialDeps, f: string): string[] {
  if (d.familyRoms) return d.familyRoms(f);
  try { return familyRoms(loadSplits(), f, d.paths.roms).map((r) => join(d.paths.roms, r)); } catch { return []; }
}

/** core/ at `commit` from the live clone into `dir`, with the core/** part of `diff` applied; returns the paths applied. */
export function coreAt(paths: LoopPaths, commit: string, dir: string, diff = ""): string[] {
  removeScratch(dir);
  mkdirSync(dir, { recursive: true });
  const tar = execFileSync("git", ["archive", "--format=tar", commit, "core"], { cwd: paths.live, maxBuffer: 256 << 20 });
  execFileSync("tar", ["-x", "-C", dir], { input: tar });
  const blocks = diff.split(/^(?=diff --git )/m).filter((b) => /^diff --git a\/core\/\S+ b\/core\//.test(b));
  const touched = blocks.map((b) => /^diff --git a\/\S+ b\/(\S+)$/m.exec(b)![1]);
  if (blocks.length) {
    git(dir, ["init", "--quiet"]); // apply relative to dir even when dir sits inside another repository
    execFileSync("git", ["apply", "-"], { cwd: dir, input: blocks.join("") });
  }
  return touched;
}

const familyRoutes = new Map<string, Promise<Incident["route"] | null>>();
/**
 * SubQ's route of one family task (loop/route.ts routeFamily), asked once per (ledger, base commit, family, shown
 * skills) in this process, so a trial's candidate and placebo arms read the same answers and differ only in policy.
 */
export function familyRouteOnce(family: string, shown: ShownSkill[], base: string, d: TrialDeps): Promise<Incident["route"] | null> {
  const key = [d.paths.ledger, base, family, shown.map((s) => s.id).join(",")].join("|");
  let p = familyRoutes.get(key);
  if (!p) {
    const ids = new Set(shown.map((s) => s.id));
    p = routeFamily(family, routableSkills(d.paths.skills).filter((s) => ids.has(s.id)), { ledger: d.paths.ledger, root: d.paths.root, roms: famRoms(d, family) })
      .catch((e) => { tlog("loop", "route.family-failed", { family, error: (e as Error).message }); return null; });
    familyRoutes.set(key, p);
  }
  return p;
}

/** One arm's family-run (see the file header); `homeOverride` is muse-native's persistent runner path. */
export async function runArm(arm: ArmRun["arm"], family: string, shown: ShownSkill[], base: string, d: TrialDeps, runner: MuseRunner = d.runner, policies: string[] = []): Promise<ArmRun> {
  const taskArm: RepairTask["arm"] = arm === "muse-native" ? "baseline" : arm;
  const draft: RepairTask = { kind: "family", family, base_commit: base, arm: taskArm, skills: [], policies, budget: d.budget ?? { max_steps: MAX_STEPS, wall_s: TRIAL_WALL_S } };
  // a routing policy picks among the arm's skills by the family's subsystem, or by SubQ's route of the family task
  // (S15-R3; loop/policies.ts applyPolicies)
  const familyRoute = needsSubqRoute(policies, d.paths) ? await familyRouteOnce(family, shown, base, d) : null;
  const keep = new Set(policies.length ? selectShown(shown.map((s) => s.id), all<Fire>("fires.jsonl", d.paths.ledger), MAX_SHOWN, { task: draft, ctx: { paths: d.paths, skills: shown, site: "shown", ...(familyRoute ? { route: familyRoute } : {}) } }) : shown.map((s) => s.id));
  shown = shown.filter((s) => keep.has(s.id));
  const task: RepairTask = { ...draft, skills: shown.map((s) => s.id) };
  const att = appendNew<Attempt>("attempts.jsonl", "ATT", (id) => ({
    id, at: new Date().toISOString(), run: runId(), task, branch: `trial/${id}`, model: "", fires: [],
    spent: { steps: 0, wall_s: 0, tokens_in: 0, tokens_out: 0, usd: 0 }, scratch_files: [],
    isolation: { home: "", skills_list: "", observers: "on-identical", web_tools: "on" },
  }), d.paths.ledger);
  const S = (f: string, v: unknown) => status("attempts.jsonl", att.id, f, v, d.paths.ledger);
  tlog("loop", "trial.arm.start", { generation: d.generation, arm, family, attempt: att.id, skills: task.skills, policies, base_commit: base });
  // the repairer reads packet/task.json: the placebo arm's packet says "candidate", so the two skill arms differ only
  // in their skill (G4: the repairer must not tell candidate from placebo); the Attempt keeps the true arm
  const blind: RepairTask = taskArm === "placebo" ? { ...task, arm: "candidate" } : task;
  const packet = repairPacket(blind, { attempt: att.id, paths: d.paths, familyRoms: famRoms(d, family), shown });
  S("scratch_files", packet.files);
  const rep = await runRepair(blind, packet, { attempt: att.id, server: d.paths.server, runner });
  S("model", rep.model); S("spent", rep.spent); S("isolation", rep.isolation);
  S("fires", all<Fire>("fires.jsonl", d.paths.ledger).filter((f) => f.attempt === att.id).map((f) => f.id));
  S("result", rep.result ?? { dispositions: {}, off_map: null, beliefs: [], summary: `no packet/RESULT.json (muse exit ${rep.exitCode})` });
  const coreDir = join(d.paths.cache, "trial", att.id);
  let diffPaths: string[] = [];
  try { diffPaths = coreAt(d.paths, base, coreDir, rep.diff); } catch (e) { tlog("loop", "trial.arm.apply-failed", { attempt: att.id, error: (e as Error).message }); coreAt(d.paths, base, coreDir); }
  // a core that cannot be scored (it fails to load) reads 0 on its family and no base reading, which the skill
  // rule reads as a regression, so the trial ends in REFUSE instead of throwing with the skill left in shadow
  let reading: SuiteReading | undefined, baseR: SuiteReading[] = [];
  try {
    [reading] = await d.judge.score(join(coreDir, "core"), "H", family);
    baseR = await d.judge.score(join(coreDir, "core"), "base");
  } catch (e) { reading = undefined; baseR = []; tlog("loop", "trial.arm.score-failed", { attempt: att.id, error: (e as Error).message }); }
  removeScratch(packet.dir); removeScratch(coreDir);
  rmSync(`${packet.dir}.home`, { recursive: true, force: true });
  const out: ArmRun = { arm, family, attempt: att.id, reading: reading ?? { split: "H", family, roms: 0, pass: 0, exact: 0, pixel_match: 0 }, base: baseR, diffPaths };
  tlog("loop", "trial.arm.end", { generation: d.generation, arm, family, attempt: att.id, reading: out.reading, base: baseR, diff_paths: diffPaths, model: rep.model, exit: rep.exitCode });
  return out;
}

export function calibrationFile(d: Pick<TrialDeps, "paths" | "runsDir" | "run">): string { return join(runsDir(d as TrialDeps), d.run, "calibration.jsonl"); }

export function readCalibration(file: string): Calibration[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** The run's calibration (see the file header); returns one record per trial family. */
export async function ensureCalibration(d: TrialDeps, base: string): Promise<Record<string, Calibration>> {
  const fams = d.families ?? TRIAL_FAMILIES;
  const file = calibrationFile(d);
  const have = new Map(readCalibration(file).map((c) => [c.family, c]));
  const missing = fams.filter((f) => !have.has(f));
  if (missing.length) {
    tlog("loop", "calibration.start", { run: d.run, families: missing, base_commit: base });
    const runs = await Promise.all(missing.flatMap((f) => [runArm("baseline", f, [], base, d), runArm("baseline", f, [], base, d)]));
    mkdirSync(join(file, ".."), { recursive: true });
    for (const f of missing) {
      const [a, b] = runs.filter((r) => r.family === f);
      const { spread, margin } = marginFor(f, a.reading, b.reading);
      const rec: Calibration = { run: d.run, at: new Date().toISOString(), family: f, baseline_runs: [a.reading, b.reading], spread, margin };
      appendFileSync(file, JSON.stringify(rec) + "\n");
      have.set(f, rec);
    }
    tlog("loop", "calibration.written", { run: d.run, records: missing.map((f) => have.get(f)) });
  }
  return Object.fromEntries(fams.map((f) => [f, have.get(f)!]));
}

export interface TrialOutput { verdict: Verdict; arms: ArmRun[]; calibration: Record<string, Calibration>; skillPath: string; placeboPath: string }

function shownOf(skillsDir: string, id: string): ShownSkill[] {
  return listSkills(skillsDir, "shadow").filter((s) => s.id === id);
}

/**
 * One shadow trial of `candidate` against `placebo` (see the file header). `kind` "policy" (D-0020) trials
 * policies/shadow/<id>/POLICY.md under the same rule: the candidate and placebo arms show the graduated skills with
 * their policy in task.policies, the baseline arm runs plain; the verdict's subject kind is "policy" and the moves
 * go to policies/graduated/ or policies/tombstones/.
 */
export async function runTrial(candidate: string, placebo: string, d: TrialDeps, kind: "skill" | "policy" = "skill"): Promise<TrialOutput> {
  const fams = d.families ?? TRIAL_FAMILIES;
  const base = git(d.paths.live, ["rev-parse", LIVE_BRANCH]);
  const calibration = await ensureCalibration(d, base);
  const refDir = join(d.paths.cache, "trial", `ref-${base.slice(0, 12)}`);
  coreAt(d.paths, base, refDir);
  const baseRef = await d.judge.score(join(refDir, "core"), "base");
  removeScratch(refDir);

  const store = kind === "skill" ? d.paths.skills : policiesDir(d.paths), file = kind === "skill" ? "SKILL.md" : "POLICY.md";
  const spec: Record<TrialArm, { shown: ShownSkill[]; policies: string[] }> = kind === "skill"
    ? { candidate: { shown: shownOf(d.paths.skills, candidate), policies: [] }, baseline: { shown: [], policies: [] }, placebo: { shown: shownOf(d.paths.skills, placebo), policies: [] } }
    : (() => {
        const shadow = loadPolicies(store, "shadow").map((p) => p.fm.id);
        if (!shadow.includes(candidate) || !shadow.includes(placebo)) throw new Error(`trial needs policies/shadow/${candidate} and policies/shadow/${placebo}`);
        const grad = listSkills(d.paths.skills, "graduated");
        return { candidate: { shown: grad, policies: [candidate] }, baseline: { shown: [], policies: [] }, placebo: { shown: grad, policies: [placebo] } };
      })();
  if (kind === "skill" && (!spec.candidate.shown.length || !spec.placebo.shown.length)) throw new Error(`trial needs skills/shadow/${candidate} and skills/shadow/${placebo}`);
  tlog("loop", "trial.start", { generation: d.generation, subject: kind, candidate, placebo, base_commit: base, families: fams });
  const jobs: Promise<ArmRun>[] = [];
  for (const f of fams) {
    for (const a of ["candidate", "baseline", "placebo"] as TrialArm[]) jobs.push(runArm(a, f, spec[a].shown, base, d, d.runner, spec[a].policies));
  }
  const arms = await Promise.all(jobs);
  const pick = (a: TrialArm) => fams.map((f) => arms.find((r) => r.arm === a && r.family === f)!.reading);
  const readings = { candidate: pick("candidate"), baseline: pick("baseline"), placebo: pick("placebo") };
  const margin = Object.fromEntries(fams.map((f) => [f, calibration[f].margin]));
  const armBase = Object.fromEntries((["candidate", "baseline", "placebo"] as TrialArm[]).map((a) => [a, arms.filter((r) => r.arm === a).map((r) => r.base)])) as Record<TrialArm, SuiteReading[][]>;
  const dec = decideSkill({ families: fams, readings, margin, baseRef, armBase });

  const verdict = appendNew<Verdict>("verdicts.jsonl", "VER", (id) => ({
    id, at: new Date().toISOString(), run: runId(), generation: d.generation, subject: { kind, id: candidate }, decision: dec.decision, checks: dec.checks,
    arms: { ...readings, margin, n_family_runs_per_arm: 1 }, reason: dec.reason, residue: [...SKILL_RESIDUE], rule_version: ruleVersion(),
  }), d.paths.ledger);
  tlog("loop", "trial.verdict", { generation: d.generation, verdict });

  const skillPath = dec.decision === "GRADUATE"
    ? graduateSkill(store, candidate, file)
    : tombstoneSkill(store, candidate, { was: "shadow", verdict: verdict.id, reason: dec.reason, successor: null }, file);
  const placeboPath = tombstoneSkill(store, placebo, { was: "shadow", verdict: verdict.id, reason: `retired: the placebo arm of ${candidate}'s shadow trial (${verdict.id})`, successor: null }, file);
  tlog("loop", `${kind}.move`, { generation: d.generation, candidate, to: skillPath, placebo, placebo_to: placeboPath, decision: dec.decision });

  const tf = join(runsDir(d), d.run, "trials.jsonl");
  mkdirSync(join(tf, ".."), { recursive: true });
  appendFileSync(tf, JSON.stringify({ at: new Date().toISOString(), generation: d.generation, subject: kind, candidate, placebo, verdict: verdict.id, decision: verdict.decision, base_commit: base, attempts: arms.map((a) => ({ arm: a.arm, family: a.family, attempt: a.attempt })) }) + "\n");
  return { verdict: current<Verdict>("verdicts.jsonl", verdict.id, d.paths.ledger)!, arms, calibration, skillPath, placeboPath };
}
