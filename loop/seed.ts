// Live clone seed (SPEC §5 S8, D-0006): fast-forwards core-live in the live clone to `main` of the repository.
// Run once before the first attempt, after S1 merges: `node loop/seed.ts`. Refuses (throws) when core-live has
// commits main lacks, since from the seed on core/ changes only through the gate.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { git, pathsFromEnv, LIVE_BRANCH } from "./paths.ts";

export interface SeedResult { from: string; to: string; moved: boolean }

/** Fast-forwards `LIVE_BRANCH` in `live` to `mainRef` of `mainRepo`; the live clone must have core-live checked out and clean. */
export function seedLive(live: string, mainRepo: string, mainRef = "main"): SeedResult {
  const branch = git(live, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch !== LIVE_BRANCH) throw new Error(`live clone ${live} has ${branch} checked out, not ${LIVE_BRANCH}`);
  if (git(live, ["status", "--porcelain"])) throw new Error(`live clone ${live} has uncommitted changes`);
  const from = git(live, ["rev-parse", "HEAD"]);
  git(live, ["fetch", "--quiet", mainRepo, mainRef]);
  const to = git(live, ["rev-parse", "FETCH_HEAD"]);
  if (from === to) return { from, to, moved: false };
  git(live, ["merge", "--ff-only", "--quiet", "FETCH_HEAD"]);
  return { from, to: git(live, ["rev-parse", "HEAD"]), moved: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const p = pathsFromEnv();
  const r = seedLive(p.live, p.root);
  console.log(r.moved ? `${LIVE_BRANCH} ${r.from.slice(0, 8)} → ${r.to.slice(0, 8)}` : `${LIVE_BRANCH} at ${r.to.slice(0, 8)}, already main`);
}
