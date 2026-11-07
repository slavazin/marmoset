// Run records (SPEC §6.19, §5 S10; G6, G9). Offers:
//   setSha(dirs)                 sha256 over every file under the given dirs (relative path and content sha, sorted);
//                                S₀ is skills/graduated plus policies/graduated when the run opens, S* at curve freeze;
//   collectModels(o)             every echoed model string per role, from telemetry llm records and attempt records;
//                                a role with no echo reads "<pinned> (not echoed)";
//   buildManifest(o)             the Manifest: models, oracle info.build_hash, ROM sha256s of every splits.json ROM,
//                                the splits.json sha, rule_version over RULE_CONSTANTS, s0_sha;
//   openManifest(dir, m)         writes runs/<run>/manifest.json with O_EXCL: a second open throws;
//   freeze(o)                    appends s_star_sha and frozen_at to the manifest, then writes vread.lock with a fresh
//                                token under O_EXCL: a second freeze throws and leaves both files as they were;
//   readLock(dir)                the lock's first record, or null.

import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, relative } from "node:path";
import { ruleVersion } from "./gate-repair.ts";
import { repairerChoice, selectedLlm } from "./claude.ts";
import { SUBQ_MODEL } from "./route.ts";
import type { Manifest, Splits, VReadLock } from "../src/schema.ts";

/** The run S10 opens (SPEC §5 S10). */
export const RUN_ID = "RUN-0001";

/** Model pinned per role, read where each caller declares it; the manifest falls back to these when no echo is logged. */
export const PINNED_ROLES: Record<string, string> = {
  repairer: repairerChoice().model, consolidator: selectedLlm().model, router: SUBQ_MODEL,
  player: "gemini-3.8-flash", narrator: "gemini-4-argon", spotter: "gemini-3.8-flash", // player/gemini.ts, player/vision.ts
};

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

function walk(dir: string, base: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir).sort()) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, base, out);
    else out.push(p);
  }
}

/** sha256 over "<path relative to root>\t<content sha>\n" for every file under `dirs`, sorted; empty sets hash "". */
export function setSha(root: string, dirs: string[]): string {
  const files: string[] = [];
  for (const d of dirs) walk(d, root, files);
  return sha(files.map((f) => `${relative(root, f)}\t${sha(readFileSync(f))}\n`).sort().join(""));
}

/** The S dirs: skills/graduated and policies/graduated under the given skills dir and root. */
export function sDirs(skills: string, root: string): string[] { return [join(skills, "graduated"), join(root, "policies", "graduated")]; }

/** Every file under `dirs` except a .gitkeep, relative to each dir: the members setSha hashes beyond the placeholder. Empty is S₀ = ∅. */
export function sMembers(dirs: string[]): string[] {
  const out: string[] = [];
  for (const d of dirs) { const files: string[] = []; walk(d, d, files); out.push(...files.filter((f) => !f.endsWith("/.gitkeep")).map((f) => relative(join(d, ".."), f))); }
  return out.sort();
}

function jsonl(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  const out: Record<string, unknown>[] = [];
  for (const l of readFileSync(file, "utf8").split("\n")) { if (l.trim()) try { out.push(JSON.parse(l)); } catch { /* partial */ } }
  return out;
}

/** Every echoed model per role (see the file header); later records win. */
export function collectModels(o: { telemetryFiles: string[]; ledger: string }): Record<string, string> {
  const m: Record<string, string> = {};
  for (const f of o.telemetryFiles) {
    for (const r of jsonl(f)) {
      const d = r.data as Record<string, unknown> | undefined;
      const role = d?.role, echoed = d?.model_echoed;
      if (typeof role === "string" && typeof echoed === "string" && echoed) m[role] = echoed;
    }
  }
  for (const r of jsonl(join(o.ledger, "attempts.jsonl"))) {
    if (r.t === "status" && r.field === "model" && typeof r.value === "string" && r.value && !/not echoed|^fake/.test(r.value)) m.repairer = r.value;
  }
  for (const [role, pinned] of Object.entries(PINNED_ROLES)) m[role] ??= `${pinned} (not echoed)`;
  return m;
}

