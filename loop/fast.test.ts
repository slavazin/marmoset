import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { makeBed, setShade, FIX, writeSkill } from "./fixtures/harness.ts";
import { runFastCycle, openIncidents } from "./fast.ts";
import { fakeRunner, museArgs, usageFromEvents, repairEnv } from "./repair.ts";
import { toolReplayer } from "./replay-seam.ts";
import { current, read } from "./ledger.ts";
import { steer, veto } from "./steer.ts";
import { seedLive } from "./seed.ts";
import { git } from "./paths.ts";
import type { SuitesJudge } from "./gate-repair.ts";
import { createServer } from "../server/index.ts";
import type { Attempt, Incident, Verdict } from "../src/schema.ts";

const steady: SuitesJudge = { async score() { return { readings: [], roms: {} }; } };
const RESULT = { dispositions: { "SKL-0001": "applied" as const }, off_map: null, beliefs: [{ claim: "A fixture frame's shade is its ROM's first byte.", false_if: "the oracle renders a ROM with first byte 2 as shade 3." }], summary: "Renders a ROM's first byte as its shade." };

test("one fast cycle with the fake runner writes an attempt, a GRADUATE verdict and an observation, and the server state renders them", async () => {
  const bed = makeBed();
  writeSkill(bed, "SKL-0001");
  const runner = fakeRunner((d) => setShade(d, FIX), RESULT);
  const r = await runFastCycle("INC-0001", { paths: bed.paths, runner, replayer: toolReplayer(bed.paths.root), suites: steady, quiet: true });
  assert.equal(r.verdict.decision, "GRADUATE", r.verdict.reason);
  assert.equal(r.attempt.id, "ATT-0001");
  assert.deepEqual(r.attempt.task.skills, ["SKL-0001"]);
  assert.equal(r.attempt.result?.summary, RESULT.summary);
  assert.equal(r.attempt.isolation.observers, "off");
  assert.ok(r.attempt.scratch_files.includes(".agents/skills/SKL-0001/SKILL.md"));
  assert.equal(r.observation.anchor.attempt, "ATT-0001");
  assert.match(r.observation.text, /was graduated/);
  assert.equal(read("observations.jsonl", bed.paths.ledger).length, 1);
  assert.equal(current<Incident>("incidents.jsonl", "INC-0001", bed.paths.ledger)!.status, "repaired");
  assert.match(git(bed.paths.live, ["log", "-1", "--format=%B", "core-live"]), /^Skills: SKL-0001$/m);
  // the runner ran in the scratch repo under the isolated HOME with ATTEMPT_ID and RATCHET_SERVER
  const call = runner.calls[0];
  assert.equal(call.cwd, join(bed.paths.cache, "scratch", "ATT-0001"));
  assert.equal(call.env.HOME, `${call.cwd}.home`);
  assert.equal(call.env.XDG_CONFIG_HOME, join(`${call.cwd}.home`, ".config"));
  assert.equal(call.env.ATTEMPT_ID, "ATT-0001");
  assert.equal(call.env.RATCHET_SERVER, bed.paths.server);
  assert.match(readFileSync(join(call.env.XDG_CONFIG_HOME, "muse", "settings.json"), "utf8"), /"off"/);

  const { server } = createServer({ ledger: bed.paths.ledger, runs: join(bed.paths.root, "runs"), evidence: bed.paths.evidence, game: join(bed.paths.root, "game"), cache: bed.paths.cache });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  try {
    const port = (server.address() as AddressInfo).port;
    const state = await (await fetch(`http://127.0.0.1:${port}/api/state`)).json() as { attempts: Attempt[]; verdicts: Verdict[]; incidents: Incident[] };
    assert.equal(state.attempts[0].id, "ATT-0001");
    assert.equal(state.attempts[0].result?.summary, RESULT.summary);
    assert.equal(state.verdicts[0].subject.id, "ATT-0001");
    assert.equal(state.verdicts[0].decision, "GRADUATE");
  } finally { server.close(); }
});

