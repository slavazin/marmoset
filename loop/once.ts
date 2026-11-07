// `pnpm loop:once [INC-id]`: one fast-loop cycle (loop/fast.ts) on the named open incident, else the first open
// incident with attempts left, with the real Muse runner (loop/repair.ts museCli) and the default replayer and
// suites. Prints the attempt, verdict and observation ids.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathsFromEnv } from "./paths.ts";
import { openIncidents, runFastCycle } from "./fast.ts";
import { museCli } from "./repair.ts";
import { defaultReplayer } from "./replay-seam.ts";
import { defaultSuites } from "./gate-repair.ts";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = pathsFromEnv();
  const id = process.argv[2] ?? openIncidents(paths)[0]?.id;
  if (!id) { console.error("loop:once: no open incident with attempts left in ledger/incidents.jsonl"); process.exit(1); }
  const r = await runFastCycle(id, { paths, runner: museCli, replayer: defaultReplayer(), suites: defaultSuites() });
  console.log(`${r.attempt.id} ${r.verdict.id} ${r.verdict.decision} ${r.observation.id}: ${r.verdict.reason}`);
}
