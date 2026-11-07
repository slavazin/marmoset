import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
process.env.RATCHET_TELEMETRY_DIR ??= mkdtempSync(join(tmpdir(), "ratchet-tel-"));
import { makeBed, setShade, FIX } from "./fixtures/harness.ts";
import { seedObservations, fakeLlm, markingRunner, markJudge } from "./fixtures/slow.ts";
import { runGeneration, generationsDue } from "./slow.ts";
import { ensureCalibration, readCalibration, calibrationFile } from "./trial.ts";
import { latchHooks } from "./latches.ts";
import { runMuseNative, nativeHome } from "./muse-native.ts";
import { runFastCycle } from "./fast.ts";
import { fakeRunner } from "./repair.ts";
import { isolatedReplayer } from "./replay-seam.ts";
import { append, all, current, read } from "./ledger.ts";
import { git } from "./paths.ts";
import { HOOK_MATCHER } from "./shown.ts";
import { TRIAL_FAMILIES, K } from "./gate.ts";
import { createServer } from "../server/index.ts";
import type { SuitesJudge } from "./gate-repair.ts";
import type { Attempt, Fire, HooksFile, Verdict } from "../src/schema.ts";

const steady: SuitesJudge = { async score() { return { readings: [], roms: {} }; } };
const RUN = "RUN-0001";

