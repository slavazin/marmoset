import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.RATCHET_TELEMETRY_DIR ??= mkdtempSync(join(tmpdir(), "ratchet-tel-"));
delete process.env.RATCHET_RUN;
import { makeBed, setShade, FIX } from "./fixtures/harness.ts";
import { runFastCycle } from "./fast.ts";
import { fakeRunner } from "./repair.ts";
import { isolatedReplayer } from "./replay-seam.ts";
import { all, append, current, read, status } from "./ledger.ts";
import { route, routeCalibrationOf, controlsFor, DECOY_POOL, ROUTE_ABSTAIN_P, TWIN_KEY, routeSensor } from "./route.ts";
import { applyPolicies, policiesDir, POLICY_MENU, policyText, subsystemOf } from "./policies.ts";
import { cachedClient, lookup, requestKey, setSubqClient, subqClient, SubqReplayMiss, ROUTE_SENSOR_KEY, FORECAST_FIELDS, type SubqClient, type SubqRequest } from "./subq.ts";
import { auroc, brier, reliability } from "./sensor-stats.ts";
import type { SuitesJudge } from "./gate-repair.ts";
import type { Attempt, Incident, RepairTask, Verdict } from "../src/schema.ts";

/** The S15 mark test, widened to "control": no planted question may read as one. */
const MARK = /placebo|twin|sham|control|decoy|dummy/i;
const steady: SuitesJudge = { async score() { return { readings: [], roms: {} }; } };

interface FakeOpts { sub?: Record<string, number>; twin?: Record<string, number>; decoyKey?: string; decoy?: number; noul?: number }
/** A fake SubQ client: `sub` answers both subsystem questions (twin overrides the reworded one), noul everything else. */
function fake(o: FakeOpts, calls: SubqRequest[] = []): SubqClient {
  return async (req) => {
    calls.push(req);
    const answers: Record<string, any> = {};
    for (const [k, q] of Object.entries(req.questions)) {
      if (q.type === "choice") { const p = (k === TWIN_KEY && o.twin) || o.sub || { ppu_fetcher: 0.7, other: 0.3 }; answers[k] = { type: "choice", choice: Object.keys(p)[0], probabilities: p, confidence: 0.5 }; }
      else if (q.type === "noul") answers[k] = { type: "noul", noul: k === o.decoyKey ? o.decoy ?? 0.1 : o.noul ?? 0.6 };
      else answers[k] = { type: "score", score: 1, legend: {}, probabilities: { 0: 0.3, 1: 0.4, 2: 0.3 }, confidence: 0.4 };
    }
    return { status: 200, wall_ms: 7, body: { model: "subq-snap-1.1", answers, usage: { input_tokens: 500, output_tokens: 0 } } };
  };
}

function routeBed(): { root: string; ledger: string; inc: Incident } {
  const root = mkdtempSync(join(tmpdir(), "ratchet-s17b-"));
  const ledger = join(root, "ledger");
  mkdirSync(ledger);
  mkdirSync(join(root, "evidence/incidents/INC-0001"), { recursive: true });
  writeFileSync(join(root, "evidence/incidents/INC-0001/regwrites.jsonl"), `{"addr":65345,"value":64,"ly":40,"dot":0,"cycles":10}\n`);
  const inc: Incident = { id: "INC-0001", at: "2026-11-07T00:00:00.000Z", run: null, kind: "frame", align: "counter", signature: { scene: 1, band: 3, bbox: [0, 40, 160, 48] },
    rom_sha: "r", trace_sha: "t", window: [1, 121], core_commit: "c", counter: 20, pixels: 600, files: { dir: "evidence/incidents/INC-0001" }, source: "play", status: "open" };
  append("incidents.jsonl", inc, ledger);
  return { root, ledger, inc };
}
const skills = [{ id: "SKL-0001", firesWhen: "a PPU file is edited", notThis: "CPU timing", paths: ["core/ppu.ts"] }];

test("a route whose top subsystem probability is under ROUTE_ABSTAIN_P abstains: its status record says abstain 1 and a packet focus policy narrows nothing", async () => {
  const { root, ledger, inc } = routeBed();
  const low = { ppu_fetcher: ROUTE_ABSTAIN_P - 0.05, stat_irq: 0.25, oam_dma: 0.2, window: 0.1, timer: 0.1, other: 0.05 };
  const r = await route(inc, { client: fake({ sub: low }), root, ledger, skills, observations: [] });
  assert.equal(r.sensor?.abstain, 1);
  const cur = current<Incident>("incidents.jsonl", inc.id, ledger)!;
  assert.equal(cur.route?.[ROUTE_SENSOR_KEY].abstain, 1, "the status record says so");
  assert.equal(cur.route?.[ROUTE_SENSOR_KEY].top_p, low.ppu_fetcher);
  const task: RepairTask = { kind: "incident", incident: inc.id, base_commit: "x", arm: "fast", skills: [], policies: [], budget: { max_steps: 1, wall_s: 1 } };
  assert.equal(subsystemOf(task, cur), null, "the fallback: no subsystem, so no focus narrowing");
  // the same incident routed confidently narrows to the route's subsystem
  const sure = await route(inc, { client: fake({ sub: { stat_irq: 0.7, ppu_fetcher: 0.2, other: 0.1 } }), root, ledger, skills, observations: [] });
  assert.equal(sure.sensor?.abstain, 0);
  assert.equal(subsystemOf(task, current<Incident>("incidents.jsonl", inc.id, ledger)!), "stat_irq");
});

