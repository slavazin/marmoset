// `pnpm replay:run <RUN-id|prerun> [--speed x] [--fixtures] [--no-vite]`: serves a recorded run to the UI. Starts the
// server (port PORT) in replay mode over ledger/ and runs/<id>/telemetry/ (server/replay.ts), then Vite (port 5173);
// the UI reads GET /api/replay and shows the replay bar and inspector. `--fixtures` reads ui/fixtures/{ledger,runs,evidence}
// (`pnpm replay:fixtures`). The replay process writes no telemetry: it would append to the run it replays.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, pathsFromEnv, PORT } from "./index.ts";
import { telemetryDir } from "./replay.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = process.argv.slice(2);
const run = args.find((a, k) => !a.startsWith("--") && args[k - 1] !== "--speed");
if (!run) { console.error("usage: replay:run <RUN-id|prerun> [--speed x] [--fixtures] [--no-vite]"); process.exit(2); }
const si = args.indexOf("--speed");
const speed = si >= 0 ? Number(args[si + 1]) : 1;
if (args.includes("--fixtures")) {
  process.env.RATCHET_LEDGER = "ui/fixtures/ledger";
  process.env.RATCHET_EVIDENCE = "ui/fixtures/evidence";
  process.env.RATCHET_RUNS = "ui/fixtures/runs";
}
const opts = pathsFromEnv();
if (!existsSync(telemetryDir(opts.runs, run))) console.error(`replay: no ${telemetryDir(opts.runs, run)}; ledger events only`);
const verifyFile = join(opts.runs, run, "telemetry-verify.jsonl");
const lastVerify = () => { try { return JSON.parse(readFileSync(verifyFile, "utf8").trim().split("\n").at(-1)!); } catch { return null; } };
const { server, player } = createServer({ ...opts, replay: { run, speed }, verifyReport: lastVerify });
server.listen(PORT, () => {
  const s = player!.status();
  console.log(`ratchet replay :${PORT} ${run} recorded ${s.recorded} · ${player!.tl.items.length} items over ${((s.t1 - s.t0) / 60000).toFixed(1)} min · regen ${s.regen ? s.regen.bundle_url : "none (holds sampled frames)"}`);
});
if (!args.includes("--no-vite")) {
  const vite = spawn(process.execPath, [resolve(root, "node_modules/vite/bin/vite.js")], { cwd: root, env: process.env, stdio: "inherit" });
  vite.on("exit", (c) => process.exit(c ?? 0));
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { vite.kill("SIGTERM"); process.exit(0); });
}
