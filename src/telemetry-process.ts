// Process lifecycle telemetry (stream `process`, src/telemetry.ts). `processStart(name)` offers every Node entry point
// that runs in a campaign one call that logs its start (argv, git HEAD, node version, cwd, env variable NAMES, never
// values) and its stop (exit code, uptime). The replay server reads the start record's `head` to find the core commit.
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tlog } from "./telemetry.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The repository's HEAD commit, or "unknown" outside a git checkout. */
export function gitHead(dir = ROOT): string {
  try { return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return "unknown"; }
}

/** The start record's fields; env carries variable names only. */
export function startRecord(name: string): Record<string, unknown> {
  return { name, argv: process.argv.slice(1), head: gitHead(), node: process.version, cwd: process.cwd(), env_names: Object.keys(process.env).sort() };
}

let started: string | null = null;

/** Logs `process/start` once per process and `process/stop` at exit, or on SIGINT/SIGTERM when no other handler owns the signal. */
export function processStart(name: string): void {
  if (started) return;
  started = name;
  const t0 = Date.now();
  tlog("process", "start", startRecord(name));
  let stopped = false;
  const stop = (code: number | string) => { if (stopped) return; stopped = true; tlog("process", "stop", { name, code, uptime_s: (Date.now() - t0) / 1000 }); };
  process.on("exit", (code) => stop(code));
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      stop(sig);
      if (process.listenerCount(sig) === 1) process.exit(sig === "SIGINT" ? 130 : 143);
    });
  }
}
