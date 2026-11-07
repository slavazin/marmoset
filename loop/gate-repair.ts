// The gate's repair logic (SPEC §5 S8 `loop/gate.ts`, G4, G7), beside the rule constants in loop/gate.ts.
// `gateAttempt(input)` takes the scratch diff, refuses it at diff-scope when it touches a path outside core/**,
// adds a literal over LITERAL_LIMIT bytes, or contains the incident's frame hash or trace bytes, or when what git
// staged from it (read from the index, not the diff text) holds a non-core path, a symlink or a binary file; otherwise
// it applies the diff on branch attempt/<ATT> in the live clone. When core-live moved past task.base_commit (a
// parallel attempt graduated first), it rebases that commit onto core-live's head and judges the rebased candidate
// against the head; a rebase that conflicts or leaves nothing is a REFUSE at "merge" naming base_moved {from, onto}
// (gate.test.ts "two attempts from one base"). It then runs, cheapest first and stopping at the first failure:
// repro, admitted-traces, base-suites, H-no-regress. The judging code is this process's (main's loop/
// and suites/); only core/ comes from the branch. It appends one Verdict to ledger/verdicts.jsonl.
// GRADUATE merges the branch into core-live with trailers "Attempt: ATT-…" and "Skills: SKL-…"; a merge that throws
// turns the verdict into a REFUSE naming the error. The Verdict is appended next, before any side effect. The
// side effects then admit the trace window to traces/TRC-NNNN.json, write RepairResult.beliefs as ledger/beliefs/
// files marked suspected, regenerate ledger/provenance.json, re-check every other open or unrepaired incident on
// the merged head (recheckIncidents: repaired_by <VER> and status repaired when it no longer reproduces), run `pnpm core:bundle` (recorded as skipped when it
// fails) and post an SSE `core` event; each one that throws is listed in the verdict's `side_effect_error` status
// record and in the loop telemetry stream, and the rest still run (gate.test.ts "throwing provenance writer").
// REFUSE leaves the branch unmerged; the verdict is the attempt's tombstone (SPEC §6.10).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { RULE_CONSTANTS, LITERAL_LIMIT, H_TOLERANCE, SUITE_MIN_GAIN } from "./gate.ts";
import { all, appendNew, current, nextId, runId, status } from "./ledger.ts";
import { tlog } from "../src/telemetry.ts";
import { git, LIVE_BRANCH, type LoopPaths } from "./paths.ts";
import { romBySha, romDirs as searchDirs } from "./roms.ts";
import { loadCore, type Replayer } from "./replay-seam.ts";
import type { Attempt, CheckName, Incident, ProvenanceEntry, SuiteReading, Trace, Verdict } from "../src/schema.ts";

/** What every repair verdict does not check (SPEC §6.8 residue). */
export const REPAIR_RESIDUE: readonly string[] = ["audio", "CGB", "serial timing", "V (sealed)", "boot-state difference",
  "suite-incident repro, base-suites and H-no-regress run the core in-process, with reference images reachable",
  "the repairer's shell reads absolute paths outside the scratch repo (D-0018)"];
/** REPAIR_RESIDUE for a seatbelt-confined attempt: D-0021's residue replaces D-0018's read-open line. */
export const REPAIR_RESIDUE_CONFINED: readonly string[] = [...REPAIR_RESIDUE.slice(0, -1),
  "the repairer's network is denied except localhost and outbound HTTPS (D-0021)",
  "confinement covers macOS only, through sandbox-exec, which Apple deprecates (D-0021)"];
/** The residue a verdict on `attempt` carries: the confined list when its isolation reads confine "seatbelt". */
export function repairResidue(attempt: Pick<Attempt, "isolation">): readonly string[] {
  return (attempt.isolation as { confine?: string } | undefined)?.confine === "seatbelt" ? REPAIR_RESIDUE_CONFINED : REPAIR_RESIDUE;
}
/** Shortest trace-input JSON the memorisation check searches a diff for; shorter strings match by chance. */
export const MEMO_MIN_BYTES = 24;
/** Bytes of each cached oracle frame whose hex and base64 forms the memorisation check searches for. */
export const MEMO_FRAME_PREFIX = 32;

