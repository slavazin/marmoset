// The repair projection (SPEC §2.3 declared projection, §5 S8, G7). `repairPacket(task, ctx)` materialises the
// scratch repo at <scratch root>/<attempt>/ (paths.ts scratchRoot: $RATCHET_SCRATCH, default <tmpdir>/ratchet-scratch,
// under none of the cache, repository, live clone or ledger; D-0017) holding only:
//   core/ at the task's base commit (git archive from the live clone);
//   packet/ TASK.md (TASK_TEXT, plus the lines of task.policies via loop/policies.ts applyPolicies), task.json, ATTEMPT.json ({attempt, server}, for tools/fire.mjs), and for an incident task incident.json, trace.json and the evidence
//     files of evidence/incidents/<id>/ under packet/evidence/; roms.json, the ROM list tools/replay.mjs --family
//     reads, in its { families: { <name>: [paths under $RATCHET_ROMS] } } form (the task family; T for "fast");
//     T-family readings (readings-T.json) for arm "fast" only, when the caller supplies them;
//   tools/replay.mjs and tools/fire.mjs, copied from the repository when present;
//   .agents/skills/<SKL>/ for the shown skills, read-only, on the skill arms only (shown.ts SKILL_ARMS);
//   .muse/hooks.json (hooksFor: entries on the skill arms, [] on baseline and vread-baseline);
//   node_modules, a symlink to a read-only copy of the repository's under the scratch root (readOnlyModules);
//   .git, a one-commit repository whose HEAD is the projection, so the gate diffs against it.
// ROMs and the oracle cache sit outside the scratch repo at <attempt>.env/, holding read-only copies of the task's
// ROMs and of the incident trace's oracle frames only; `env` carries RATCHET_ROMS and RATCHET_CACHE pointing there. `allowed(arm, path)` is the allowlist
// projection.test.ts asserts against the real file list per arm.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, lstatSync, chmodSync, statSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { git, scratchRoot, type LoopPaths } from "./paths.ts";
import { hooksFor, listSkills, SKILL_ARMS, type ShownSkill } from "./shown.ts";
import { romBySha, romDirs } from "./roms.ts";
import { workingTrace } from "./gate-repair.ts";
import { applyPolicies } from "./policies.ts";
import type { Arm, Incident, RepairTask, SuiteReading } from "../src/schema.ts";

/** TASK.md, fixed text: the Core API contract, the replay commands, the RepairResult shape (SPEC §6.1, §6.6). */
export const TASK_TEXT = `# Repair task

Edit files under core/ only. The gate reads only the diff of core/** and refuses a diff that touches any other
path, adds a literal over the gate's literal limit, or contains the incident's frame hash or trace bytes.
Your budget is {max_steps} model steps and {wall_s} s of wall clock, after which you are stopped and an empty diff is refused, so make your first edit under core/ by step {half_steps} ({half_wall_s} s) and refine it with the replay after.

## Core API (core/index.ts)
export function createCore(rom: Uint8Array): Core;  // step, runFrame, runToCounter(n), cpu, read, frame() (160*144 shades 0..3),
                                                    // serial, cycles, setButtons(mask), snapshot/restore, tap
export const HANDLERS: Record<HandlerId, string>;  // handler id -> implementing file under core/

## The task
packet/task.json names the task. For an incident: packet/incident.json (first diverging counter, signature),
packet/trace.json (inputs and the window n-60 .. n+120), and the evidence files (core.png, oracle.png, diff.png,
regwrites.jsonl, window.json) under packet/evidence/. packet/roms.json lists the ROMs per family.

## Replay
node tools/replay.mjs --incident <INC-id> --core-dir core --evidence-dir packet/evidence
    reruns the window n-60..n+120 on core/ against the cached oracle frames; prints the first mismatch or "clean"
node tools/replay.mjs --family <family> --core-dir core --roms packet/roms.json
    scores one family; prints its reading as JSON
ROMs and oracle frames are reached through $RATCHET_ROMS and $RATCHET_CACHE.

## Skills
.agents/skills/ holds the skills shown to this attempt, read-only. Mark each one in RESULT.json.

## End by writing packet/RESULT.json
{ "dispositions": { "<SKL-id>": "applied" | "considered-not-applicable" },
  "off_map": null | "<one sentence naming a lesson you relied on that no shown skill holds>",
  "beliefs": [ { "claim": "<a hardware claim>", "false_if": "<the observation that falsifies it>" } ],
  "summary": "<one sentence: what the diff changes>" }
`;

/** TASK_TEXT with the task's budget filled in: its step cap and wall, and half of each for the first edit (D-0026). */
export function taskText(budget: RepairTask["budget"]): string {
  return TASK_TEXT.replace("{max_steps}", String(budget.max_steps)).replace("{wall_s}", String(budget.wall_s))
    .replace("{half_steps}", String(Math.floor(budget.max_steps / 2))).replace("{half_wall_s}", String(Math.floor(budget.wall_s / 2)));
}

