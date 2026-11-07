import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dryDeps, openRun, pickIncident, readCampaign, runCampaign, type CampaignDeps } from "./campaign.ts";
import { makeBed, writeSkill, type Bed } from "./fixtures/harness.ts";
import { openManifest, readManifest, sDirs } from "./run-records.ts";
import { append, all, current } from "./ledger.ts";
import { steer } from "./steer.ts";
import { ATTEMPT_RESERVE_USD, attemptReserve, meterLine, SPEND_ASK_USD, spendMeter } from "../server/spend.ts";
import { MAX_ATTEMPTS } from "./gate.ts";
import { ruleVersion } from "./gate-repair.ts";
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

test("openRun refuses to open the run when S0 is not empty (a skill or policy already graduated), unless the owner passes allowNonEmptyS0", async () => {
  const bed = makeBed();
  const dirs = sDirs(bed.paths.skills, bed.paths.root);
  writeFileSync(join(bed.paths.skills, "graduated", ".gitkeep"), "");
  const runsDir = mkdtempSync(join(tmpdir(), "ratchet-runs-"));
  // a .gitkeep alone is an empty S0
  await openRun({ runsDir, run: "RUN-0001", resume: false, build: () => M(), s0Dirs: dirs });
  const graduateSkill = (b: Bed) => writeSkill(b, "SKL-0001");
  const graduatePolicy = (b: Bed) => { const p = join(b.paths.root, "policies", "graduated", "POL-0001"); mkdirSync(p, { recursive: true }); writeFileSync(join(p, "POLICY.md"), "---\nid: POL-0001\n---\n"); };
  for (const make of [graduateSkill, graduatePolicy]) {
    const b2 = makeBed();
    const d2 = sDirs(b2.paths.skills, b2.paths.root);
    make(b2);
    const r2 = mkdtempSync(join(tmpdir(), "ratchet-runs-"));
    await assert.rejects(openRun({ runsDir: r2, run: "RUN-0001", resume: false, build: () => M(), s0Dirs: d2 }), /S0 is not empty/);
    assert.equal(readManifest(r2, "RUN-0001"), null);
    await openRun({ runsDir: r2, run: "RUN-0001", resume: false, build: () => M(), s0Dirs: d2, allowNonEmptyS0: true });
    assert.ok(readManifest(r2, "RUN-0001"));
  }
});

test("openRun --resume refuses when the gate's rule constants hash to another rule_version than the manifest's (G4: never changed after the run opens)", async () => {
  const runsDir = mkdtempSync(join(tmpdir(), "ratchet-runs-"));
  await openRun({ runsDir, run: "RUN-0001", resume: false, build: () => ({ ...M(), rule_version: ruleVersion() }), ruleVersion: ruleVersion() });
  await openRun({ runsDir, run: "RUN-0001", resume: true, build: () => M(), ruleVersion: ruleVersion() });
  await assert.rejects(openRun({ runsDir, run: "RUN-0001", resume: true, build: () => M(), ruleVersion: "0123456789ab" }), /rule_version/);
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
    // INC-0002 and INC-0003 are clones of INC-0001: its GRADUATE's re-check on the merged head repairs them, attempt or not
    const grad = verdicts.find((v) => v.decision === "GRADUATE")!;
    for (const id of ["INC-0002", "INC-0003"]) {
      const inc = current<Incident & { repaired_by?: string }>("incidents.jsonl", id, L)!;
      assert.deepEqual([inc.status, inc.repaired_by], ["repaired", grad.id], id);
      assert.ok(atts.filter((a) => a.task.incident === id).length <= MAX_ATTEMPTS);
    }
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
  // the run's priced records after the reading add to it at the owner's ratio ($5 console / $61 priced); run-null records never do
  append("attempts.jsonl", { id: "ATT-0002", at: "2026-11-07T14:40:00.000Z", run: "RUN-0001", spent: { usd: 2.5 } }, g.bed.paths.ledger);
  append("spend.jsonl", { at: "2026-11-07T14:41:00.000Z", run: null, role: "narrator", model: "m", tokens_in: 1, tokens_out: 1, usd: 9 }, g.bed.paths.ledger);
  const after = spendMeter({ ledger: g.bed.paths.ledger, runsDir: g.runsDir, run: "RUN-0001" });
  assert.equal(after.ratio, 5 / 61);
  assert.equal(after.owner_read_usd, (5 / 61) * 2.5);
});

test("before a start the guard adds a reserve per in-flight attempt: ATTEMPT_RESERVE_USD until the run has a finished attempt, so $50 with two in flight pauses at $60", async () => {
  const g = guardBed(50);
  const base = current<Incident>("incidents.jsonl", "INC-0001", g.bed.paths.ledger)!;
  for (const id of ["INC-0002", "INC-0003", "INC-0004"]) append("incidents.jsonl", { ...base, id }, g.bed.paths.ledger);
  g.deps.minutes = 0.005;
  g.deps.fast = async (id) => { g.calls.push(id); await new Promise((r) => setTimeout(r, 600)); throw new Error("slow fake attempt"); };
  assert.equal(attemptReserve({ ledger: g.bed.paths.ledger, run: "RUN-0001", ratio: null }), ATTEMPT_RESERVE_USD);
  await runCampaign(g.deps);
  const n = Math.ceil((SPEND_ASK_USD - 50) / ATTEMPT_RESERVE_USD);
  assert.equal(g.calls.length, n, `starts until $50 + ${ATTEMPT_RESERVE_USD} x in-flight reaches $${SPEND_ASK_USD}`);
  const pause = readCampaign(g.runsDir, "RUN-0001").find((r) => r.t === "pause") as { reserve_usd: number; inflight: number } | undefined;
  assert.deepEqual(pause && [pause.inflight, pause.reserve_usd], [n, n * ATTEMPT_RESERVE_USD]);
});