/** rule_version: sha256 of RULE_CONSTANTS' JSON, 12 hex digits (S10 hashes the same object into the manifest). */
export function ruleVersion(): string {
  return createHash("sha256").update(JSON.stringify(RULE_CONSTANTS)).digest("hex").slice(0, 12);
}

/** Paths a unified git diff touches (both sides of each `diff --git` header). */
export function diffPaths(diff: string): string[] {
  const out = new Set<string>();
  for (const m of diff.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)) { out.add(m[1]); out.add(m[2]); }
  return [...out];
}

/** The added lines of a diff, without their leading "+". */
export function addedLines(diff: string): string[] {
  return diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
}

/**
 * The longest literal an added line carries, in bytes: a quoted string, or a run of comma-separated numbers
 * (an array or table literal) on one line. Residue: a table split one number per line is not measured.
 */
export function longestLiteral(diff: string): { bytes: number; text: string } {
  let best = { bytes: 0, text: "" };
  const consider = (t: string) => { const b = Buffer.byteLength(t); if (b > best.bytes) best = { bytes: b, text: t.slice(0, 80) }; };
  for (const l of addedLines(diff)) {
    for (const m of l.matchAll(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g)) consider(m[0].slice(1, -1));
    for (const m of l.matchAll(/(?:-?(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\s*,\s*){3,}-?(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)/g)) consider(m[0]);
    for (const m of l.matchAll(/[A-Za-z0-9+/=]{48,}|[0-9a-fA-F]{40,}/g)) consider(m[0]);
  }
  return best;
}

/** The strings whose presence in a diff marks memorisation of the incident (SPEC §5 S8). */
export function memoNeedles(inc: Incident, trace: Pick<Trace, "inputs"> | null, frames: Uint8Array[]): string[] {
  const n = [inc.trace_sha, inc.rom_sha];
  if (trace) { const t = JSON.stringify(trace.inputs); if (t.length >= MEMO_MIN_BYTES) n.push(t); }
  for (const f of frames) {
    n.push(createHash("sha256").update(f).digest("hex"));
    const p = Buffer.from(f.subarray(0, MEMO_FRAME_PREFIX));
    n.push(p.toString("base64"), p.toString("hex"));
  }
  return n.filter((s) => s.length >= 16);
}

export interface Check { name: CheckName; pass: boolean; reading: unknown }

/** The diff-scope check: paths outside core/**, a literal over LITERAL_LIMIT, or a memorisation needle. */
export function diffScope(diff: string, needles: string[]): Check {
  const paths = diffPaths(diff);
  const outside = paths.filter((p) => !p.startsWith("core/"));
  const lit = longestLiteral(diff);
  const added = addedLines(diff).join("\n");
  const memo = needles.filter((s) => added.includes(s)).map((s) => s.slice(0, 16));
  const empty = paths.length === 0;
  return {
    name: "diff-scope",
    pass: !empty && outside.length === 0 && lit.bytes <= LITERAL_LIMIT && memo.length === 0,
    reading: { files: paths.length, outside, longest_literal_bytes: lit.bytes, literal_limit: LITERAL_LIMIT, memorised: memo, empty },
  };
}

/** File modes a repair may stage under core/: regular files, plus 000000 for a deletion. */
export const STAGED_MODES: readonly string[] = ["100644", "100755", "000000"];

/**
 * What `git apply --index` staged in `wt`, read from git's index (renames split): the paths outside core/,
 * entries whose new mode is not a regular file (a symlink, a submodule), and binary files.
 */
export function stagedFacts(wt: string): { outside: string[]; modes: string[]; binary: string[] } {
  const names = git(wt, ["diff", "--cached", "--no-renames", "--name-only", "-z"]).split("\0").filter(Boolean);
  const raw = git(wt, ["diff", "--cached", "--no-renames", "--raw", "-z"]).split("\0").filter(Boolean);
  const modes: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const newMode = raw[i].replace(/^:/, "").split(" ")[1];
    if (!STAGED_MODES.includes(newMode)) modes.push(`${raw[i + 1]} ${newMode}`);
  }
  const binary = git(wt, ["diff", "--cached", "--no-renames", "--numstat", "-z"]).split("\0").filter((l) => l.startsWith("-\t-\t")).map((l) => l.slice(4));
  return { outside: names.filter((p) => !p.startsWith("core/")), modes, binary };
}