export interface PacketContext {
  attempt: string;
  paths: LoopPaths;
  incident?: Incident;
  /** ROM paths for a family task, from suites/splits.ts familyRoms. */
  familyRoms?: string[];
  /** T families' ROM paths the fast arm may run (SPEC §5 S8), and the T readings at the base commit. */
  tFamilies?: Record<string, string[]>;
  tReadings?: SuiteReading[];
  /** Skill directories to show; defaults to the task's skill ids under skills/graduated/ (shadow for candidate). */
  shown?: ShownSkill[];
}

export interface Packet { dir: string; envDir: string; env: Record<string, string>; files: string[]; skills: ShownSkill[]; roms: string[] }

/** The allowlist: true when the scratch-repo path `rel` (posix, relative) may exist for `arm`. */
export function allowed(arm: Arm, rel: string): boolean {
  if (rel === "core" || rel.startsWith("core/")) return true;
  if (rel === "packet" || rel.startsWith("packet/")) return true;
  if (rel === "tools" || rel === "tools/replay.mjs" || rel === "tools/fire.mjs") return true;
  if (rel === ".muse" || rel === ".muse/hooks.json") return true;
  if (rel === "node_modules") return true;
  if (rel === ".git" || rel.startsWith(".git/")) return true;
  if (rel === ".agents" || rel === ".agents/skills") return SKILL_ARMS.has(arm);
  if (rel.startsWith(".agents/skills/")) return SKILL_ARMS.has(arm) && /^\.agents\/skills\/SKL-\d+(\/|$)/.test(rel);
  return false;
}

/** Every path under `dir`, relative and posix; symlinks are listed and not followed. */
export function fileList(dir: string, skip: (rel: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d).sort()) {
      const p = join(d, e);
      const rel = relative(dir, p).split("\\").join("/");
      if (skip(rel)) continue;
      out.push(rel);
      const st = lstatSync(p);
      if (st.isDirectory() && !st.isSymbolicLink()) walk(p);
    }
  };
  walk(dir);
  return out;
}

/** The scratch file list an Attempt records: every non-.git path, .git collapsed to one entry. */
export function scratchFiles(dir: string): string[] {
  return fileList(dir, (rel) => rel.startsWith(".git/"));
}

function makeReadOnly(p: string): void {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) for (const e of readdirSync(p)) makeReadOnly(join(p, e));
  chmodSync(p, st.mode & ~0o222);
}

/**
 * A read-only copy of `nm` under <scratch root>/node_modules-ro/<key>, made once per key (the lockfile's sha256 and
 * node_modules' mtime); pnpm's relative links are kept verbatim, so they resolve inside the copy. It sits under the
 * scratch root, not the cache, so `node_modules/..` from a scratch repo lands beside the scratch repos.
 */
export function readOnlyModules(nm: string, paths: LoopPaths): string {
  const lock = join(paths.root, "pnpm-lock.yaml");
  const key = createHash("sha256").update(existsSync(lock) ? readFileSync(lock) : "").update(String(statSync(nm).mtimeMs)).digest("hex").slice(0, 16);
  const out = join(scratchRoot(paths), "node_modules-ro", key);
  if (existsSync(out)) return out;
  const tmp = `${out}.tmp-${process.pid}`;
  removeScratch(tmp);
  cpSync(nm, tmp, { recursive: true, verbatimSymlinks: true });
  makeReadOnly(tmp);
  try { renameSync(tmp, out); } catch { removeScratch(tmp); /* a racing attempt made it */ }
  return out;
}

/** Removes a scratch dir, restoring write bits first (the skills dir is a-w). */
export function removeScratch(dir: string): void {
  if (!existsSync(dir)) return;
  try { execFileSync("chmod", ["-R", "u+w", dir]); } catch { /* best effort */ }
  rmSync(dir, { recursive: true, force: true });
}