test("a packet focus policy writes no focus.json for an abstaining route and the stat_irq region for a confident one", () => {
  const bed = makeBed();
  const t = POLICY_MENU["packet-subsystem-focus"];
  const d = join(policiesDir(bed.paths), "graduated", "POL-0001");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "POLICY.md"), policyText({ id: "POL-0001", name: "packet-subsystem-focus", kind: t.kind, status: "graduated", change: t.change, params: t.resolve({ files: "subsystem-pointed" }, "POL-0001"),
    warrant: { anchors: ["OBS-0001", "OBS-0002"], "false-if": "x" }, lifecycle: { "retire-when": "y", successor: null } }, "packet-subsystem-focus"));
  const task: RepairTask = { kind: "incident", incident: bed.incident.id, base_commit: "x", arm: "fast", skills: [], policies: ["POL-0001"], budget: { max_steps: 1, wall_s: 1 } };
  const core = ["core/cpu.ts", "core/index.ts", "core/mbc1.ts", "core/ppu.ts"];
  const withRoute = (abstain: number) => ({ ...bed.incident, route: { subsystem: { stat_irq: 0.6, other: 0.4 }, [ROUTE_SENSOR_KEY]: { top_p: 0.6, p_other: 0.4, abstain } } });
  assert.deepEqual(applyPolicies(task, { paths: bed.paths, incident: withRoute(1), coreFiles: core, site: "packet" }).packetFiles, {});
  assert.deepEqual(JSON.parse(applyPolicies(task, { paths: bed.paths, incident: withRoute(0), coreFiles: core, site: "packet" }).packetFiles["focus.json"]), { handlers: ["irq"], files: ["core/index.ts"] });
});

test("a route where `other` wins abstains even above ROUTE_ABSTAIN_P, and records p(other)", async () => {
  const { root, ledger, inc } = routeBed();
  const r = await route(inc, { client: fake({ sub: { other: 0.55, ppu_fetcher: 0.3, timer: 0.15 } }), root, ledger, skills, observations: [] });
  assert.deepEqual([r.sensor?.abstain, r.sensor?.p_other, r.sensor?.top_p], [1, 0.55, 0.55]);
  assert.deepEqual(routeSensor({ ppu_fetcher: 0.5, other: 0.2 }, {}), { top_p: 0.5, p_other: 0.2, abstain: 0 });
});

test("every route call carries one decoy applies: question and one reworded subsystem twin, neither worded as planted; their answers are recorded and never routed on", async () => {
  const { root, ledger, inc } = routeBed();
  const planted = controlsFor(inc.id, skills);
  const calls: SubqRequest[] = [];
  const r = await route(inc, { client: fake({ sub: { ppu_fetcher: 0.7, stat_irq: 0.2, other: 0.1 }, twin: { ppu_fetcher: 0.6, stat_irq: 0.3, other: 0.1 }, decoyKey: planted.decoyKey, decoy: 0.12 }, calls), root, ledger, skills, observations: [] });
  const q = calls[0].questions;
  assert.ok(planted.decoyKey in q && TWIN_KEY in q);
  assert.deepEqual(Object.keys((q[TWIN_KEY] as { criteria: Record<string, unknown> }).criteria), Object.keys((q.subsystem as { criteria: Record<string, unknown> }).criteria), "the twin offers the subsystem options");
  assert.ok(DECOY_POOL.some((d) => JSON.stringify(q[planted.decoyKey]).includes(d.firesWhen.slice(0, 40))), "the decoy criterion comes from DECOY_POOL");
  assert.ok(!MARK.test(JSON.stringify(q)), "no question sent reads as planted");
  assert.ok(!MARK.test(JSON.stringify(calls[0].state)), "nor does the state");
  assert.deepEqual(controlsFor(inc.id, skills), planted, "the choice is deterministic from the incident id");
  assert.deepEqual([r.sensor?.decoy_yes, r.sensor?.decoy_rejected, r.sensor?.twin_agree, r.sensor?.twin_dp], [0.12, 1, 1, 0.1]);
  assert.ok(!(planted.decoyKey in r.route) && !(TWIN_KEY in r.route), "the planted answers stay out of the route's questions");
});

