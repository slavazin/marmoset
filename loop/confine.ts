// Seatbelt confinement of every Muse Code run (D-0021; SPEC G7, G8). `seatbeltProfile(paths)` builds one attempt's
// SBPL profile from resolved real paths (seatbelt matches /private/var/…, never the /var symlink).
// - Reads denied: the repository (the worktree and its main checkout), the cache, both live clones, and the scratch root.
//   Reads allowed again: this attempt's scratch repo, its .env dir, its HOME and the read-only node_modules copy.
// - Writes denied everywhere. Writes allowed again: temp, /dev/null and /dev/tty. Then writes are denied again for
//   the scratch root and the denied-read paths, because the scratch root sits under temp by default
//   (D-0017). Last, writes are allowed again for this attempt's scratch repo and HOME.
// - Network denied, except localhost and outbound TCP on CONFINE_OUTBOUND_TCP_PORTS (see that constant).
// SBPL applies the last matching rule, so each deny comes before the allows that carve it open.
// `confinedCommand(run)` is what museCli spawns: `sandbox-exec -f <profile> muse …` on darwin unless RATCHET_CONFINE=0.

import { createHash } from "node:crypto";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { pathsFromEnv } from "./paths.ts";
import type { Attempt } from "../src/schema.ts";

/** How a Muse run was confined: "seatbelt" (sandbox-exec, D-0021) or "none" (not darwin, RATCHET_CONFINE=0, or a fake runner). */
export type Confine = "seatbelt" | "none";
/** Attempt["isolation"] plus `confine`. src/schema.ts does not have the field yet; it is written as a status field. */
export type ConfinedIsolation = Attempt["isolation"] & { confine?: Confine };

/** The seatbelt launcher (macOS only; deprecated by Apple, D-0021 residue). */
export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/**
 * Outbound TCP ports the confined process may reach on any host. A localhost-only profile also blocks Muse's own
 * model API (HTTPS), so the attempt could not run. 443 is the API port. The shell can therefore reach any HTTPS host.
 * Reading: a scratchpad sandbox-exec run on 2026-11-07, with this profile's network rules, got curl https://example.com
 * 200 and http://example.com exit 7 (refused). See D-0024.
 */
export const CONFINE_OUTBOUND_TCP_PORTS: readonly number[] = [443];
/** The DNS resolver socket. Name lookups for the model API go through it. */
export const DNS_SOCKET = "/private/var/run/mDNSResponder";

/** Whether this process confines Muse runs: darwin and RATCHET_CONFINE is not "0". */
export function confineOn(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" && env.RATCHET_CONFINE !== "0";
}

/** The real path of `p`; for a missing path, the real path of its nearest existing ancestor joined with the rest. */
export function real(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync(abs);
  const parent = dirname(abs);
  return parent === abs ? abs : join(real(parent), basename(abs));
}

/** The paths one attempt's profile is built from. */
export interface ConfinePaths {
  /** This attempt's scratch repo, <scratch root>/<ATT>. */
  attemptDir: string;
  /** Its HOME, <scratch root>/<ATT>.home. */
  home: string;
  /** Its ROM and oracle-cache copies, <scratch root>/<ATT>.env. */
  envDir: string;
  scratchRoot: string;
  /** Repository checkouts whose reads are denied (the loop's root and, from a worktree, the main checkout). */
  repos: string[];
  cache: string;
  /** Live clones whose reads are denied (RATCHET_LIVE and ratchet-live-cgb beside it). */
  lives: string[];
  /** Read-only node_modules copy the scratch repo's node_modules links to, if any. */
  modules?: string;
}

const q = (p: string) => JSON.stringify(p);
const sub = (ps: string[]) => ps.map((p) => `(subpath ${q(p)})`).join(" ");

/** The SBPL profile for one attempt (see the file header). Every path is resolved with real() first. */
export function seatbeltProfile(c: ConfinePaths): string {
  const R = (ps: (string | undefined)[]) => [...new Set(ps.filter((p): p is string => !!p).map(real))];
  const readable = R([c.attemptDir, c.envDir, c.home, c.modules]);
  const writable = R([c.attemptDir, c.home]);
  const denied = R([...c.repos, c.cache, ...c.lives, c.scratchRoot]);
  const temp = R(["/private/tmp", "/private/var/folders", tmpdir()]);
  return [
    "(version 1)",
    "(allow default)",
    "(deny network*)",
    `(allow network* (remote ip "localhost:*"))`,
    ...CONFINE_OUTBOUND_TCP_PORTS.map((p) => `(allow network-outbound (remote tcp "*:${p}"))`),
    `(allow network* (remote unix-socket (path-literal ${q(DNS_SOCKET)})))`,
    `(deny file-read* ${sub(denied)})`,
    // the directory nodes themselves stay stat-able, so realpath of the scratch repo works; their listings stay denied
    `(allow file-read-metadata ${denied.map((p) => `(literal ${q(p)})`).join(" ")})`,
    `(allow file-read* ${sub(readable)})`,
    `(deny file-write* (subpath "/"))`,
    `(allow file-write* ${sub(temp)} (literal "/dev/null") (literal "/dev/tty"))`,
    `(deny file-write* ${sub(denied)})`,
    `(allow file-write* ${sub(writable)})`,
    "",
  ].join("\n");
}

/** The main checkout of `root` when it is a git worktree (git's common dir's parent), else `root`. */
function mainCheckout(root: string): string {
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return dirname(common);
  } catch { return root; }
}

/** ConfinePaths for a Muse run in scratch repo `cwd` with HOME `home`; repository, cache and live clones from the environment. */
export function confinePathsFor(cwd: string, home: string, env: NodeJS.ProcessEnv = process.env): ConfinePaths {
  const p = pathsFromEnv(env);
  const nm = join(cwd, "node_modules");
  return {
    attemptDir: cwd, home, envDir: `${cwd}.env`, scratchRoot: dirname(resolve(cwd)),
    repos: [...new Set([p.root, mainCheckout(p.root)])], cache: p.cache,
    lives: [p.live, join(dirname(p.live), "ratchet-live-cgb")],
    modules: existsSync(nm) ? realpathSync(nm) : undefined,
  };
}

/** Where the profile is written: <scratch root>/<ATT>.sb, beside the attempt's dirs and readable from none of them. */
export function profilePath(cwd: string): string {
  return `${resolve(cwd)}.sb`;
}

/** The argv museCli spawns for `bin args` in `cwd`, and how it is confined. Writes the profile when confined. */
export function confinedCommand(bin: string, args: string[], cwd: string, home: string, on = confineOn()): { cmd: string; argv: string[]; confine: Confine; profile?: string; sha256?: string } {
  if (!on) return { cmd: bin, argv: args, confine: "none" };
  const profile = profilePath(cwd);
  const text = seatbeltProfile(confinePathsFor(cwd, home));
  writeFileSync(profile, text);
  return { cmd: SANDBOX_EXEC, argv: ["-f", profile, bin, ...args], confine: "seatbelt", profile, sha256: createHash("sha256").update(text).digest("hex") };
}

/** Muse's own sandbox flag: off when seatbelt confines the run, since Muse's sandbox cannot start inside sandbox-exec (D-0021). */
export function sandboxFlag(confine: Confine): string[] {
  return confine === "seatbelt" ? ["--disable-sandbox"] : [];
}