test("one generation on fixtures writes 2 nominations, their twins, one calibration record per trial family, 2 trials and 2 skill verdicts with arms; one graduates into .muse/hooks.json and fires in a later fast attempt, one is tombstoned", async () => {
  const bed = makeBed();
  seedObservations(bed);
  for (let i = 2; i <= K; i++) append("incidents.jsonl", { ...bed.incident, id: `INC-000${i}` }, bed.paths.ledger);
  const runsDir = join(bed.paths.root, "runs");
  assert.equal(generationsDue({ paths: bed.paths, run: RUN, runsDir }), 1);
  const runner = markingRunner();
  const judge = markJudge("SKL-0001");
  const g = await runGeneration({ paths: bed.paths, runner, judge, run: RUN, runsDir, llm: fakeLlm(), familyRoms: () => [], tReader: async () => [] });

  // nominations and twins
  assert.deepEqual(g.consolidation.nominated.map((n) => n.id), ["SKL-0001", "SKL-0002"]);
  assert.deepEqual(g.twins.map((t) => t.id), ["SKL-0003", "SKL-0004"]);
  // calibration: once, one record per trial family, baseline twice each
  const cal = readCalibration(calibrationFile({ paths: bed.paths, runsDir, run: RUN }));
  assert.deepEqual(cal.map((c) => c.family), [...TRIAL_FAMILIES]);
  for (const c of cal) { assert.equal(c.baseline_runs.length, 2); assert.equal(c.spread, 0); }
  // 4 calibration runs + 2 trials × 3 arms × 2 families
  assert.equal(runner.calls.length, 4 + 2 * 3 * TRIAL_FAMILIES.length);
  // every arm of a trial ran from one commit under one budget
  const atts = all<Attempt>("attempts.jsonl", bed.paths.ledger).filter((a) => a.task.kind === "family");
  assert.equal(new Set(atts.map((a) => a.task.base_commit)).size, 1);
  assert.equal(new Set(atts.map((a) => JSON.stringify(a.task.budget))).size, 1);
  assert.deepEqual(atts.filter((a) => a.task.arm === "placebo").map((a) => a.task.skills[0]).sort(), ["SKL-0003", "SKL-0003", "SKL-0004", "SKL-0004"]);
  // verdicts
  const vs = all<Verdict>("verdicts.jsonl", bed.paths.ledger);
  assert.deepEqual(vs.map((v) => [v.subject.id, v.decision]), [["SKL-0001", "GRADUATE"], ["SKL-0002", "REFUSE"]]);
  for (const v of vs) {
    assert.equal(v.arms!.n_family_runs_per_arm, 1);
    assert.deepEqual(Object.keys(v.arms!.margin), [...TRIAL_FAMILIES]);
    assert.equal(v.arms!.candidate.length, TRIAL_FAMILIES.length);
  }
  assert.match(vs[1].reason, /^trial-margin: /);
  // skill moves: graduated, tombstones with §6.10 frontmatter; no skill left in shadow
  assert.ok(existsSync(join(bed.paths.skills, "graduated", "SKL-0001", "SKILL.md")));
  assert.match(readFileSync(join(bed.paths.skills, "graduated", "SKL-0001", "SKILL.md"), "utf8"), /^status: graduated$/m);
  assert.deepEqual(readdirSync(join(bed.paths.skills, "shadow")), []);
  assert.deepEqual(readdirSync(join(bed.paths.skills, "tombstones")).sort(), ["SKL-0002.md", "SKL-0003.md", "SKL-0004.md"]);
  const tomb = readFileSync(join(bed.paths.skills, "tombstones", "SKL-0002.md"), "utf8");
  assert.match(tomb, /^---\nid: SKL-0002\nwas: shadow\nverdict: VER-0002\nreason: "trial-margin: .*"\nsuccessor: null\n---/);
  assert.match(tomb, /\*\*Do:\*\*/); // the skill's text travels with its tombstone
  // the generation's trial pairing and line
  assert.equal(readFileSync(join(runsDir, RUN, "trials.jsonl"), "utf8").trim().split("\n").length, 2);
  assert.equal(generationsDue({ paths: bed.paths, run: RUN, runsDir }), 0);
  // hooks
  const hooks = JSON.parse(readFileSync(g.hooks, "utf8")) as HooksFile;
  assert.deepEqual(hooks, { hooks: { PreToolUse: [{ matcher: HOOK_MATCHER, hooks: [{ type: "command", command: "node tools/fire.mjs SKL-0001" }] }] } });

  // a later fast attempt shows SKL-0001; running its scratch repo's hooks on an edit of core/ppu.ts appends a fire
  const { server } = createServer({ ledger: bed.paths.ledger, runs: runsDir, evidence: bed.paths.evidence, game: join(bed.paths.root, "game"), cache: bed.paths.cache });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  try {
    const port = (server.address() as AddressInfo).port;
    const paths = { ...bed.paths, server: `http://127.0.0.1:${port}` };
    // Muse runs hook commands while the tool call waits; the server answers in this process, so spawn async
    const inner = fakeRunner((d) => setShade(d, FIX), { dispositions: { "SKL-0001": "applied" }, off_map: null, beliefs: [], summary: "Renders a ROM's first byte as its shade." });
    const edit = {
      skillsList: inner.skillsList,
      async run(rr: Parameters<typeof inner.run>[0]) {
        const d = rr.cwd;
        const hk = JSON.parse(readFileSync(join(d, ".muse", "hooks.json"), "utf8")) as HooksFile;
        for (const m of hk.hooks.PreToolUse ?? []) for (const h of m.hooks) {
          const [, script, skill] = h.command.split(" ");
          await new Promise<void>((res) => {
            const ch = spawn(process.execPath, [join(d, script), skill], { cwd: d, env: { PATH: process.env.PATH ?? "" }, stdio: ["pipe", "ignore", "ignore"] });
            ch.on("close", () => res());
            ch.stdin.end(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: m.matcher, tool_input: { path: "core/ppu.ts" }, session_id: "s", cwd: d }));
          });
        }
        return inner.run(rr);
      },
    };
    const r = await runFastCycle("INC-0001", { paths, runner: edit, replayer: isolatedReplayer(paths.root), suites: steady, quiet: true });
    assert.deepEqual(r.attempt.task.skills, ["SKL-0001"]);
    const fires = read("fires.jsonl", bed.paths.ledger) as unknown as Fire[];
    assert.equal(fires.length, 1);
    assert.equal(fires[0].skill, "SKL-0001");
    assert.equal(fires[0].attempt, r.attempt.id);
    assert.deepEqual(r.attempt.fires, [fires[0].id]);
  } finally { server.close(); }
});

