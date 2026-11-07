import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dryDeps, openRun, pickIncident, readCampaign, runCampaign, type CampaignDeps } from "./campaign.ts";
import { makeBed } from "./fixtures/harness.ts";
import { append, all, current } from "./ledger.ts";
import { steer } from "./steer.ts";
import { spendMeter } from "../server/spend.ts";
import { MAX_ATTEMPTS } from "./gate.ts";
import type { Attempt, Incident, Manifest, Verdict } from "../src/schema.ts";

const M = (id = "RUN-0001"): Manifest => ({ id, opened_at: "2026-11-07T14:30:00.000Z", models: {}, oracle: { core: "fake", build_hash: "h" }, roms: {}, splits_sha: "s", rule_version: "r", s0_sha: "z" });

test("openRun writes the manifest once, refuses a second open without --resume, and continues it with --resume", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "ratchet-runs-"));
  await openRun({ runsDir, run: "RUN-0001", resume: false, build: () => M() });
  await assert.rejects(openRun({ runsDir, run: "RUN-0001", resume: false, build: () => M() }), /exists: the run is already open/);
  const m = await openRun({ runsDir, run: "RUN-0001", resume: true, build: () => { throw new Error("must not rebuild"); } });
  assert.equal(m.rule_version, "r");
  assert.deepEqual(readCampaign(runsDir, "RUN-0001").map((r) => r.t), ["open", "open"]);
});

test("pickIncident takes a frame incident covering the parallax lines before a larger one that does not, then the most pixels", () => {
  const inc = (id: string, y0: number, y1: number, pixels: number, kind: Incident["kind"] = "frame") => ({ id, kind, pixels, signature: { scene: 1, band: y0 >> 3, bbox: [0, y0, 160, y1] } }) as Incident;
  const open = [inc("INC-0001", 120, 144, 9000), inc("INC-0002", 32, 40, 300), inc("INC-0003", 16, 48, 500), inc("INC-0004", 0, 144, 99999, "logic")];
  assert.equal(pickIncident(open, new Set())!.id, "INC-0003");
  assert.equal(pickIncident(open, new Set(["INC-0003"]))!.id, "INC-0002");
  assert.equal(pickIncident(open, new Set(["INC-0003", "INC-0002"]))!.id, "INC-0001");
});

test("a dry campaign on a scratch ledger opens incidents, routes each, runs attempts to verdicts within MAX_ATTEMPTS, and stops cleanly", async () => {
  const saved = process.env.RATCHET_RUN;
  process.env.RATCHET_RUN = "RUN-0001";
  process.env.RATCHET_TELEMETRY_DIR ??= mkdtempSync(join(tmpdir(), "ratchet-telemetry-"));
  try {
    const { deps, manifest } = await dryDeps(2);
    await openRun({ runsDir: deps.runsDir, run: deps.run, resume: false, build: manifest });
    const out = await runCampaign({ ...deps, log: () => {} });
    const L = deps.paths.ledger;
    const incs = all<Incident>("incidents.jsonl", L);
    assert.equal(incs.length, 3);
    assert.ok(incs.every((i) => i.route?.subsystem), "every incident carries a route");
    const verdicts = all<Verdict>("verdicts.jsonl", L);
    const atts = all<Attempt>("attempts.jsonl", L);
    assert.equal(verdicts.length, atts.length);
    assert.ok(verdicts.some((v) => v.decision === "GRADUATE") && verdicts.some((v) => v.decision === "REFUSE"));
    assert.ok(atts.every((a) => a.run === "RUN-0001"));
    assert.equal(atts.filter((a) => a.task.incident === "INC-0002").length, 2);
    assert.equal(current<Incident>("incidents.jsonl", "INC-0002", L)!.status, "unrepaired");
    assert.match(out.stopped, /^idle/);
    assert.equal(readCampaign(deps.runsDir, deps.run).at(-1)!.t, "stop");
  } finally { if (saved === undefined) delete process.env.RATCHET_RUN; else process.env.RATCHET_RUN = saved; }
});

function guardBed(usd: number) {
  const bed = makeBed();
  const runsDir = mkdtempSync(join(tmpdir(), "ratchet-runs-"));
  append("attempts.jsonl", { id: "ATT-0001", at: "2026-11-07T14:31:00.000Z", run: "RUN-0001", task: { kind: "incident", incident: "INC-0000" }, spent: { steps: 1, wall_s: 1, tokens_in: 1, tokens_out: 1, usd } }, bed.paths.ledger);
  const calls: string[] = [];
  const logs: string[] = [];
  const deps: CampaignDeps = {
    paths: bed.paths, run: "RUN-0001", runsDir, minutes: 0.01, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))), log: (s) => logs.push(s),
    play: async () => ({ opened: [], exhausted: true }), route: async () => null, narrate: async () => null, slow: async () => null,
    fast: async (id) => { calls.push(id); throw new Error("fake attempt"); },
  };
  return { bed, runsDir, deps, calls, logs };
}

