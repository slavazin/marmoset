// Owner steers (SPEC §5 S8, §6.7 Steer; GCE I2, I9). Offers:
//   steer(text, paths)    appends one Steer to ledger/steers.jsonl;      `pnpm steer "<text>"`
//   veto(verId, paths, {prerun})  reverts a GRADUATE's merge in core-live within the verdict's run (vetoRunCheck:
//                         an explicit non-null run match, or --prerun for a run-null verdict), regenerates
//                         ledger/provenance.json, retires the trace windows the attempt admitted, and appends a
//                         Steer naming the verdict; `pnpm veto <VER-id> [--prerun]`.

import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendNew, current, runId, STEER_PREFIX } from "./ledger.ts";
import { git, LIVE_BRANCH, pathsFromEnv, type LoopPaths } from "./paths.ts";
import { admittedTraces, regenerateProvenance } from "./gate-repair.ts";
import type { Steer, Verdict } from "../src/schema.ts";

export function steer(text: string, paths: LoopPaths, extra: Partial<Pick<Steer, "vetoes" | "latch_should_have_fired">> = {}): Steer {
  if (!text.trim()) throw new Error("a steer needs text");
  return appendNew<Steer>("steers.jsonl", STEER_PREFIX, (id) => ({ id, at: new Date().toISOString(), run: runId(), text: text.trim(), ...extra }), paths.ledger);
}

/** The core-live merge commit the gate made for `attempt` ("graduate ATT-…: …"), or null. */
export function graduateMerge(live: string, attempt: string): string | null {
  const out = git(live, ["log", LIVE_BRANCH, "--merges", "--format=%H %s"]);
  const line = out.split("\n").find((l) => l.split(" ")[1] === "graduate" && l.split(" ")[2] === `${attempt}:`);
  return line ? line.split(" ")[0] : null;
}

/**
 * Flips the traces/ windows `attempt` admitted to status "retired" with `vetoed_by` (a status flip, never a
 * deletion); the gate's admitted-traces check skips them, since the vetoed repair is no longer in core-live.
 */
export function retireTraces(paths: LoopPaths, attempt: string, verId: string): string[] {
  const out: string[] = [];
  for (const t of admittedTraces(paths.traces).filter((x) => x.attempt === attempt)) {
    writeFileSync(join(paths.traces, `${t.id}.json`), JSON.stringify({ ...t, status: "retired", vetoed_by: verId }, null, 2) + "\n");
    out.push(t.id);
  }
  return out;
}

/**
 * The run check veto applies: a verdict with a run is vetoed only from that same run (RATCHET_RUN set and equal);
 * a verdict with run null (written before any run opened) only with `prerun` (`pnpm veto <VER-id> --prerun`).
 * An unset RATCHET_RUN never matches a run-bearing verdict (S8-F13).
 */
export function vetoRunCheck(verdictRun: string | null, current: string | null, prerun: boolean): string | null {
  if (verdictRun === null) return prerun ? null : "it was written before any run opened (run null); pass --prerun to veto it";
  if (current === null) return `it belongs to run ${verdictRun} and RATCHET_RUN is unset`;
  if (verdictRun !== current) return `it belongs to run ${verdictRun}, not this run ${current}`;
  return null;
}

export async function veto(verId: string, paths: LoopPaths, opts: { prerun?: boolean } = {}): Promise<Steer> {
  const v = current<Verdict>("verdicts.jsonl", verId, paths.ledger);
  if (!v) throw new Error(`no verdict ${verId}`);
  if (v.decision !== "GRADUATE" || v.subject.kind !== "attempt") throw new Error(`${verId} is ${v.decision} of a ${v.subject.kind}; veto reverts attempt GRADUATEs only`);
  const refused = vetoRunCheck(v.run, runId(), opts.prerun === true);
  if (refused) throw new Error(`veto refuses ${verId}: ${refused}`);
  const merge = graduateMerge(paths.live, v.subject.id);
  if (!merge) throw new Error(`no core-live merge for ${v.subject.id}`);
  git(paths.live, ["revert", "--no-edit", "-m", "1", merge]);
  const revert = git(paths.live, ["rev-parse", "HEAD"]);
  await regenerateProvenance(paths, `veto-${verId}`);
  retireTraces(paths, v.subject.id, verId);
  return steer(`veto ${verId}: reverted ${v.subject.id}'s merge ${merge.slice(0, 10)} in ${LIVE_BRANCH} as ${revert.slice(0, 10)}`, paths, { vetoes: verId });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...rest] = process.argv.slice(2);
  const paths = pathsFromEnv();
  if (mode === "veto") {
    const s = await veto(rest.find((a) => !a.startsWith("--")) ?? "", paths, { prerun: rest.includes("--prerun") });
    console.log(`${s.id} ${s.text}`);
  } else {
    const s = steer(rest.join(" "), paths);
    console.log(`${s.id} ${s.text}`);
  }
}