test("a refused attempt on the MAX_ATTEMPTS-th try flips the incident to unrepaired", async () => {
  const bed = makeBed();
  const deps = { paths: bed.paths, runner: fakeRunner(() => {}, null), replayer: toolReplayer(bed.paths.root), suites: steady, quiet: true };
  const a = await runFastCycle("INC-0001", deps);
  assert.equal(a.verdict.decision, "REFUSE");
  assert.match(a.observation.text, /refused at diff-scope/);
  assert.equal(current<Incident>("incidents.jsonl", "INC-0001", bed.paths.ledger)!.status, "open");
  await runFastCycle("INC-0001", deps);
  assert.equal(current<Incident>("incidents.jsonl", "INC-0001", bed.paths.ledger)!.status, "unrepaired");
  assert.deepEqual(openIncidents(bed.paths), []);
  await assert.rejects(runFastCycle("INC-0001", deps), /unrepaired, not open/);
});

test("veto reverts a GRADUATE's merge in core-live and appends a steer naming the verdict", async () => {
  const bed = makeBed();
  const r = await runFastCycle("INC-0001", { paths: bed.paths, runner: fakeRunner((d) => setShade(d, FIX), RESULT), replayer: toolReplayer(bed.paths.root), suites: steady, quiet: true });
  const s = await veto(r.verdict.id, bed.paths);
  assert.equal(s.vetoes, r.verdict.id);
  assert.equal(readFileSync(join(bed.paths.live, "core", "ppu.ts"), "utf8").includes("romByte === 2 ? 3"), true);
  assert.match(git(bed.paths.live, ["log", "-1", "--format=%s", "core-live"]), /^Revert/);
  const plain = steer("prefer fetcher steps over delays", bed.paths);
  assert.equal(plain.id, "STR-0002");
  assert.equal(read("steers.jsonl", bed.paths.ledger).length, 2);
});

test("seedLive fast-forwards core-live to main and refuses a diverged core-live", () => {
  const bed = makeBed();
  writeFileSync(join(bed.main, "core", "extra.ts"), "export const X = 1;\n");
  git(bed.main, ["add", "core/extra.ts"]);
  git(bed.main, ["commit", "--quiet", "-m", "S1 merge"]);
  const r = seedLive(bed.paths.live, bed.main);
  assert.equal(r.moved, true);
  assert.equal(r.to, git(bed.main, ["rev-parse", "main"]));
  assert.equal(seedLive(bed.paths.live, bed.main).moved, false);
  mkdirSync(join(bed.paths.live, "core"), { recursive: true });
  writeFileSync(join(bed.paths.live, "core", "gate.ts"), "x\n");
  git(bed.paths.live, ["add", "core/gate.ts"]);
  git(bed.paths.live, ["commit", "--quiet", "-m", "gate commit"]);
  writeFileSync(join(bed.main, "core", "extra2.ts"), "y\n");
  git(bed.main, ["add", "core/extra2.ts"]);
  git(bed.main, ["commit", "--quiet", "-m", "later"]);
  assert.throws(() => seedLive(bed.paths.live, bed.main));
});

test("museArgs is D-0001's command line and usage reads run_usage payloads", () => {
  assert.deepEqual(museArgs("SID", 60), ["exec", "--json", "--prompt-file", "packet/TASK.md", "--session-id", "SID", "--max-model-steps", "60", "--approval-mode", "never", "--disable-approval", "--model", "muse-spark-1.3", "--disable-web-tools", "--disable-reminders", "-c", "agents.execution_capacity=1", "--trust-workspace"]);
  const ev = [{ payload: { kind: "run_model_configured", model_id: "muse-spark-1.3" } }, { payload: { kind: "run_usage", input_tokens: 10, output_tokens: 2 } }, { payload: { kind: "run_usage", input_tokens: 5, output_tokens: 1 } }].map((e) => JSON.stringify(e)).join("\n");
  assert.deepEqual(usageFromEvents(ev), { model: "muse-spark-1.3", steps: 2, tokens_in: 15, tokens_out: 3 });
  const env = repairEnv("/h", "/h/.config", "k", "ATT-0001", "http://s", {});
  assert.deepEqual(Object.keys(env).sort(), ["ATTEMPT_ID", "HOME", "META_API_KEY", "MUSE_NO_AUTO_UPDATE", "PATH", "RATCHET_SERVER", "TERM", "XDG_CONFIG_HOME"]);
});
