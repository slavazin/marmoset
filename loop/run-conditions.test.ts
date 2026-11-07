// loop/run-conditions.ts: a run's declared starting conditions, refused when they differ or are shared.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, type LoopPaths } from "./paths.ts";
import { checkConditions, isolationClashes, openConditions, runConditions, type ConditionsInput } from "./run-conditions.ts";

function bed() {
  const root = mkdtempSync(join(tmpdir(), "ratchet-cond-"));
  const live = join(root, "live");
  mkdirSync(join(live, "core"), { recursive: true });
  writeFileSync(join(live, "core", "index.ts"), "export {};\n");
  git(live, ["init", "--quiet", "-b", "core-cgb"]);
  git(live, ["add", "core"]);
  git(live, ["commit", "--quiet", "-m", "s0"]);
  const rom = join(root, "game.gb");
  writeFileSync(rom, "rom");
  const splits = join(root, "splits.json");
  writeFileSync(splits, "{}");
  const runs = join(root, "repo", "runs");
  mkdirSync(runs, { recursive: true });
  const d = (n: string) => join(root, "run2", n);
  const paths: LoopPaths = { root: join(root, "repo"), ledger: d("ledger"), traces: d("traces"), skills: d("skills"), evidence: d("evidence"), live, cache: d("cache"), roms: join(root, "roms"), server: "http://localhost:1", scratch: d("scratch") };
  const env = { RATCHET_TELEMETRY_DIR: d("telemetry"), RATCHET_SUBQ_CACHE: d("subq") };
  const input: ConditionsInput = { run: "RUN-0002", paths, runsDir: runs, rom, source: "cgb-suite", seed0: 1001, liveBranch: "core-cgb", splits: [splits], ruleVersion: "rv", env };
  return { root, live, rom, runs, paths, env, input, head: git(live, ["rev-parse", "core-cgb"]) };
}

test("openConditions writes runs/<run>/conditions.json with the live branch head as s0_core_commit, and refuses a declared S0 commit the head is not", () => {
  const b = bed();
  assert.throws(() => openConditions(runConditions(b.input), { s0Commit: "f4650f1" }), /not the declared S0 core commit f4650f1/);
  const c = openConditions(runConditions(b.input), { s0Commit: b.head.slice(0, 7) });
  const onDisk = JSON.parse(readFileSync(join(b.runs, "RUN-0002", "conditions.json"), "utf8"));
  assert.equal(onDisk.s0_core_commit, b.head);
  assert.deepEqual(onDisk, c);
  assert.throws(() => openConditions(runConditions(b.input)), /EEXIST/);
});

test("checkConditions passes on the same conditions after the branch moves, and refuses a different ROM, seed0, rule_version, splits or per-run directory", () => {
  const b = bed();
  openConditions(runConditions(b.input));
  writeFileSync(join(b.live, "core", "index.ts"), "export const x = 1;\n");
  git(b.live, ["commit", "--quiet", "-am", "gate merge"]);
  assert.equal(checkConditions(runConditions(b.input)).run, "RUN-0002");
  const other = join(b.root, "other.gb");
  writeFileSync(other, "other rom");
  assert.throws(() => checkConditions(runConditions({ ...b.input, rom: other })), /rom: declared/);
  assert.throws(() => checkConditions(runConditions({ ...b.input, seed0: 2001 })), /seed0: declared 1001/);
  assert.throws(() => checkConditions(runConditions({ ...b.input, ruleVersion: "rv2" })), /rule_version/);
  writeFileSync(b.input.splits[0], '{"x":1}');
  assert.throws(() => checkConditions(runConditions(b.input)), /splits_sha/);
  writeFileSync(b.input.splits[0], "{}");
  assert.throws(() => checkConditions(runConditions({ ...b.input, env: { ...b.env, RATCHET_SUBQ_CACHE: join(b.root, "elsewhere") } })), /subq_cache/);
});

test("the ROM is compared by real path and sha: the same file through a symlink or ./ passes, the same path with other bytes refuses", () => {
  const b = bed();
  openConditions(runConditions(b.input));
  const link = join(b.root, "link to game.gb");
  symlinkSync(b.rom, link);
  assert.doesNotThrow(() => checkConditions(runConditions({ ...b.input, rom: link })));
  assert.doesNotThrow(() => checkConditions(runConditions({ ...b.input, rom: join(b.root, ".", "game.gb") })));
  writeFileSync(b.rom, "patched rom");
  assert.throws(() => checkConditions(runConditions(b.input)), /rom_sha/);
});

test("isolation: a run whose scratch, cache, subq-cache, telemetry or live clone is another run's is refused at open, including RUN-0001's defaults when it has a manifest and no conditions.json", () => {
  const b = bed();
  mkdirSync(join(b.runs, "RUN-0001"), { recursive: true });
  writeFileSync(join(b.runs, "RUN-0001", "manifest.json"), "{}");
  // RUN-0001 opened before conditions.json: its subq-cache and telemetry are <repo>/runs/RUN-0001/…
  const shared = { ...b.input, env: { RATCHET_TELEMETRY_DIR: join(b.paths.root, "runs", "RUN-0001", "telemetry"), RATCHET_SUBQ_CACHE: b.env.RATCHET_SUBQ_CACHE } };
  assert.match(isolationClashes(runConditions(shared), b.runs).join("; "), /telemetry: .* is RUN-0001's/);
  assert.throws(() => openConditions(runConditions(shared)), /shares per-run directories/);
  // a third run declaring RUN-0002's cache is refused once RUN-0002 is open
  openConditions(runConditions(b.input));
  const d3 = (n: string) => join(b.root, "run3", n);
  const third: ConditionsInput = { ...b.input, run: "RUN-0003", paths: { ...b.paths, ledger: d3("ledger"), skills: d3("skills"), evidence: d3("evidence"), traces: d3("traces"), scratch: d3("scratch") }, env: { RATCHET_TELEMETRY_DIR: d3("t"), RATCHET_SUBQ_CACHE: d3("s") } };
  const clash = isolationClashes(runConditions(third), b.runs);
  assert.ok(clash.some((x) => /^cache: .* is RUN-0002's$/.test(x)), clash.join("; "));
  assert.ok(clash.some((x) => /^live: .* is RUN-0002's$/.test(x)), clash.join("; "));
});