/** Materialises the scratch repo for `task` (see the file header) and returns its real file list. */
export function repairPacket(task: RepairTask, ctx: PacketContext): Packet {
  const { paths } = ctx;
  const dir = join(scratchRoot(paths), ctx.attempt);
  const envDir = join(scratchRoot(paths), `${ctx.attempt}.env`);
  removeScratch(dir);
  removeScratch(envDir);
  mkdirSync(dir, { recursive: true });

  // core/ at the base commit
  const tar = execFileSync("git", ["archive", "--format=tar", task.base_commit, "core"], { cwd: paths.live, maxBuffer: 256 << 20 });
  execFileSync("tar", ["-x", "-C", dir], { input: tar });

  // packet/
  const pk = join(dir, "packet");
  mkdirSync(pk, { recursive: true });
  // packet and tool policies named in task.policies (D-0020): extra packet files and TASK.md lines
  const pol = applyPolicies(task, { paths, incident: ctx.incident, coreFiles: fileList(join(dir, "core")).map((f) => `core/${f}`), site: "packet" });
  const text = taskText(task.budget);
  writeFileSync(join(pk, "TASK.md"), pol.taskLines.length ? `${text}\n## Policy lines\n${pol.taskLines.map((l) => `- ${l}`).join("\n")}\n` : text);
  for (const [f, body] of Object.entries(pol.packetFiles)) writeFileSync(join(pk, f), body);
  writeFileSync(join(pk, "task.json"), JSON.stringify({ ...task, attempt: ctx.attempt }, null, 2));
  // hook commands run in a cleared environment (D-0001); tools/fire.mjs reads the attempt and server from here
  writeFileSync(join(pk, "ATTEMPT.json"), JSON.stringify({ attempt: ctx.attempt, server: paths.server }));
  const roms: string[] = [];
  const oracleTraces: { rom_sha: string; trace_sha: string }[] = [];
  const families: Record<string, string[]> = {};
  if (task.kind === "incident") {
    const inc = ctx.incident;
    if (!inc || inc.id !== task.incident) throw new Error(`incident task ${task.incident} needs its Incident record`);
    writeFileSync(join(pk, "incident.json"), JSON.stringify(inc, null, 2));
    const trace = workingTrace(paths, inc);
    if (trace) writeFileSync(join(pk, "trace.json"), JSON.stringify({ ...trace, window: inc.window }, null, 2));
    const ev = resolve(paths.root, inc.files.dir);
    if (existsSync(ev)) cpSync(ev, join(pk, "evidence"), { recursive: true, dereference: true });
    roms.push(romBySha(inc.rom_sha, romDirs(paths)));
    oracleTraces.push({ rom_sha: inc.rom_sha, trace_sha: inc.trace_sha });
  } else {
    families[task.family ?? ""] = ctx.familyRoms ?? [];
  }
  if (task.arm === "fast") {
    Object.assign(families, ctx.tFamilies ?? {});
    if (ctx.tReadings) writeFileSync(join(pk, "readings-T.json"), JSON.stringify(ctx.tReadings, null, 2));
  }
  for (const rs of Object.values(families)) roms.push(...rs);
  writeFileSync(join(pk, "roms.json"), JSON.stringify({ families: Object.fromEntries(Object.entries(families).map(([f, rs]) => [f, rs.map((r) => relative(paths.roms, r))])) }, null, 2));

  // tools/
  for (const t of ["replay.mjs", "fire.mjs"]) {
    const src = join(paths.root, "tools", t);
    if (existsSync(src)) { mkdirSync(join(dir, "tools"), { recursive: true }); cpSync(src, join(dir, "tools", t)); }
  }

  // shown skills and hooks
  const shown = SKILL_ARMS.has(task.arm)
    ? (ctx.shown ?? listSkills(paths.skills, task.arm === "candidate" ? "shadow" : "graduated").concat(task.arm === "candidate" ? listSkills(paths.skills, "graduated") : [])
        .filter((s) => task.skills.includes(s.id)))
    : [];
  if (shown.length) {
    const sk = join(dir, ".agents", "skills");
    for (const s of shown) cpSync(s.dir, join(sk, s.id), { recursive: true, dereference: true });
    makeReadOnly(sk);
  }
  mkdirSync(join(dir, ".muse"), { recursive: true });
  writeFileSync(join(dir, ".muse", "hooks.json"), JSON.stringify(hooksFor(task.arm, shown), null, 2));

  // environment paths: read-only copies of the task's ROMs and of its trace's oracle frames. A link would hand the
  // repairer a write path into the real cache the gate compares against, and the ROM's whole oracle dir holds
  // every other trace of that ROM.
  const romDir = join(envDir, "roms");
  mkdirSync(romDir, { recursive: true });
  for (const r of roms) {
    const rel = r.startsWith(paths.roms + "/") ? relative(paths.roms, r) : basename(r);
    mkdirSync(join(romDir, rel, ".."), { recursive: true });
    if (!existsSync(join(romDir, rel))) cpSync(r, join(romDir, rel), { dereference: true });
  }
  const cacheDir = join(envDir, "cache");
  mkdirSync(join(cacheDir, "oracle"), { recursive: true });
  for (const { rom_sha, trace_sha } of oracleTraces) {
    const o = join(paths.cache, "oracle", rom_sha, trace_sha);
    if (!existsSync(o)) continue;
    const copy = join(cacheDir, "oracle", rom_sha, trace_sha);
    cpSync(o, copy, { recursive: true, dereference: true });
    const w = join(pk, "evidence", "window.json");
    if (existsSync(w)) { const j = JSON.parse(readFileSync(w, "utf8")); if (j.oracle_dir) { j.oracle_dir = copy; writeFileSync(w, JSON.stringify(j, null, 2) + "\n"); } }
  }
  makeReadOnly(envDir);

  // node_modules: a link to a read-only copy (SPEC §5 S8 "symlinked read-only"), so a write through it cannot
  // reach the repository's node_modules, which the gate's in-process suites import (pngjs)
  const nm = join(paths.root, "node_modules");
  if (existsSync(nm)) symlinkSync(readOnlyModules(nm, paths), join(dir, "node_modules"));

  // the scratch repo's one commit
  git(dir, ["init", "--quiet"]);
  git(dir, ["add", "-A", "."]);
  git(dir, ["commit", "--quiet", "--no-verify", "-m", `projection ${ctx.attempt} @ ${task.base_commit}`]);

  return { dir, envDir, env: { RATCHET_ROMS: romDir, RATCHET_CACHE: cacheDir }, files: scratchFiles(dir), skills: shown, roms };
}
