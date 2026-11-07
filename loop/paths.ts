// The places the fast loop reads and writes, from the environment (SPEC §7.4). Every loop function takes a
// LoopPaths, so tests run the whole loop against temp directories and never touch the real live clone.

import { resolve, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

export interface LoopPaths {
  /** The repository whose loop/ and suites/ judge (main's checkout). */
  root: string;
  ledger: string;
  /** Admitted trace windows, traces/TRC-NNNN.json. */
  traces: string;
  skills: string;
  evidence: string;
  /** The live clone, branch core-live (D-0006). */
  live: string;
  cache: string;
  roms: string;
  server: string;
  /**
   * Root of the scratch repos (loop/projection.ts repairPacket), from RATCHET_SCRATCH. A hand-built LoopPaths
   * without it reads scratchRoot()'s fallback.
   */
  scratch?: string;
}

/**
 * Default scratch root: <os.tmpdir()>/ratchet-scratch. It sits under none of the cache, the repository, the live
 * clone or the ledger, so a `../` hop from a scratch repo lands in none of them (SPEC G7; D-draft-scratch-root;
 * held by projection.test.ts "no relative hop" for the paths the test bed builds).
 */
export const DEFAULT_SCRATCH = join(tmpdir(), "ratchet-scratch");

/** The scratch root of `paths`: its `scratch` field, else RATCHET_SCRATCH, else DEFAULT_SCRATCH. */
export function scratchRoot(paths: LoopPaths, env = process.env): string {
  return resolve(paths.scratch ?? expandHome(env.RATCHET_SCRATCH ?? DEFAULT_SCRATCH));
}

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

const ROOT = resolve(import.meta.dirname, "..");

/** Paths from RATCHET_LEDGER, RATCHET_LIVE (default ../ratchet-live), RATCHET_CACHE, RATCHET_ROMS, RATCHET_SERVER, RATCHET_SCRATCH. */
export function pathsFromEnv(env = process.env, root = ROOT): LoopPaths {
  return {
    root,
    ledger: resolve(root, env.RATCHET_LEDGER ?? "ledger"),
    traces: resolve(root, env.RATCHET_TRACES ?? "traces"),
    skills: resolve(root, env.RATCHET_SKILLS ?? "skills"),
    evidence: resolve(root, env.RATCHET_EVIDENCE ?? "evidence"),
    live: resolve(root, expandHome(env.RATCHET_LIVE ?? "../ratchet-live")),
    cache: resolve(expandHome(env.RATCHET_CACHE ?? "~/.cache/ratchet")),
    roms: resolve(expandHome(env.RATCHET_ROMS ?? "~/.cache/ratchet/roms")),
    server: env.RATCHET_SERVER ?? "http://localhost:8787",
    scratch: resolve(expandHome(env.RATCHET_SCRATCH ?? DEFAULT_SCRATCH)),
  };
}

/** Branch the gate commits to in the live clone (D-0006). */
export const LIVE_BRANCH = "core-live";

/** git in `cwd`; returns trimmed stdout, throws with stderr on a non-zero exit. */
export function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd, input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "ratchet-gate", GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "gate@ratchet.local", GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "ratchet-gate", GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? "gate@ratchet.local" },
    maxBuffer: 64 << 20,
  }).trim();
}
