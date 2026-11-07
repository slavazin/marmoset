// `pnpm freeze`: curve freeze (SPEC §5 S10 step 1–2). Hashes S* (skills/graduated plus policies/graduated) into
// runs/<run>/manifest.json as s_star_sha and frozen_at, and writes runs/<run>/vread.lock with a fresh token under
// O_EXCL (loop/run-records.ts freeze). A second freeze is refused and changes nothing. Prints no token.

import { resolve } from "node:path";
import { pathsFromEnv } from "./paths.ts";
import { freeze, lockPath, RUN_ID } from "./run-records.ts";

const paths = pathsFromEnv();
const run = process.env.RATCHET_RUN || RUN_ID;
const runsDir = resolve(paths.root, process.env.RATCHET_RUNS ?? "runs");
try {
  const f = freeze({ runsDir, run, root: paths.root, skills: paths.skills });
  console.log(`${run} frozen at ${f.manifest.frozen_at}: s_star_sha ${f.manifest.s_star_sha} (s0_sha ${f.manifest.s0_sha}); lock ${lockPath(runsDir, run)}`);
} catch (e) { console.error(String(e instanceof Error ? e.message : e)); process.exitCode = 1; }