test("the reserve is the median scaled cost of the run's finished attempts", () => {
  const bed = makeBed();
  const L = bed.paths.ledger;
  for (const [id, usd, run] of [["ATT-0001", 2, "RUN-0001"], ["ATT-0002", 4, "RUN-0001"], ["ATT-0003", 30, "RUN-0001"], ["ATT-0004", 99, null]] as const)
    append("attempts.jsonl", { id, at: "2026-11-07T14:31:00.000Z", run, task: { kind: "incident", incident: "INC-0001" }, spent: { usd }, result: { summary: "s" } }, L);
  append("attempts.jsonl", { id: "ATT-0005", at: "2026-11-07T14:31:00.000Z", run: "RUN-0001", task: { kind: "incident", incident: "INC-0001" }, spent: { usd: 500 } }, L); // in flight: no result
  assert.equal(attemptReserve({ ledger: L, run: "RUN-0001", ratio: null }), 4);
  assert.equal(attemptReserve({ ledger: L, run: "RUN-0001", ratio: 0.5 }), 2);
});

test("post-reading priced dollars are scaled by the owner's ratio, console usd at `at` over every priced dollar up to `at` (pre-run included), clamped to (0, 1], and the meter line names it", () => {
  const g = guardBed(10); // ATT-0001, run RUN-0001, $10 at 14:31
  const L = g.bed.paths.ledger;
  append("spend.jsonl", { at: "2026-11-07T10:00:00.000Z", run: null, role: "consolidator", model: "m", tokens_in: 1, tokens_out: 1, usd: 90 }, L);
  const f = join(g.runsDir, "RUN-0001", "spend-override.json");
  mkdirSync(join(g.runsDir, "RUN-0001"), { recursive: true });
  writeFileSync(f, JSON.stringify({ usd: 5, at: "2026-11-07T14:32:00.000Z", pre_run_usd: 5 }));
  append("attempts.jsonl", { id: "ATT-0002", at: "2026-11-07T14:40:00.000Z", run: "RUN-0001", spent: { usd: 20 } }, L);
  const m = spendMeter({ ledger: L, runsDir: g.runsDir, run: "RUN-0001" });
  assert.equal(m.ratio, 0.05);
  assert.ok(Math.abs(m.owner_read_usd! - 1) < 1e-9, String(m.owner_read_usd));
  assert.match(meterLine(m), /list rates × 0\.050 since reading/);
  // a console total above the priced total clamps to 1; no priced dollar before the reading reads 1
  writeFileSync(f, JSON.stringify({ usd: 500, at: "2026-11-07T14:32:00.000Z", pre_run_usd: 5 }));
  assert.equal(spendMeter({ ledger: L, runsDir: g.runsDir, run: "RUN-0001" }).ratio, 1);
  writeFileSync(f, JSON.stringify({ usd: 5, at: "2026-11-07T09:00:00.000Z", pre_run_usd: 5 }));
  assert.equal(spendMeter({ ledger: L, runsDir: g.runsDir, run: "RUN-0001" }).ratio, 1);
});

test("an override whose `at` is later than the file was written is read at the file's write time, with a warning, so the run's priced records after the write still count", () => {
  const g = guardBed(0);
  const dir = join(g.runsDir, "RUN-0001");
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const f = join(dir, "spend-override.json");
  writeFileSync(f, JSON.stringify({ usd: 5, at: new Date(now + 3600_000).toISOString(), pre_run_usd: 5 }));
  utimesSync(f, new Date(now - 3600_000), new Date(now - 3600_000));
  append("attempts.jsonl", { id: "ATT-0002", at: new Date(now - 1800_000).toISOString(), run: "RUN-0001", spent: { usd: 4 } }, g.bed.paths.ledger);
  const m = spendMeter({ ledger: g.bed.paths.ledger, runsDir: g.runsDir, run: "RUN-0001" });
  assert.equal(m.owner_read_usd, 4);
  assert.match(m.warning ?? "", /later than the file was written/);
});

test("a frozen run (manifest holds s_star_sha) starts no attempt and no slow generation: the campaign stops learning at curve freeze", async () => {
  const g = guardBed(0);
  openManifest(g.runsDir, { ...M(), s_star_sha: "frozen", frozen_at: "2026-11-07T15:45:00.000Z" });
  let slow = 0;
  const out = await runCampaign({ ...g.deps, slow: async () => { slow++; } });
  assert.deepEqual(g.calls, []);
  assert.equal(slow, 0);
  assert.match(out.stopped, /^frozen at 2026-11-07T15:45:00.000Z/);
});

type Parked = Incident &{ parked?: { early_throws: number; attempts: number; error: string } };

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

test("real play's game.gb trace is the explorer's trace, and a game.gb manifest addition is its ROM sha alone (no start state)", async () => {
  const { playTrace } = await import("./game-trace.ts");
  const { explorerTrace } = await import("../player/explore.ts");
  const { gameById } = await import("../lockstep/games.ts");
  const { gameManifestRoms } = await import("./campaign.ts");
  const o = { rom_sha: "c8444ff9a470e23e3b17de184d992e15c2f80b6f46004714d37b9ea39d2408f3", frames: 3600, seed: 1001 };
  assert.deepEqual(playTrace(gameById("game"), o), explorerTrace(o));
  assert.deepEqual(await gameManifestRoms("game", join(import.meta.dirname, "..")), { "game:game": o.rom_sha });
});
