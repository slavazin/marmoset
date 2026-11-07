import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { makeBed, setShade, writeSkill, FIX } from "./fixtures/harness.ts";
import { all, current } from "./ledger.ts";
import { coreAt } from "./trial.ts";
import { TRIAL_WALL_S } from "./budget.ts";
import { MAX_STEPS } from "./gate.ts";
import type { Attempt } from "../src/schema.ts";
import { fakeRunner } from "./repair.ts";
import { freeze, lockPath, manifestPath, openManifest, readLock, setSha, sDirs } from "./run-records.ts";
import { progressFile, runVRead, vreadFile, type VJudge } from "./vread.ts";
import type { Manifest, SuiteReading, VRead } from "../src/schema.ts";

const FAMS = ["fake:v-a", "fake:v-b"];
const reading = (family: string, pm: number): SuiteReading => ({ split: "V", family, roms: 1, pass: pm > 0.5 ? 1 : 0, exact: 0, pixel_match: pm });

function bed() {
  const b = makeBed();
  const runsDir = mkdtempSync(join(tmpdir(), "ratchet-runs-"));
  const m: Manifest = { id: "RUN-0001", opened_at: "2026-11-07T14:30:00.000Z", models: {}, oracle: { core: "fake", build_hash: "h" }, roms: {}, splits_sha: "s", rule_version: "r", s0_sha: setSha(b.paths.root, sDirs(b.paths.skills, b.paths.root)) };
  openManifest(runsDir, m);
  return { b, runsDir };
}

test("freeze writes s_star_sha and a vread.lock with a fresh token, and a second freeze is refused with both files unchanged", () => {
  const { b, runsDir } = bed();
  const f = freeze({ runsDir, run: "RUN-0001", root: b.paths.root, skills: b.paths.skills });
  assert.match(f.lock.token, /^[0-9a-f]{48}$/);
  assert.equal(readLock(runsDir, "RUN-0001")!.token, f.lock.token);
  assert.equal(f.manifest.s_star_sha, f.manifest.s0_sha);
  const lockBefore = readFileSync(lockPath(runsDir, "RUN-0001"), "utf8"), manBefore = readFileSync(manifestPath(runsDir, "RUN-0001"), "utf8");
  assert.throws(() => freeze({ runsDir, run: "RUN-0001", root: b.paths.root, skills: b.paths.skills }), /already frozen/);
  // even with the manifest's freeze fields stripped, the O_EXCL lock refuses a second token
  const m = JSON.parse(manBefore); delete m.s_star_sha; delete m.frozen_at;
  writeFileSync(manifestPath(runsDir, "RUN-0001"), JSON.stringify(m));
  assert.throws(() => freeze({ runsDir, run: "RUN-0001", root: b.paths.root, skills: b.paths.skills }), /vread.lock exists/);
  assert.equal(readFileSync(lockPath(runsDir, "RUN-0001"), "utf8"), lockBefore);
});

test("the V read checks the lock token before running anything: no lock, or a lock naming another run, starts no family-run", async () => {
  const { b, runsDir } = bed();
  const runner = fakeRunner(() => {}, null);
  const judge: VJudge = async (_d, f) => reading(f, 0);
  await assert.rejects(runVRead({ paths: b.paths, runsDir, run: "RUN-0001", runner, judge, families: FAMS, familyRoms: () => [b.incRom] }), /no .*vread.lock/);
  writeFileSync(lockPath(runsDir, "RUN-0001"), JSON.stringify({ run: "RUN-0009", at: "x", token: "t" }) + "\n");
  await assert.rejects(runVRead({ paths: b.paths, runsDir, run: "RUN-0001", runner, judge, families: FAMS, familyRoms: () => [b.incRom] }), /names RUN-0009/);
  assert.equal(runner.calls.length, 0);
  assert.equal(existsSync(progressFile(runsDir, "RUN-0001")), false);
});

test("a skill graduated after the freeze makes the V read refuse before any family-run: S* on disk no longer hashes to the manifest's s_star_sha", async () => {
  const { b, runsDir } = bed();
  freeze({ runsDir, run: "RUN-0001", root: b.paths.root, skills: b.paths.skills });
  writeSkill(b, "SKL-0001");
  const runner = fakeRunner(() => {}, null);
  await assert.rejects(runVRead({ paths: b.paths, runsDir, run: "RUN-0001", runner, judge: async (_d, f) => reading(f, 0), families: FAMS, familyRoms: () => [b.incRom] }), /s_star_sha/);
  assert.equal(runner.calls.length, 0);
  assert.equal(existsSync(progressFile(runsDir, "RUN-0001")), false);
});