test("AUROC, Brier and reliability on a fixture, and routeCalibrationOf's AUROC of 1 − top-p and p(other) at flagging a wrong route", () => {
  assert.equal(auroc([{ score: 0.9, label: 1 }, { score: 0.8, label: 1 }, { score: 0.3, label: 0 }, { score: 0.1, label: 0 }]), 1);
  assert.equal(auroc([{ score: 0.5, label: 1 }, { score: 0.5, label: 0 }]), 0.5);
  assert.equal(auroc([{ score: 0.2, label: 1 }, { score: 0.6, label: 0 }, { score: 0.4, label: 1 }]), 0);
  assert.equal(auroc([{ score: 0.2, label: 1 }]), null, "one label only: no AUROC");
  assert.equal(brier([{ p: 1, y: 1 }, { p: 0.5, y: 0 }]), 0.125);
  const bins = reliability([{ p: 0.05, y: 0 }, { p: 0.15, y: 1 }, { p: 0.95, y: 1 }, { p: 1, y: 0 }]);
  assert.equal(bins.length, 10);
  assert.deepEqual([bins[0].n, bins[0].rate, bins[1].n, bins[9].n, bins[9].mean_p, bins[9].rate, bins[5].mean_p], [1, 0, 1, 2, 0.975, 0.5, null]);

  const { ledger } = routeBed();
  // two more incidents: INC-0001 routed right with high confidence, INC-0002 and INC-0003 routed wrong with low confidence
  for (const id of ["INC-0002", "INC-0003"]) append("incidents.jsonl", { ...current<Incident>("incidents.jsonl", "INC-0001", ledger)!, id }, ledger);
  const rt = (sub: Record<string, number>) => ({ subsystem: sub, [ROUTE_SENSOR_KEY]: routeSensor(sub, {})! });
  status("incidents.jsonl", "INC-0001", "route", rt({ ppu_fetcher: 0.9, timer: 0.05, other: 0.05 }), ledger);
  status("incidents.jsonl", "INC-0002", "route", rt({ timer: 0.3, ppu_fetcher: 0.3, other: 0.4 }), ledger);
  status("incidents.jsonl", "INC-0003", "route", rt({ timer: 0.5, ppu_fetcher: 0.25, other: 0.25 }), ledger);
  const prov: object[] = [];
  for (const [n, inc] of ["INC-0001", "INC-0002", "INC-0003"].entries()) {
    const id = `ATT-000${n + 1}`;
    append("attempts.jsonl", { id, at: "2999-01-01T00:00:00.000Z", run: null, task: { kind: "incident", incident: inc, base_commit: "b", arm: "fast", skills: [], budget: { max_steps: 1, wall_s: 1 } } }, ledger);
    append("verdicts.jsonl", { id: `VER-000${n + 1}`, subject: { kind: "attempt", id }, decision: "GRADUATE", checks: [] }, ledger);
    prov.push({ handler: "ppu.fetcher", file: "core/ppu.ts", commit: "c", attempt: id });
  }
  writeFileSync(join(ledger, "provenance.json"), JSON.stringify(prov));
  const c = routeCalibrationOf(ledger);
  assert.deepEqual([c.subsystem.n, c.subsystem.wrong, c.subsystem.auroc_uncertainty, c.subsystem.auroc_other], [3, 2, 1, 1]);
  assert.deepEqual([c.abstention.n, c.abstention.hits], [3, 1], "INC-0002, where other wins, abstains");
});

test("the cache serves a repeated request without a live call, stores it under <dir>/<echoed model>/, and in replay mode a miss throws with no live call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-subq-cache-"));
  const calls: SubqRequest[] = [];
  const c = cachedClient(fake({}, calls), dir);
  const req: SubqRequest = { model: "subq-snap-1.1", state: { a: 1 }, questions: { q: { type: "noul", instructions: "x?", criteria: { true: "y", false: "n" } } } };
  const first = await c(req);
  assert.equal(calls.length, 1);
  assert.ok(!first.cached);
  assert.deepEqual(readdirSync(dir), ["subq-snap-1.1"]);
  const k = requestKey(req);
  assert.ok(existsSync(join(dir, "subq-snap-1.1", `${k.state.slice(0, 16)}-${k.questions.slice(0, 16)}.json`)));
  const again = await c(req);
  assert.equal(calls.length, 1, "a hit makes no call");
  assert.deepEqual([again.cached, again.body], [true, first.body]);
  assert.ok(lookup(req, dir));
  const other = { ...req, state: { a: 2 } };
  const prevEnv = { replay: process.env.RATCHET_SUBQ_REPLAY, cache: process.env.RATCHET_SUBQ_CACHE };
  process.env.RATCHET_SUBQ_REPLAY = "1";
  process.env.RATCHET_SUBQ_CACHE = dir;
  try {
    await assert.rejects(c(other), SubqReplayMiss);
    assert.equal(calls.length, 1, "replay mode never reaches the inner client");
    const seam = setSubqClient(undefined);
    try {
      const rc = subqClient()!;
      assert.equal((await rc(req)).cached, true, "the default client in replay mode serves from the cache");
      await assert.rejects(rc(other), /no live call made/);
    } finally { setSubqClient(seam); }
  } finally {
    if (prevEnv.replay === undefined) delete process.env.RATCHET_SUBQ_REPLAY; else process.env.RATCHET_SUBQ_REPLAY = prevEnv.replay;
    if (prevEnv.cache === undefined) delete process.env.RATCHET_SUBQ_CACHE; else process.env.RATCHET_SUBQ_CACHE = prevEnv.cache;
  }
});