export interface ManifestInput {
  run: string; root: string; skills: string; ledger: string; roms: string;
  /** One splits file, or the files a merged loadSplits() reads (suites/splits.ts splitsPaths); splits_sha hashes them concatenated. */
  splitsPath: string | string[]; splits: Splits; familyRoms: (family: string) => string[];
  oracle: { core: string; build_hash: string };
  telemetryFiles: string[];
  now?: () => Date;
}

export function buildManifest(o: ManifestInput): Manifest {
  const roms: Record<string, string> = {};
  for (const f of Object.keys(o.splits.families).sort()) {
    for (const r of o.familyRoms(f)) { const p = join(o.roms, r); if (existsSync(p)) roms[r] = sha(readFileSync(p)); }
  }
  return {
    id: o.run, opened_at: (o.now?.() ?? new Date()).toISOString(), models: collectModels(o), oracle: o.oracle,
    roms, splits_sha: sha([o.splitsPath].flat().map((p) => readFileSync(p, "utf8")).join("")), rule_version: ruleVersion(), s0_sha: setSha(o.root, sDirs(o.skills, o.root)),
  };
}

export function runDir(runsDir: string, run: string): string { return join(runsDir, run); }
export const manifestPath = (runsDir: string, run: string) => join(runDir(runsDir, run), "manifest.json");
export const lockPath = (runsDir: string, run: string) => join(runDir(runsDir, run), "vread.lock");

/** Writes `body` to a file that must not exist (O_CREAT | O_EXCL); throws an EEXIST error when it does. */
export function writeExcl(p: string, body: string): void {
  mkdirSync(join(p, ".."), { recursive: true });
  const fd = openSync(p, "wx"); // O_CREAT | O_EXCL: throws EEXIST when the file is already there
  try { writeSync(fd, body); } finally { closeSync(fd); }
}

/** Writes the manifest with O_EXCL; throws when runs/<run>/manifest.json exists. */
export function openManifest(runsDir: string, m: Manifest): string {
  const p = manifestPath(runsDir, m.id);
  try { writeExcl(p, JSON.stringify(m, null, 2) + "\n"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${p} exists: the run is already open (pass --resume to continue it)`); throw e; }
  return p;
}

export function readManifest(runsDir: string, run: string): Manifest | null {
  const p = manifestPath(runsDir, run);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) as Manifest : null;
}

export function readLock(runsDir: string, run: string): VReadLock | null {
  const p = lockPath(runsDir, run);
  if (!existsSync(p)) return null;
  const first = readFileSync(p, "utf8").split("\n")[0];
  try { return JSON.parse(first) as VReadLock; } catch { return null; }
}

export interface FreezeOutput { manifest: Manifest; lock: VReadLock }

/** Curve freeze (see the file header). The lock is written first under O_EXCL, so a second freeze changes nothing. */
export function freeze(o: { runsDir: string; run: string; root: string; skills: string; now?: () => Date }): FreezeOutput {
  const m = readManifest(o.runsDir, o.run);
  if (!m) throw new Error(`${manifestPath(o.runsDir, o.run)} is missing: open the run with pnpm campaign first`);
  if (m.s_star_sha) throw new Error(`${o.run} is already frozen at ${m.frozen_at}`);
  const at = (o.now?.() ?? new Date()).toISOString();
  const lock: VReadLock = { run: o.run, at, token: randomBytes(24).toString("hex") };
  const lp = lockPath(o.runsDir, o.run);
  try { writeExcl(lp, JSON.stringify(lock) + "\n"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`${lp} exists: the V read is locked once per run`); throw e; }
  const frozen: Manifest = { ...m, s_star_sha: setSha(o.root, sDirs(o.skills, o.root)), frozen_at: at };
  const mp = manifestPath(o.runsDir, o.run);
  writeFileSync(`${mp}.tmp`, JSON.stringify(frozen, null, 2) + "\n");
  renameSync(`${mp}.tmp`, mp);
  return { manifest: frozen, lock };
}
