// `pnpm dev`: starts the server (server/index.ts, port 8787) and Vite (port 5173) together; either exiting stops both.
// `--fixtures` points the server at ui/fixtures/ledger and ui/fixtures/evidence instead of ledger/ and evidence/.

import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const env = { ...process.env };
if (process.argv.includes("--fixtures")) {
  env.RATCHET_LEDGER = "ui/fixtures/ledger";
  env.RATCHET_EVIDENCE = "ui/fixtures/evidence";
  env.RATCHET_RUNS = "ui/fixtures/runs";
}

const kids: ChildProcess[] = [
  spawn(process.execPath, ["server/index.ts"], { cwd: root, env, stdio: "inherit" }),
  spawn(process.execPath, [resolve(root, "node_modules/vite/bin/vite.js")], { cwd: root, env, stdio: "inherit" }),
];
const stop = (code: number) => { for (const k of kids) k.kill("SIGTERM"); process.exit(code); };
for (const k of kids) k.on("exit", (c) => stop(c ?? 0));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
