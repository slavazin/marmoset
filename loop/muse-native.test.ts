// The muse-native arm (D-0013) and its watcher (loop/muse-native-watch.ts), on the loop fixture bed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBed } from "./fixtures/harness.ts";
import { fakeRunner } from "./repair.ts";
import { git } from "./paths.ts";
import { nativeFile, watchFile, watchStep } from "./muse-native-watch.ts";
import { readNative } from "../server/history.ts";
import type { TrialJudge } from "./trial.ts";

const judge: TrialJudge = { async score(_dir, split, family) { return [{ split, family: family ?? "fam", roms: 2, pass: 1, exact: 1, pixel_match: 0.5 }]; } };

function setup() {
  const bed = makeBed();
  const runs = mkdtempSync(join(tmpdir(), "ratchet-native-runs-"));
  const run = "RUN-0001";
  mkdirSync(join(runs, run), { recursive: true });
  writeFileSync(join(runs, run, "manifest.json"), JSON.stringify({ id: run }));
  const base = git(bed.paths.live, ["rev-parse", "HEAD"]);
  writeFileSync(join(runs, run, "generations.jsonl"), [1, 2, 3].map((g) => JSON.stringify({ generation: g, base_commit: base, run })).join("\n") + "\n");
  const home = mkdtempSync(join(tmpdir(), "ratchet-native-home-"));
  const runner = fakeRunner(() => {}, null);
  const d = { paths: bed.paths, run, runsDir: runs, judge, home, runner, families: ["fam-a", "fam-b"], familyRoms: () => [], log: () => {} };
  return { bed, runs, run, base, d, runner };
}

const snapshot = (dir: string) => Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => [f, readFileSync(join(dir, f), "utf8")]));

test("watcher: runs the arm once on the highest finished generation at its base_commit, lists the skipped ones, and writes readings with spent to runs/<run>/muse-native.jsonl only", async () => {
  const s = setup();
  const ledgerBefore = snapshot(s.bed.paths.ledger);
  const l = await watchStep(s.d);
  assert.equal(l.t, "pass");
  assert.deepEqual(l.t === "pass" && [l.generation, l.base_commit, l.readings], [3, s.base, 2]);
  const lines = readFileSync(watchFile(s.runs, s.run), "utf8").trim().split("\n").map((x) => JSON.parse(x));
  assert.deepEqual(lines.find((x) => x.t === "skip")?.generations, [1, 2]);
  const readings = readFileSync(nativeFile(s.runs, s.run), "utf8").trim().split("\n").map((x) => JSON.parse(x));
  assert.deepEqual(readings.map((r) => [r.arm, r.generation, r.family, r.base_commit]), [["muse-native", 3, "fam-a", s.base], ["muse-native", 3, "fam-b", s.base]]);
  assert.ok(readings.every((r) => typeof r.spent?.usd === "number"));
  assert.ok(s.runner.calls.every((c) => c.env.HOME === s.d.home), "every run uses the persistent HOME");
  // D-0013's false-if: no muse-native reading in verdicts, calibration or vread
  assert.deepEqual(snapshot(s.bed.paths.ledger), ledgerBefore, "the ledger is untouched");
  for (const f of ["calibration.jsonl", "vread.json"]) assert.equal(existsSync(join(s.runs, s.run, f)), false);
  assert.deepEqual(readNative(s.runs).map((r) => [r.run, r.generation, r.family, r.pixel_match]), [["RUN-0001", 3, "fam-a", 0.5], ["RUN-0001", 3, "fam-b", 0.5]]);
  // nothing left: a wait line naming the next generation, then a stop once the campaign stops
  const w = await watchStep(s.d);
  assert.deepEqual(w.t === "wait" && w.next, 4);
  writeFileSync(join(s.runs, s.run, "campaign.jsonl"), JSON.stringify({ t: "stop" }) + "\n");
  assert.equal((await watchStep(s.d)).t, "stop");
});

test("watcher: at the spend ask over the combined meter it runs no pass and writes a spend line", async () => {
  const s = setup();
  const p = join(s.runs, s.run, "spend-override.json");
  writeFileSync(p, JSON.stringify({ usd: 70, at: "2026-11-07T20:00:00.000Z", pre_run_usd: 0 }));
  utimesSync(p, new Date("2026-11-07T20:00:00.000Z"), new Date("2026-11-07T20:00:00.000Z"));
  const l = await watchStep(s.d);
  assert.equal(l.t, "spend");
  assert.match(l.t === "spend" ? l.line : "", /dropped at the spend ask \(D-0013\)/);
  assert.equal(existsSync(nativeFile(s.runs, s.run)), false);
  assert.equal(s.runner.calls.length, 0);
});

test("watcher with outDir: reads generations from the run's runs dir and writes readings and watch lines under outDir only, leaving the run's runs dir byte-identical", async () => {
  const s = setup();
  const out = mkdtempSync(join(tmpdir(), "ratchet-native-out-"));
  const before = snapshot(join(s.runs, s.run));
  const l = await watchStep({ ...s.d, outDir: out });
  assert.equal(l.t, "pass");
  assert.deepEqual(snapshot(join(s.runs, s.run)), before);
  assert.deepEqual(readdirSync(join(s.runs, s.run)).sort(), ["generations.jsonl", "manifest.json"]);
  assert.equal(readFileSync(nativeFile(out, s.run), "utf8").trim().split("\n").length, 2);
  assert.equal((await watchStep({ ...s.d, outDir: out })).t, "wait", "a second step reads the readings under outDir as done");
});