/** Families a base reading holds that the attempt's reading does not. */
function missingFamilies(before: SuiteReading[], after: SuiteReading[]): string[] {
  return before.filter((b) => !after.some((a) => a.family === b.family)).map((b) => b.family);
}

/** The suites the gate judges with; `defaultSuites` runs suites/score.ts, tests pass fakes. */
export interface SuitesJudge {
  score(coreDir: string, split: "base" | "H"): Promise<{ readings: SuiteReading[]; roms: Record<string, boolean> }>;
}

export function defaultSuites(): SuitesJudge {
  return {
    async score(coreDir, split) {
      const { scoreFamilies } = await import("../suites/score.ts");
      const { createCore } = await loadCore(coreDir);
      const roms: Record<string, boolean> = {};
      const readings = scoreFamilies(createCore, { split, onRom: (_f, r) => { roms[r.rom] = r.pass; } });
      return { readings, roms };
    },
  };
}

export interface GateInput {
  attempt: Attempt;
  diff: string;
  incident: Incident;
  paths: LoopPaths;
  replayer: Replayer;
  suites: SuitesJudge;
  /** Skips the SSE post (tests). */
  quiet?: boolean;
  /** Side-effect overrides (tests): the provenance writer, default regenerateProvenance. */
  effects?: { provenance?: (paths: LoopPaths, tag: string) => Promise<unknown> };
}

export interface GateOutput { verdict: Verdict; branch: string; head_commit?: string; trace?: string; beliefs: string[]; bundle: string; repaired_by: string[] }

/** The incident's evidence dir (Incident.files.dir, relative to the repository or absolute). */
export function evidenceDir(paths: LoopPaths, inc: Incident): string {
  return resolve(paths.root, inc.files.dir);
}

/** The incident's trace: window.json's (lockstep/evidence.ts), else $RATCHET_CACHE/traces/<trace_sha>.json. */
export function workingTrace(paths: LoopPaths, inc: Incident): (Pick<Trace, "align" | "inputs" | "counter_end"> & { source?: Trace["source"] }) | null {
  const w = join(evidenceDir(paths, inc), "window.json");
  if (existsSync(w)) { const j = JSON.parse(readFileSync(w, "utf8")); if (j.trace) return j.trace; }
  const p = join(paths.cache, "traces", `${inc.trace_sha}.json`);
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}

function cachedFrames(paths: LoopPaths, inc: Incident): Uint8Array[] {
  const d = join(paths.cache, "oracle", inc.rom_sha, inc.trace_sha);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".bin")).map((f) => new Uint8Array(readFileSync(join(d, f))));
}

/** `rev`'s core/ from the clone at `live`, extracted by git archive under `dir`; returns `<dir>/core`. */
export function archiveCore(live: string, rev: string, dir: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const tar = execFileSync("git", ["archive", "--format=tar", rev, "core"], { cwd: live, maxBuffer: 256 << 20 });
  execFileSync("tar", ["-x", "-C", dir], { input: tar });
  return join(dir, "core");
}

/** Admitted traces: traces/TRC-NNNN.json records (Trace fields plus window, incident, attempt; status "retired" after a veto). */
export type AdmittedTrace = Trace & { window: [number, number]; incident?: string; attempt?: string; status?: "retired"; vetoed_by?: string };
/** The admitted traces the gate replays: every TRC file not retired by a veto (loop/steer.ts retireTraces). */
export function admittedTraces(dir: string): AdmittedTrace[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^TRC-\d+\.json$/.test(f)).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as AdmittedTrace)
    .filter((t) => t.status !== "retired");
}

async function baseReadings(judge: SuitesJudge, paths: LoopPaths, commit: string, coreDir: string, split: "base" | "H") {
  const f = join(paths.cache, "readings", `${commit}-${split}.json`);
  if (existsSync(f)) return JSON.parse(readFileSync(f, "utf8")) as Awaited<ReturnType<SuitesJudge["score"]>>;
  const r = await judge.score(coreDir, split);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, JSON.stringify(r));
  return r;
}

