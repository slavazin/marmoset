// Fixture copies of two runs for the run picker (S24): `makeRunsFixture(dir)` writes <dir>/ledger (RUN-0001, the
// shared ledger) and <dir>/runs/{RUN-0001,RUN-0004} with manifest, conditions, campaign.jsonl, a per-run ledger,
// evidence and telemetry, each ledger a copy of ui/fixtures/ledger with `run` set to that run's id (RUN-0004 keeps
// only INC-0001's attempt chain). The values are fixtures and enter no figure.
// Run: node ui/fixtures/make-runs.ts <dir>   then   RATCHET_LEDGER=<dir>/ledger RATCHET_RUNS=<dir>/runs
//   RATCHET_EVIDENCE=ui/fixtures/evidence node server/index.ts

import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const FX_LEDGER = join(here, "ledger");

function copyLedger(to: string, run: string, keep: (line: string) => boolean = () => true): void {
  mkdirSync(to, { recursive: true });
  for (const f of readdirSync(FX_LEDGER)) {
    const s = readFileSync(join(FX_LEDGER, f), "utf8");
    if (!f.endsWith(".jsonl")) { writeFileSync(join(to, f), s); continue; }
    writeFileSync(join(to, f), s.split("\n").filter((l) => l.trim() && keep(l)).map((l) => l.replace(/"run":null/g, `"run":"${run}"`)).join("\n") + "\n");
  }
}

function telemetry(dir: string, t0: string, frames: number): void {
  mkdirSync(dir, { recursive: true });
  const at = (s: number) => new Date(Date.parse(t0) + s * 1000).toISOString();
  writeFileSync(join(dir, "process.jsonl"), JSON.stringify({ at: at(0), seq: 0, pid: 1, stream: "process", kind: "start", data: { role: "campaign" } }) + "\n");
  writeFileSync(join(dir, "loop.jsonl"), Array.from({ length: frames }, (_, i) => JSON.stringify({ at: at(i * 60), seq: i + 1, pid: 1, stream: "loop", kind: "segment", data: { i } })).join("\n") + "\n");
}

export function makeRunsFixture(dir: string): { ledger: string; runs: string } {
  const runs = join(dir, "runs");
  copyLedger(join(dir, "ledger"), "RUN-0001");
  const r1 = join(runs, "RUN-0001");
  mkdirSync(r1, { recursive: true });
  writeFileSync(join(r1, "manifest.json"), JSON.stringify({ id: "RUN-0001", models: { repairer: "muse-spark-1.3 (not echoed)" } }));
  writeFileSync(join(r1, "campaign.jsonl"), [
    { t: "open", at: "2026-11-07T12:00:00Z", run: "RUN-0001" },
    { t: "pause", at: "2026-11-07T12:20:00Z", run: "RUN-0001" },
    { t: "stop", at: "2026-11-07T12:40:00Z", run: "RUN-0001", reason: "spend stop: fixture", attempts: 3 },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  telemetry(join(r1, "telemetry"), "2026-11-07T12:00:00Z", 40);

  const r4 = join(runs, "RUN-0004");
  copyLedger(join(r4, "ledger"), "RUN-0004", (l) => !/INC-0002|ATT-0002|ATT-0003|VER-0002|VER-0003/.test(l));
  cpSync(join(here, "evidence"), join(r4, "evidence"), { recursive: true });
  writeFileSync(join(r4, "manifest.json"), JSON.stringify({ id: "RUN-0004", models: { repairer: "muse-spark-1.3 (not echoed)" } }));
  writeFileSync(join(r4, "conditions.json"), JSON.stringify({ run: "RUN-0004", source: "play", rom: "/x/mario-yoshi-eu.gb", rom_sha: "062c243e167e819bcbea29c63158d1c616d185fd400ce94cbbef6f35cfd990b4", live_branch: "core-mario", s0_core_commit: "dcc327c90c49585c700987e8c875b43ed3492b1e" }));
  writeFileSync(join(r4, "campaign.jsonl"), JSON.stringify({ t: "stop", at: "2026-11-07T12:30:00Z", run: "RUN-0004", reason: "spend stop: $79.14 (priced) ≥ $80", attempts: 2 }) + "\n");
  telemetry(join(r4, "telemetry"), "2026-11-07T12:05:00Z", 30);
  writeFileSync(join(runs, "labels.json"), readFileSync(join(here, "..", "..", "runs", "labels.json")));
  return { ledger: join(dir, "ledger"), runs };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = resolve(process.argv[2] ?? "");
  if (!process.argv[2]) { console.error("usage: node ui/fixtures/make-runs.ts <dir>"); process.exit(2); }
  console.log(JSON.stringify(makeRunsFixture(out)));
}
