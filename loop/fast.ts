// The fast loop (SPEC §2.3 fast loop, §5 S8). `runFastCycle(incidentId, deps)` runs one attempt on an open
// incident: it mints ATT-NNNN in ledger/attempts.jsonl, materialises the scratch repo (loop/projection.ts),
// runs the repairer (loop/repair.ts), gates the diff (loop/gate-repair.ts), flips the incident's status
// (GRADUATE → repaired; REFUSE on the MAX_ATTEMPTS-th attempt → unrepaired), and writes one Observation for the
// arm "fast" attempt. It reads skills and policies and never writes them; every graduated policy is named in
// task.policies (loop/policies.ts policiesInForce) and its routing picks the shown skills (selectShown). The SubQ
// forecasts (loop/sensors.ts senseAttempt) are asked where the attempt starts and where the repair returns its diff,
// before the gate; nothing here reads them.

import { MAX_ATTEMPTS, MAX_SHOWN, MAX_STEPS } from "./gate.ts";
import { policiesInForce } from "./policies.ts";
import { all, appendNew, current, runId, status } from "./ledger.ts";
import { git, LIVE_BRANCH, type LoopPaths } from "./paths.ts";
import { repairPacket } from "./projection.ts";
import { runRepair, type MuseRunner } from "./repair.ts";
import { gateAttempt, type GateOutput, type SuitesJudge } from "./gate-repair.ts";
import { listSkills, selectShown } from "./shown.ts";
import { senseAttempt } from "./sensors.ts";
import type { Replayer } from "./replay-seam.ts";
import { tlog } from "../src/telemetry.ts";
import { join } from "node:path";
import { loadSplits, familiesIn, familyRoms } from "../suites/splits.ts";
import type { Attempt, Fire, Incident, Observation, RepairTask, Verdict } from "../src/schema.ts";

/** The fast attempt's wall and its rate; their home is loop/budget.ts. */
export { ATTEMPT_WALL_S, SECONDS_PER_STEP } from "./budget.ts";
import { ATTEMPT_WALL_S } from "./budget.ts";

export interface FastDeps {
  paths: LoopPaths; runner: MuseRunner; replayer: Replayer; suites: SuitesJudge; quiet?: boolean;
  /**
   * Runs the gate step under the caller's mutex. The gate adds a worktree to the one live clone and merges into
   * core-live there, so parallel attempts (loop/campaign.ts) serialise it; absent, the gate runs directly.
   */
  gateLock?: <T>(fn: () => Promise<T>) => Promise<T>;
}
export interface CycleOutput { attempt: Attempt; verdict: Verdict; observation: Observation; gate: GateOutput }

/** The incidents an attempt may still be run on: status open and fewer than MAX_ATTEMPTS attempts. */
export function openIncidents(paths: LoopPaths): Incident[] {
  const atts = all<Attempt>("attempts.jsonl", paths.ledger);
  return all<Incident>("incidents.jsonl", paths.ledger).filter((i) => i.status === "open" && atts.filter((a) => a.task.incident === i.id).length < MAX_ATTEMPTS);
}

/** One sentence, one anchor, keyed on what the incident presents (SPEC §6.7). */
export function observationText(inc: Incident, v: Verdict, summary: string | undefined): string {
  const [x0, y0, x1, y1] = inc.signature.bbox;
  const failed = v.checks.find((c) => !c.pass);
  const outcome = v.decision === "GRADUATE" ? "graduated" : `refused at ${failed?.name ?? "the gate"}`;
  return `A ${inc.kind} divergence in scene ${inc.signature.scene}, line band ${inc.signature.band}, box ${x0},${y0}–${x1},${y1} (${inc.pixels} px) at counter ${inc.counter} was ${outcome} after a repair that ${summary ? summary.replace(/\.$/, "") : "wrote no summary"}.`;
}

