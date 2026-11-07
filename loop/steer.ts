// Owner steers (SPEC §5 S8, §6.7 Steer; GCE I2, I9). Offers:
//   steer(text, paths)    appends one Steer to ledger/steers.jsonl;      `pnpm steer "<text>"`
//   veto(verId, paths)    reverts a GRADUATE's merge in core-live within the verdict's run, regenerates
//                         ledger/provenance.json, and appends a Steer naming the verdict; `pnpm veto <VER-id>`.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { appendNew, current, runId, STEER_PREFIX } from "./ledger.ts";
import { git, LIVE_BRANCH, pathsFromEnv, type LoopPaths } from "./paths.ts";
import { regenerateProvenance } from "./gate-repair.ts";
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

export async function veto(verId: string, paths: LoopPaths): Promise<Steer> {
  const v = current<Verdict>("verdicts.jsonl", verId, paths.ledger);
  if (!v) throw new Error(`no verdict ${verId}`);
  if (v.decision !== "GRADUATE" || v.subject.kind !== "attempt") throw new Error(`${verId} is ${v.decision} of a ${v.subject.kind}; veto reverts attempt GRADUATEs only`);
  if (v.run !== runId()) throw new Error(`${verId} belongs to run ${v.run}, not this run ${runId()}`);
  const merge = graduateMerge(paths.live, v.subject.id);
  if (!merge) throw new Error(`no core-live merge for ${v.subject.id}`);
  git(paths.live, ["revert", "--no-edit", "-m", "1", merge]);
  const revert = git(paths.live, ["rev-parse", "HEAD"]);
  await regenerateProvenance(paths, `veto-${verId}`);
  return steer(`veto ${verId}: reverted ${v.subject.id}'s merge ${merge.slice(0, 10)} in ${LIVE_BRANCH} as ${revert.slice(0, 10)}`, paths, { vetoes: verId });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...rest] = process.argv.slice(2);
  const paths = pathsFromEnv();
  if (mode === "veto") {
    const s = await veto(rest[0] ?? "", paths);
    console.log(`${s.id} ${s.text}`);
  } else {
    const s = steer(rest.join(" "), paths);
    console.log(`${s.id} ${s.text}`);
  }
}