/** Trailers for a graduating commit: "Attempt: ATT-…" and "Skills: SKL-…" (SPEC §6.3). */
export function trailers(attempt: string, skills: string[]): string {
  return `Attempt: ${attempt}\nSkills: ${skills.length ? skills.join(", ") : "none"}`;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "belief";
}

/** Regenerates ledger/provenance.json from core-live: per handler, its file and the last commit touching it. */
export async function regenerateProvenance(paths: LoopPaths, tag: string): Promise<ProvenanceEntry[]> {
  const coreDir = archiveCore(paths.live, LIVE_BRANCH, join(paths.cache, "gate", `${tag}.prov`));
  const { HANDLERS } = await loadCore(coreDir);
  const out: ProvenanceEntry[] = [];
  for (const [handler, file] of Object.entries(HANDLERS)) {
    const rel = file.startsWith("core/") ? file : `core/${file}`;
    const log = git(paths.live, ["log", "-1", "--format=%H%x00%B", LIVE_BRANCH, "--", rel]);
    const [commit, body = ""] = log.split("\0");
    const e: ProvenanceEntry = { handler, file: rel, commit };
    const a = /^Attempt:\s*(ATT-\d+)/m.exec(body)?.[1];
    const s = /^Skills:\s*(SKL-\d+)/m.exec(body)?.[1];
    if (a) e.attempt = a;
    if (s) e.skill = s;
    out.push(e);
  }
  writeFileSync(join(paths.ledger, "provenance.json"), JSON.stringify(out, null, 2) + "\n");
  return out;
}

/** Runs `pnpm core:bundle` on `coreDir` into dist/core-<commit>.js; returns "built <path>" or "skipped: <why>". */
export function rebuildBundle(paths: LoopPaths, coreDir: string, commit: string): string {
  const pkg = join(paths.root, "package.json");
  const scripts = existsSync(pkg) ? (JSON.parse(readFileSync(pkg, "utf8")).scripts ?? {}) : {};
  if (!scripts["core:bundle"]) return "skipped: no core:bundle script";
  const out = join(paths.root, "dist", `core-${commit}.js`);
  const r = spawnSync("pnpm", ["-s", "core:bundle", coreDir, out], { cwd: paths.root, encoding: "utf8", env: { ...process.env, CORE_DIR: coreDir, BUNDLE_OUT: out } });
  if (r.status !== 0) return `skipped: core:bundle exit ${r.status ?? "spawn"}: ${(r.stderr || String(r.error ?? "")).trim().split("\n").at(-1) ?? ""}`.slice(0, 200);
  return `built dist/core-${commit}.js`;
}

async function postCore(server: string, commit: string): Promise<void> {
  try {
    await fetch(`${server}/api/event`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ t: "core", commit, bundle_url: `/dist/core-${commit}.js` }), signal: AbortSignal.timeout(2000) });
  } catch { /* no server: the core event is lost, the ledger holds the verdict */ }
}

/**
 * After a GRADUATE merge: replays every other open or unrepaired, non-sabotage incident on core-live's merged head;
 * one whose window replays clean (a suite incident: its ROM passes) gets status records repaired_by <verdict> and
 * status repaired. It mints no attempt. Returns the incident ids it flipped (gate.test.ts "repaired_by").
 */
export async function recheckIncidents(g: GateInput, verdictId: string): Promise<string[]> {
  const { paths } = g;
  const todo = all<Incident>("incidents.jsonl", paths.ledger).filter((i) => i.id !== g.incident.id && i.source !== "sabotage" && (i.status === "open" || i.status === "unrepaired"));
  if (!todo.length) return [];
  const coreDir = archiveCore(paths.live, LIVE_BRANCH, join(paths.cache, "gate", `${g.attempt.id}.recheck`));
  const romDirs = searchDirs(paths);
  const flipped: string[] = [];
  for (const i of todo) {
    let r: { clean: boolean };
    try { r = await g.replayer.incident({ coreDir, id: i.id, evidenceDir: evidenceDir(paths, i), rom: romBySha(i.rom_sha, romDirs), cache: paths.cache }); }
    catch (e) { tlog("loop", "recheck-error", { incident: i.id, verdict: verdictId, error: errText(e) }); continue; }
    tlog("loop", "recheck", { incident: i.id, verdict: verdictId, clean: r.clean });
    if (!r.clean) continue;
    status("incidents.jsonl", i.id, "repaired_by", verdictId, paths.ledger);
    status("incidents.jsonl", i.id, "status", "repaired", paths.ledger);
    flipped.push(i.id);
  }
  rmSync(join(coreDir, ".."), { recursive: true, force: true });
  return flipped;
}