export async function runFastCycle(incidentId: string, d: FastDeps): Promise<CycleOutput> {
  const { paths } = d;
  const inc = current<Incident>("incidents.jsonl", incidentId, paths.ledger);
  if (!inc) throw new Error(`no incident ${incidentId}`);
  if (inc.status !== "open") throw new Error(`${incidentId} is ${inc.status}, not open`);
  const prior = all<Attempt>("attempts.jsonl", paths.ledger).filter((a) => a.task.incident === incidentId).length;
  if (prior >= MAX_ATTEMPTS) throw new Error(`${incidentId} has ${prior} attempts; MAX_ATTEMPTS is ${MAX_ATTEMPTS}`);

  const t0 = performance.now();
  const ms: Record<string, number> = {};
  const lap = (k: string, from: number) => { ms[k] = Math.round(performance.now() - from); return performance.now(); };
  tlog("loop", "incident-picked", { incident: incidentId, prior_attempts: prior, kind: inc.kind, counter: inc.counter });
  const base = git(paths.live, ["rev-parse", LIVE_BRANCH]);
  const graduated = listSkills(paths.skills, "graduated");
  const fires = all<Fire>("fires.jsonl", paths.ledger);
  // every graduated policy is in force and named on the attempt (D-0020); routing policies pick the shown skills
  const draft: RepairTask = { kind: "incident", incident: incidentId, base_commit: base, arm: "fast", skills: [], policies: policiesInForce(paths), budget: { max_steps: MAX_STEPS, wall_s: ATTEMPT_WALL_S } };
  const shownIds = selectShown(graduated.map((s) => s.id), fires, MAX_SHOWN, { task: draft, ctx: { paths, incident: inc, skills: graduated, site: "shown" } });
  const task: RepairTask = { ...draft, skills: shownIds };

  const start = appendNew<Attempt>("attempts.jsonl", "ATT", (id) => ({
    id, at: new Date().toISOString(), run: runId(), task, branch: `attempt/${id}`, model: "", fires: [],
    spent: { steps: 0, wall_s: 0, tokens_in: 0, tokens_out: 0, usd: 0 }, scratch_files: [],
    isolation: { home: "", skills_list: "", observers: "on-identical", web_tools: "on" },
  }), paths.ledger);
  const id = start.id;
  tlog("loop", "attempt-start", { attempt: id, incident: incidentId, base_commit: base, skills: shownIds, policies: task.policies });
  const S = (field: string, value: unknown) => status("attempts.jsonl", id, field, value, paths.ledger);
  const sensing = senseAttempt({ paths, attempt: id, incident: inc, task }); // S17b forecasts: never read by the loop

  const splits = loadSplits();
  const tFamilies = Object.fromEntries(familiesIn(splits, "T").map((f) => [f, familyRoms(splits, f, paths.roms).map((r) => join(paths.roms, r))]));
  let t = performance.now();
  const packet = repairPacket(task, { attempt: id, paths, incident: inc, shown: graduated.filter((s) => shownIds.includes(s.id)), tFamilies });
  S("scratch_files", packet.files);
  t = lap("projection", t);
  const rep = await runRepair(task, packet, { attempt: id, server: paths.server, runner: d.runner });
  S("model", rep.model);
  S("spent", rep.spent);
  S("isolation", rep.isolation);
  const attFires = all<Fire>("fires.jsonl", paths.ledger).filter((f) => f.attempt === id).map((f) => f.id);
  S("fires", attFires);

  const attempt = { ...current<Attempt>("attempts.jsonl", id, paths.ledger)!, result: rep.result ?? undefined };
  t = lap("repair", t);
  const sensed = sensing.after({ diff: rep.diff }); // asked before the gate runs, awaited after it
  const runGate = () => gateAttempt({ attempt, diff: rep.diff, incident: inc, paths, replayer: d.replayer, suites: d.suites, quiet: d.quiet });
  const gate = d.gateLock ? await d.gateLock(runGate) : await runGate();
  lap("gate", t);
  ms.total = Math.round(performance.now() - t0);
  if (gate.head_commit) S("head_commit", gate.head_commit);
  if (gate.trace) S("admitted_trace", gate.trace);
  S("bundle", gate.bundle);
  // result last: the UI reads an attempt with a result as phase "end" (server/events.ts toEvent)
  S("result", rep.result ?? { dispositions: {}, off_map: null, beliefs: [], summary: `no packet/RESULT.json (muse exit ${rep.exitCode})` });

  tlog("loop", "attempt-end", { attempt: id, verdict: gate.verdict.id, decision: gate.verdict.decision, model: rep.model, spent: rep.spent, exit: rep.exitCode, summary: rep.result?.summary ?? null, ms });
  if (gate.verdict.decision === "GRADUATE") status("incidents.jsonl", incidentId, "status", "repaired", paths.ledger);
  // a parallel graduate's re-check (gate-repair.ts recheckIncidents) may have repaired it meanwhile: only an open one flips
  else if (prior + 1 >= MAX_ATTEMPTS && current<Incident>("incidents.jsonl", incidentId, paths.ledger)?.status === "open") status("incidents.jsonl", incidentId, "status", "unrepaired", paths.ledger);
  await sensed;

  const observation = appendNew<Observation>("observations.jsonl", "OBS", (oid) => ({
    id: oid, at: new Date().toISOString(), run: runId(), anchor: { incident: incidentId, attempt: id, counter: inc.counter },
    text: observationText(inc, gate.verdict, rep.result?.summary),
  }), paths.ledger);
  return { attempt: current<Attempt>("attempts.jsonl", id, paths.ledger)!, verdict: gate.verdict, observation, gate };
}