test("a second V read cannot overwrite the first: a vread.json written while a read runs is kept and the read refuses; a progress file without a start record refuses a fresh start", async () => {
  const { b, runsDir } = bed();
  freeze({ runsDir, run: "RUN-0001", root: b.paths.root, skills: b.paths.skills });
  const runner = fakeRunner(() => {}, null);
  const out = vreadFile(runsDir, "RUN-0001");
  const judge: VJudge = async (_d, f) => { if (!existsSync(out)) writeFileSync(out, "other reader\n"); return reading(f, 0); };
  await assert.rejects(runVRead({ paths: b.paths, runsDir, run: "RUN-0001", runner, judge, families: FAMS, familyRoms: () => [b.incRom] }), /V is read once/);
  assert.equal(readFileSync(out, "utf8"), "other reader\n");
  // the repairer's environment never carries the lock's token (loop/repair.ts repairEnv)
  assert.ok(runner.calls.length > 0 && runner.calls.every((c) => !("RATCHET_VREAD_TOKEN" in c.env)));

  const t2 = bed();
  freeze({ runsDir: t2.runsDir, run: "RUN-0001", root: t2.b.paths.root, skills: t2.b.paths.skills });
  writeFileSync(progressFile(t2.runsDir, "RUN-0001"), "");
  await assert.rejects(runVRead({ paths: t2.b.paths, runsDir: t2.runsDir, run: "RUN-0001", runner, judge: async (_d, f) => reading(f, 0), families: FAMS, familyRoms: () => [t2.b.incRom] }), /exists/);
});

test("a V-read arm whose diff fails to apply is scored on the base core and marked apply_failed in vread.json and the progress file; every arm runs at TRIAL_WALL_S", async () => {
  const { b, runsDir } = bed();
  freeze({ runsDir, run: "RUN-0001", root: b.paths.root, skills: b.paths.skills });
  const runner = fakeRunner((d) => setShade(d, FIX), { dispositions: {}, off_map: null, beliefs: [], summary: "fixture" });
  // the ratchet arm's diff on fake:v-b fails to apply
  const applyCore: typeof coreAt = (paths, commit, dir, diff = "") => {
    const t = current<Attempt>("attempts.jsonl", basename(dir), b.paths.ledger)?.task; // the arm's core dir is named for its ATT
    if (diff && t?.arm === "vread-ratchet" && t.family === "fake:v-b") throw new Error("patch does not apply");
    return coreAt(paths, commit, dir, diff);
  };
  const v = await runVRead({ paths: b.paths, runsDir, run: "RUN-0001", runner, judge: async (_d, f) => reading(f, 0.5), families: FAMS, familyRoms: () => [b.incRom], applyCore });
  assert.deepEqual(v.arms.ratchet.map((r) => [r.family, r.apply_failed ?? false]), [["fake:v-a", false], ["fake:v-b", true]]);
  assert.ok(v.arms.baseline.every((r) => !r.apply_failed));
  const done = readFileSync(progressFile(runsDir, "RUN-0001"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.t === "done");
  assert.deepEqual(done.filter((r) => r.apply_failed).map((r) => [r.arm, r.family]), [["vread-ratchet", "fake:v-b"]]);
  const atts = all<Attempt>("attempts.jsonl", b.paths.ledger).filter((a) => a.task.kind === "family");
  assert.equal(atts.length, 4);
  assert.ok(atts.every((a) => a.task.budget.wall_s === TRIAL_WALL_S && a.task.budget.max_steps === MAX_STEPS));
});

test("a crashed V read reruns only its unfinished arm with --resume, and vread.json holds both arms with n and per-family readings", async () => {
  const { b, runsDir } = bed();
  freeze({ runsDir, run: "RUN-0001", root: b.paths.root, skills: b.paths.skills });
  const runner = fakeRunner((d) => setShade(d, FIX), { dispositions: {}, off_map: null, beliefs: [], summary: "fixture" });
  let crash = true;
  const tokens: (string | undefined)[] = [];
  const judge: VJudge = async (_dir, family) => {
    tokens.push(process.env.RATCHET_VREAD_TOKEN);
    if (crash && family === "fake:v-b" && runner.calls.at(-1)?.env.ATTEMPT_ID === "ATT-0004") { crash = false; throw new Error("judge crashed"); }
    return reading(family, family === "fake:v-a" ? 0.9 : 0.4);
  };
  const d = { paths: b.paths, runsDir, run: "RUN-0001", runner, judge, families: FAMS, familyRoms: () => [b.incRom] };
  await assert.rejects(runVRead(d), /1 of 4 family-runs failed/);
  assert.equal(runner.calls.length, 4);
  assert.equal(existsSync(vreadFile(runsDir, "RUN-0001")), false);
  await assert.rejects(runVRead(d), /pass --resume/);
  const v: VRead = await runVRead({ ...d, resume: true });
  assert.equal(runner.calls.length, 5, "only the crashed family-run reran");
  assert.equal(v.n_family_runs_per_arm, 1);
  assert.deepEqual(v.arms.baseline.map((r) => r.family), FAMS);
  assert.deepEqual(v.arms.ratchet.map((r) => [r.family, r.pixel_match]), [["fake:v-a", 0.9], ["fake:v-b", 0.4]]);
  assert.equal(v.s_star_sha, JSON.parse(readFileSync(manifestPath(runsDir, "RUN-0001"), "utf8")).s_star_sha);
  assert.ok(tokens.every((t) => t === readLock(runsDir, "RUN-0001")!.token), "every scoring ran with the lock's token");
  assert.equal(process.env.RATCHET_VREAD_TOKEN, undefined);
  await assert.rejects(runVRead({ ...d, resume: true }), /V is read once/);
});