/** Judges one attempt (see the file header); appends and returns the Verdict. */
export async function gateAttempt(g: GateInput): Promise<GateOutput> {
  const { attempt, diff, incident: inc, paths } = g;
  const branch = attempt.branch;
  const checks: Check[] = [];
  const trace = workingTrace(paths, inc);
  const tScope = performance.now();
  const scope = diffScope(diff, memoNeedles(inc, trace, cachedFrames(paths, inc)));
  checks.push(scope);
  tlog("loop", "gate-check", { attempt: attempt.id, name: scope.name, pass: scope.pass, reading: scope.reading, ms: Math.round(performance.now() - tScope) });

  // the attempt branch exists in the live clone whatever the verdict (G3)
  const wt = join(paths.cache, "gate", attempt.id);
  try { git(paths.live, ["worktree", "remove", "--force", wt]); } catch { /* none */ }
  rmSync(wt, { recursive: true, force: true });
  git(paths.live, ["worktree", "add", "--quiet", "-B", branch, wt, attempt.task.base_commit]);
  const evDir = join(paths.evidence, "attempts", attempt.id);
  mkdirSync(evDir, { recursive: true });
  writeFileSync(join(evDir, "diff.patch"), diff);
  let head: string | undefined;
  const msg = `${attempt.id}: ${attempt.result?.summary ?? "repair"}\n\n${trailers(attempt.id, attempt.task.skills)}`;
  if (scope.pass) {
    const patch = join(wt, "..", `${attempt.id}.patch`);
    writeFileSync(patch, diff);
    try {
      git(wt, ["apply", "--index", "--whitespace=nowarn", patch]);
      // what git applied, not what the diff text claims: a headerless hunk or a path with a space escapes diffPaths
      const staged = stagedFacts(wt);
      const r = scope.reading as Record<string, unknown> & { outside: string[] };
      r.outside = [...new Set([...r.outside, ...staged.outside])];
      if (staged.modes.length) r.modes = staged.modes;
      if (staged.binary.length) r.binary = staged.binary;
      if (r.outside.length || staged.modes.length || staged.binary.length) scope.pass = false;
      else {
        git(wt, ["commit", "--quiet", "--no-verify", "-m", msg]);
        head = git(wt, ["rev-parse", "HEAD"]);
      }
    } catch (e) {
      scope.pass = false;
      (scope.reading as Record<string, unknown>).apply_error = String((e as Error).message).split("\n")[0].slice(0, 200);
    }
  }

  // G4 under parallel attempts: when core-live moved past the attempt's base, the candidate is the attempt's commit
  // rebased onto core-live's head, and every later check (and its base reading) reads that head, not the stale base
  let judgedBase = attempt.task.base_commit;
  const liveHead = git(paths.live, ["rev-parse", LIVE_BRANCH]);
  if (scope.pass && head && liveHead !== attempt.task.base_commit) {
    const base_moved = { from: attempt.task.base_commit, onto: liveHead };
    try {
      git(wt, ["rebase", "--quiet", liveHead]);
      head = git(wt, ["rev-parse", "HEAD"]);
      if (head === liveHead) checks.push({ name: "merge", pass: false, reading: { base_moved, error: "empty after rebase: core-live already holds the change" } });
      else { judgedBase = liveHead; (scope.reading as Record<string, unknown>).base_moved = base_moved; }
    } catch (e) {
      try { git(wt, ["rebase", "--abort"]); } catch { /* no rebase in progress */ }
      checks.push({ name: "merge", pass: false, reading: { base_moved, error: `rebase onto ${LIVE_BRANCH} failed: ${errText(e)}` } });
    }
  }

  const run = async (name: CheckName, fn: () => Promise<{ pass: boolean; reading: unknown }>) => {
    if (checks.some((c) => !c.pass)) return;
    tlog("loop", "gate-check-start", { attempt: attempt.id, name });
    // a check that throws fails: the attempt still gets its REFUSE verdict (its tombstone)
    let r: { pass: boolean; reading: unknown };
    const t0 = performance.now();
    try { r = await fn(); } catch (e) { r = { pass: false, reading: { error: String((e as Error)?.message ?? e).split("\n")[0].slice(0, 200) } }; }
    tlog("loop", "gate-check", { attempt: attempt.id, name, ...r, ms: Math.round(performance.now() - t0) });
    checks.push({ name, ...r });
  };
  const coreDir = join(wt, "core");
  const baseDir = (): string => archiveCore(paths.live, judgedBase, join(paths.cache, "gate", `${attempt.id}.base`));
  const romDirs = searchDirs(paths);

  await run("repro", async () => {
    const rom = romBySha(inc.rom_sha, romDirs);
    const r = await g.replayer.incident({ coreDir, id: inc.id, evidenceDir: evidenceDir(paths, inc), rom, cache: paths.cache });
    if (inc.source === "suite") return { pass: r.clean || (r.gain ?? -1) >= SUITE_MIN_GAIN, reading: { ...r, min_gain: SUITE_MIN_GAIN } };
    return { pass: r.clean, reading: r };
  });
  await run("admitted-traces", async () => {
    const all = admittedTraces(paths.traces);
    const dirty: { id: string; line: string }[] = [];
    for (const t of all) {
      const r = await g.replayer.trace({ coreDir, id: t.id, tracesDir: paths.traces, rom: romBySha(t.rom_sha, romDirs), cache: paths.cache });
      if (!r.clean) dirty.push({ id: t.id, line: r.line.slice(0, 120) });
    }
    return { pass: dirty.length === 0, reading: { traces: all.length, dirty: dirty.slice(0, 8) } };
  });
  let baseDirCached: string | undefined;
  const bd = () => (baseDirCached ??= baseDir());
  await run("base-suites", async () => {
    const before = await baseReadings(g.suites, paths, judgedBase, bd(), "base");
    const after = await g.suites.score(coreDir, "base");
    const regressed = after.readings.filter((a) => { const b = before.readings.find((x) => x.family === a.family); return b && (a.pass < b.pass || a.pixel_match < b.pixel_match - 1e-9); }).map((a) => a.family)
      .concat(missingFamilies(before.readings, after.readings));
    return { pass: regressed.length === 0, reading: { families: after.readings.length, pass: after.readings.reduce((s, r) => s + r.pass, 0), roms: after.readings.reduce((s, r) => s + r.roms, 0), regressed } };
  });
  await run("H-no-regress", async () => {
    const before = await baseReadings(g.suites, paths, judgedBase, bd(), "H");
    const after = await g.suites.score(coreDir, "H");
    const drops: Record<string, number> = {};
    for (const a of after.readings) { const b = before.readings.find((x) => x.family === a.family); if (b && b.pixel_match - a.pixel_match > H_TOLERANCE) drops[a.family] = +(b.pixel_match - a.pixel_match).toFixed(5); }
    // a family or ROM read at the base and absent from the attempt's reading counts against it
    for (const f of missingFamilies(before.readings, after.readings)) drops[f] = before.readings.find((x) => x.family === f)!.pixel_match;
    const flipped = Object.keys(before.roms).filter((r) => before.roms[r] && after.roms[r] !== true);
    return { pass: Object.keys(drops).length === 0 && flipped.length === 0, reading: { families: after.readings.length, drops, flipped: flipped.slice(0, 8), tolerance: H_TOLERANCE } };
  });

  const failed = checks.find((c) => !c.pass);
  let decision: Verdict["decision"] = failed ? "REFUSE" : "GRADUATE";
  let reason = failed ? `${failed.name} failed: ${JSON.stringify(failed.reading).slice(0, 300)}` : `all ${checks.length} checks passed; deciding: ${checks.at(-1)!.name}`;
  const out: GateOutput = { verdict: undefined as unknown as Verdict, branch, head_commit: head, beliefs: [], bundle: "not run (REFUSE)", repaired_by: [] };

  // the merge decides the verdict: a merge that throws is a REFUSE naming the error, and core-live is left as it was
  let merged: string | undefined;
  if (decision === "GRADUATE") {
    try {
      git(paths.live, ["merge", "--no-ff", "--quiet", "-m", `graduate ${msg}`, branch]);
      merged = git(paths.live, ["rev-parse", "HEAD"]);
      out.head_commit = merged;
    } catch (e) {
      try { git(paths.live, ["merge", "--abort"]); } catch { /* no merge in progress */ }
      decision = "REFUSE";
      reason = `merge into ${LIVE_BRANCH} failed after ${checks.length} checks passed: ${errText(e)}`;
    }
  }

  // the Verdict is written before any side effect, so a side effect that throws never leaves a merge without one
  out.verdict = appendNew<Verdict>("verdicts.jsonl", "VER", (id) => ({
    id, at: new Date().toISOString(), run: runId(), subject: { kind: "attempt", id: attempt.id },
    decision, checks, reason: reason.slice(0, 500), residue: [...repairResidue(attempt)], rule_version: ruleVersion(),
  }), paths.ledger);
  tlog("loop", "verdict", { verdict: out.verdict.id, attempt: attempt.id, decision, reason: out.verdict.reason });

  if (merged) {
    const fx = g.effects ?? {};
    const errors: SideEffectError[] = [];
    const sideEffect = async (effect: string, f: () => unknown) => {
      try { await f(); } catch (e) {
        errors.push({ effect, error: errText(e) });
        // the cumulative list, so current() folds to every failure of this verdict
        status("verdicts.jsonl", out.verdict.id, "side_effect_error", [...errors], paths.ledger);
        tlog("loop", "side_effect_error", { verdict: out.verdict.id, attempt: attempt.id, effect, error: errText(e) });
      }
    };
    await sideEffect("trace", () => {
      mkdirSync(paths.traces, { recursive: true });
      const trc = nextId("TRC", readdirSync(paths.traces).map((f) => f.replace(/\.json$/, "")));
      const adm: AdmittedTrace = { id: trc, rom_sha: inc.rom_sha, align: inc.align, inputs: trace?.inputs ?? [], counter_end: inc.window[1], source: trace?.source ?? (inc.source === "suite" ? "suite" : "keyboard"), window: inc.window, incident: inc.id, attempt: attempt.id };
      writeFileSync(join(paths.traces, `${trc}.json`), JSON.stringify(adm, null, 2) + "\n");
      out.trace = trc;
    });
    await sideEffect("beliefs", () => {
      const bdir = join(paths.ledger, "beliefs");
      mkdirSync(bdir, { recursive: true });
      for (const b of attempt.result?.beliefs ?? []) {
        const id = nextId("BEL", readdirSync(bdir).map((f) => /^(BEL-\d+)/.exec(f)?.[1] ?? ""));
        writeFileSync(join(bdir, `${id}-${slug(b.claim)}.md`), `---\nid: ${id}\nmark: suspected\nanchors: [${inc.id}, ${attempt.id}]\ncontradicted-by: []\n---\n**Claim:** ${b.claim}\n**False if:** ${b.false_if}\n`);
        out.beliefs.push(id);
      }
    });
    await sideEffect("provenance", () => (fx.provenance ?? regenerateProvenance)(paths, attempt.id));
    await sideEffect("recheck", async () => { out.repaired_by = await recheckIncidents(g, out.verdict.id); });
    out.bundle = "not run (side effect failed)";
    await sideEffect("bundle", () => { out.bundle = rebuildBundle(paths, archiveCore(paths.live, LIVE_BRANCH, join(paths.cache, "gate", `${attempt.id}.bundle`)), merged!); });
    if (!g.quiet) await sideEffect("core-event", () => postCore(paths.server, merged!));
    if (errors.length) out.verdict = current<Verdict>("verdicts.jsonl", out.verdict.id, paths.ledger) ?? out.verdict;
  }
  return out;
}

/** One failed GRADUATE side effect, as the verdict's `side_effect_error` status record lists it. */
export interface SideEffectError { effect: string; error: string }

function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 300);
}