test("at SPEND_ASK_USD the guard writes a pause record, prints the owner gate and starts no attempt until a 'resume spend' steer", async () => {
  const g = guardBed(61);
  await runCampaign(g.deps);
  assert.deepEqual(g.calls, []);
  assert.ok(g.logs.includes("owner gate: spend $61.00"));
  const pause = readCampaign(g.runsDir, "RUN-0001").find((r) => r.t === "pause");
  assert.equal(pause && pause.t === "pause" && pause.usd, 61);
  await new Promise((r) => setTimeout(r, 5));
  steer("resume spend", g.bed.paths);
  await runCampaign(g.deps);
  assert.equal(g.calls[0], "INC-0001");
  assert.ok(readCampaign(g.runsDir, "RUN-0001").some((r) => r.t === "resume"));
  assert.equal(readCampaign(g.runsDir, "RUN-0001").filter((r) => r.t === "pause").length, 1);
});

test("at SPEND_STOP_USD the campaign stops before any attempt", async () => {
  const g = guardBed(81);
  const out = await runCampaign(g.deps);
  assert.deepEqual(g.calls, []);
  assert.match(out.stopped, /^spend stop: \$81\.00/);
});

test("the owner-read override is what the guard acts on: $61 priced with a $5 console reading, all pre-run, starts the attempt", async () => {
  const g = guardBed(61);
  mkdirSync(join(g.runsDir, "RUN-0001"), { recursive: true });
  writeFileSync(join(g.runsDir, "RUN-0001", "spend-override.json"), JSON.stringify({ usd: 5, at: "2026-11-07T14:32:00.000Z", pre_run_usd: 5 }));
  const m = spendMeter({ ledger: g.bed.paths.ledger, runsDir: g.runsDir, run: "RUN-0001" });
  assert.equal(m.priced_usd, 61);
  assert.equal(m.owner_read_usd, 0);
  assert.equal(m.source, "owner-read");
  await runCampaign(g.deps);
  assert.equal(g.calls[0], "INC-0001");
  // the run's priced records after the reading add to it; records with run null never do
  append("attempts.jsonl", { id: "ATT-0002", at: "2026-11-07T14:40:00.000Z", run: "RUN-0001", spent: { usd: 2.5 } }, g.bed.paths.ledger);
  append("spend.jsonl", { at: "2026-11-07T14:41:00.000Z", run: null, role: "narrator", model: "m", tokens_in: 1, tokens_out: 1, usd: 9 }, g.bed.paths.ledger);
  assert.equal(spendMeter({ ledger: g.bed.paths.ledger, runsDir: g.runsDir, run: "RUN-0001" }).owner_read_usd, 2.5);
});

type Parked = Incident & { parked?: { early_throws: number; attempts: number; error: string } };

test("an attempt that throws before minting its ATT counts against MAX_ATTEMPTS: after MAX_ATTEMPTS such throws the incident is parked unrepaired with a status record, and no further attempt starts", async () => {
  const g = guardBed(0);
  await runCampaign(g.deps);
  assert.equal(g.calls.length, MAX_ATTEMPTS);
  const inc = current<Parked>("incidents.jsonl", "INC-0001", g.bed.paths.ledger)!;
  assert.equal(inc.status, "unrepaired");
  assert.deepEqual(inc.parked && [inc.parked.early_throws, inc.parked.attempts, inc.parked.error], [MAX_ATTEMPTS, 0, "fake attempt"]);
  const recs = readCampaign(g.runsDir, "RUN-0001");
  assert.equal(recs.filter((r) => r.t === "attempt-error").length, MAX_ATTEMPTS);
  assert.equal(recs.filter((r) => r.t === "park").length, 1);
});

test("an attempt that throws after minting its ATT counts once, and the MAX_ATTEMPTS-th such attempt flips the incident to unrepaired", async () => {
  const g = guardBed(0);
  let n = 0;
  g.deps.fast = async (id) => {
    g.calls.push(id);
    append("attempts.jsonl", { id: `ATT-01${String(++n).padStart(2, "0")}`, at: new Date().toISOString(), run: "RUN-0001", task: { kind: "incident", incident: id }, spent: { usd: 0 } }, g.bed.paths.ledger);
    throw new Error("repairer crashed");
  };
  await runCampaign(g.deps);
  assert.equal(g.calls.length, MAX_ATTEMPTS);
  const inc = current<Parked>("incidents.jsonl", "INC-0001", g.bed.paths.ledger)!;
  assert.equal(inc.status, "unrepaired");
  assert.deepEqual(inc.parked && [inc.parked.early_throws, inc.parked.attempts], [0, MAX_ATTEMPTS]);
});