test("a test process without setSubqClient gets no SubQ client, so no live call is made", () => {
  const prev = setSubqClient(undefined);
  try { assert.equal(subqClient({ ...process.env, RATCHET_SUBQ_REPLAY: "" }), null); } finally { setSubqClient(prev); }
});

test("pass and mechanism forecasts are recorded on the attempt and never alter a gate check, the decision or the rule version (G-test); with no client nothing is asked or spent", async () => {
  const run = async (client: SubqClient | null, calls: SubqRequest[]) => {
    const bed = makeBed();
    const prev = setSubqClient(client);
    try {
      const r = await runFastCycle("INC-0001", { paths: bed.paths, runner: fakeRunner((d) => setShade(d, FIX), { dispositions: {}, off_map: null, beliefs: [], summary: "Renders a ROM's first byte as its shade." }),
        replayer: isolatedReplayer(bed.paths.root), suites: steady, quiet: true });
      return { r, bed, spend: read("spend.jsonl", bed.paths.ledger), calls };
    } finally { setSubqClient(prev); }
  };
  const on: SubqRequest[] = [];
  const a = await run(fake({ noul: 0.02 }, on), on), b = await run(null, []);
  assert.deepEqual(a.r.verdict.checks.map((c) => [c.name, c.pass, JSON.stringify(c.reading)]), b.r.verdict.checks.map((c) => [c.name, c.pass, JSON.stringify(c.reading)]));
  assert.deepEqual([a.r.verdict.decision, a.r.verdict.rule_version], [b.r.verdict.decision, b.r.verdict.rule_version]);
  const att = current<Attempt>("attempts.jsonl", a.r.attempt.id, a.bed.paths.ledger)!;
  assert.equal(att[FORECAST_FIELDS.pass]?.yes, 0.02);
  assert.equal(att[FORECAST_FIELDS.mechanism]?.yes, 0.02);
  assert.deepEqual(on.map((c) => Object.keys(c.questions)), [["pass"], ["mechanism"]]);
  assert.ok(typeof (on[1].state as { diff?: string }).diff === "string" && (on[1].state as { diff: string }).diff.includes("core/ppu.ts"), "the mechanism question reads the diff");
  assert.ok(a.spend.every((s) => s.role === "router") && a.spend.length === 2);
  const offAtt = current<Attempt>("attempts.jsonl", b.r.attempt.id, b.bed.paths.ledger)!;
  assert.equal(offAtt[FORECAST_FIELDS.pass], undefined);
  assert.equal(b.spend.length, 0, "no client: nothing spent");
  // scored against the verdict
  const cal = routeCalibrationOf(a.bed.paths.ledger);
  assert.equal(cal.forecast_pass.n, 1);
  assert.equal(cal.forecast_pass.brier, (0.02 - (a.r.verdict.decision === "GRADUATE" ? 1 : 0)) ** 2);
  assert.equal(all<Verdict>("verdicts.jsonl", a.bed.paths.ledger).length, 1);
});

test("a SubQ client that throws never throws into the fast loop", async () => {
  const bed = makeBed();
  const prev = setSubqClient(async () => { throw new Error("socket hang up"); });
  try {
    const r = await runFastCycle("INC-0001", { paths: bed.paths, runner: fakeRunner((d) => setShade(d, FIX), { dispositions: {}, off_map: null, beliefs: [], summary: "x." }),
      replayer: isolatedReplayer(bed.paths.root), suites: steady, quiet: true });
    assert.ok(r.verdict.id);
    assert.equal(current<Attempt>("attempts.jsonl", r.attempt.id, bed.paths.ledger)![FORECAST_FIELDS.pass], undefined);
  } finally { setSubqClient(prev); }
});