test("ensureCalibration reads an existing run's records and never re-runs or rewrites them", async () => {
  const bed = makeBed();
  const runsDir = join(bed.paths.root, "runs");
  const d = { paths: bed.paths, runner: markingRunner(), judge: markJudge("none"), run: RUN, runsDir, familyRoms: () => [], generation: 1 };
  const base = git(bed.paths.live, ["rev-parse", "core-live"]);
  await ensureCalibration(d, base);
  const file = calibrationFile(d);
  const first = readFileSync(file, "utf8");
  const runner2 = markingRunner();
  const again = await ensureCalibration({ ...d, runner: runner2 }, base);
  assert.equal(runner2.calls.length, 0);
  assert.equal(readFileSync(file, "utf8"), first);
  assert.deepEqual(Object.keys(again), [...TRIAL_FAMILIES]);
});

test("latchHooks compiles only graduated skills with activation paths, in D-0001's PreToolUse shape", () => {
  const bed = makeBed();
  assert.deepEqual(latchHooks(bed.paths.skills), { hooks: {} });
  for (const [id, p] of [["SKL-0001", "[core/ppu*.ts]"], ["SKL-0002", "[]"]]) {
    const dir = join(bed.paths.skills, "graduated", id);
    spawnSync("mkdir", ["-p", dir]);
    writeFileSync(join(dir, "SKILL.md"), `---\nid: ${id}\nstatus: graduated\nactivation:\n  paths: ${p}\n  owed: "x"\n---\n`);
  }
  spawnSync("mkdir", ["-p", join(bed.paths.skills, "shadow", "SKL-0003")]);
  writeFileSync(join(bed.paths.skills, "shadow", "SKL-0003", "SKILL.md"), `---\nid: SKL-0003\nactivation:\n  paths: [core/ppu*.ts]\n---\n`);
  assert.deepEqual(latchHooks(bed.paths.skills), { hooks: { PreToolUse: [{ matcher: "edit_file", hooks: [{ type: "command", command: "node tools/fire.mjs SKL-0001" }] }] } });
});

test("the muse-native arm writes its readings to runs/<run>/muse-native.jsonl only: no attempt, verdict or calibration record, under a persistent home", async () => {
  const bed = makeBed();
  const runsDir = join(bed.paths.root, "runs");
  const before = { attempts: read("attempts.jsonl", bed.paths.ledger).length, verdicts: read("verdicts.jsonl", bed.paths.ledger).length };
  const runner = markingRunner();
  const out = await runMuseNative({ paths: bed.paths, judge: markJudge("none"), run: RUN, runsDir, generation: 1, runner, familyRoms: () => [] });
  assert.equal(out.length, TRIAL_FAMILIES.length);
  const lines = readFileSync(join(runsDir, RUN, "muse-native.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.family), [...TRIAL_FAMILIES]);
  assert.ok(lines.every((l) => l.arm === "muse-native"));
  assert.equal(read("attempts.jsonl", bed.paths.ledger).length, before.attempts);
  assert.equal(read("verdicts.jsonl", bed.paths.ledger).length, before.verdicts);
  assert.ok(!existsSync(join(runsDir, RUN, "calibration.jsonl")));
  assert.ok(!existsSync(join(runsDir, RUN, "vread.json")));
  for (const c of runner.calls) assert.equal(c.env.HOME, nativeHome(bed.paths.cache));
  assert.ok(!readFileSync(join(bed.paths.ledger, "incidents.jsonl"), "utf8").includes("muse-native"));
  assert.equal(current("incidents.jsonl", "INC-0001", bed.paths.ledger) !== undefined, true);
});
