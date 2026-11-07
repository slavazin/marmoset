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
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { route, routeCalibrationOf, controlsFor, withPlanted, buildQuestions, BASE_QUESTIONS, DECOY_POOL, ROUTE_ABSTAIN_P, ROUTE_META_KEY, TWIN_KEY, TWIN_QUESTION, routeSensor } from "./route.ts";
import { applyPolicies, policiesDir, POLICY_MENU, policyText, subsystemOf } from "./policies.ts";
import { cachedClient, httpClient, lookup, requestKey, setSubqClient, subqClient, SubqReplayMiss, SUBQ_TIMEOUT_MS, ROUTE_SENSOR_KEY, FORECAST_FIELDS, type SubqClient, type SubqRequest } from "./subq.ts";
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

// ---- S17b cold read ----

test("decoy position: over many seeds the decoy sits inside the run of applies: questions, or after the base questions and before every same_shape_as when no skill is routed", () => {
  const obs = [{ id: "OBS-0001", text: "a" }, { id: "OBS-0002", text: "b" }];
  for (const sk of [[], skills, [...skills, { ...skills[0], id: "SKL-0002" }, { ...skills[0], id: "SKL-0003" }]]) {
    for (let i = 1; i <= 40; i++) {
      const seed = `INC-${String(i).padStart(4, "0")}`;
      const p = controlsFor(seed, sk);
      const ks = Object.keys(withPlanted(buildQuestions(sk, obs), p, 0));
      const at = ks.indexOf(p.decoyKey);
      const base = Object.keys(BASE_QUESTIONS).map((k) => ks.indexOf(k));
      const shapes = ks.map((k, j) => (k.startsWith("same_shape_as:") ? j : -1)).filter((j) => j >= 0);
      assert.ok(base.every((j) => j < at), `${seed}: decoy after the base questions (${ks.join(",")})`);
      assert.ok(shapes.every((j) => j > at), `${seed}: decoy before every same_shape_as (${ks.join(",")})`);
    }
  }
});

test("decoy wording: no DECOY_POOL criterion names the picture, so a decoy is not rejected on its not-this alone, and each not-this names its own neighbouring mechanism", () => {
  const PICTURE = /picture|pixel|frame|screen|display|image|sprite|tile|scanline/i;
  for (const d of DECOY_POOL) {
    assert.ok(!PICTURE.test(d.notThis), `not-this "${d.notThis}" names the picture`);
    assert.ok(!PICTURE.test(d.firesWhen), `fires-when "${d.firesWhen}" names the picture`);
    assert.ok(!MARK.test(d.notThis + d.firesWhen));
  }
  assert.equal(new Set(DECOY_POOL.map((d) => d.notThis)).size, DECOY_POOL.length, "each decoy has its own not-this");
});

test("twin criteria: each reworded criterion is at most 1.5x the length of the subsystem criterion it restates, over the same options", () => {
  const a = BASE_QUESTIONS.subsystem as { criteria: Record<string, string | null> };
  const b = TWIN_QUESTION as { criteria: Record<string, string | null> };
  assert.deepEqual(Object.keys(b.criteria), Object.keys(a.criteria));
  for (const [k, v] of Object.entries(a.criteria)) {
    if (v === null) { assert.equal(b.criteria[k], null); continue; }
    assert.ok((b.criteria[k] ?? "").length <= v.length * 1.5, `${k}: "${b.criteria[k]}" outgrows "${v}"`);
  }
});

test("a stalled SubQ server is cut off after the client's timeout and returned as an error, never a hang", async () => {
  const srv = createServer(() => { /* never answers */ });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as AddressInfo;
  try {
    const t0 = Date.now();
    const r = await httpClient({ endpoint: `http://127.0.0.1:${port}/v1/systemone`, key: "test-key", timeoutMs: 150 })({ model: "m", state: {}, questions: {} });
    assert.equal(r.body, null);
    assert.ok(r.error, "an error, not an answer");
    assert.ok(Date.now() - t0 < 5_000, "returned promptly");
    assert.ok(SUBQ_TIMEOUT_MS > 0 && SUBQ_TIMEOUT_MS <= 60_000);
  } finally { srv.closeAllConnections(); srv.close(); }
});

test("a route with one failed call of two records the failure count in its meter, so missing answers read as a failure and not as SubQ's answer", async () => {
  const { root, ledger, inc } = routeBed();
  let n = 0;
  const half: SubqClient = async (req) => (n++ === 0 ? { status: 500, body: null, error: "HTTP 500", wall_ms: 1 } : fake({})(req));
  const many = Array.from({ length: 130 }, (_, i) => ({ ...skills[0], id: `SKL-${String(i + 1).padStart(4, "0")}` }));
  const r = await route(inc, { client: half, root, ledger, skills: many, observations: [] });
  assert.equal(r.meter.calls, 2);
  const cur = current<Incident>("incidents.jsonl", inc.id, ledger)!;
  assert.equal(cur.route?.[ROUTE_META_KEY].failed, 1);
  assert.equal(cur.route?.subsystem, undefined, "the failed first call held the subsystem question");
  const task: RepairTask = { kind: "incident", incident: inc.id, base_commit: "x", arm: "fast", skills: [], policies: [], budget: { max_steps: 1, wall_s: 1 } };
  assert.equal(subsystemOf(task, cur), null, "no subsystem: no narrowing");
});

test("the mechanism forecast request leaves before the gate writes a verdict, and its state carries no verdict, check name or decision", async () => {
  const bed = makeBed();
  const seen: { key: string; verdicts: number; state: string }[] = [];
  const inner = fake({ noul: 0.4 });
  const prev = setSubqClient(async (req) => {
    seen.push({ key: Object.keys(req.questions)[0], verdicts: read("verdicts.jsonl", bed.paths.ledger).length, state: JSON.stringify(req.state) });
    return inner(req);
  });
  try {
    const r = await runFastCycle("INC-0001", { paths: bed.paths, runner: fakeRunner((d) => setShade(d, FIX), { dispositions: {}, off_map: null, beliefs: [], summary: "x." }),
      replayer: isolatedReplayer(bed.paths.root), suites: steady, quiet: true });
    const mech = seen.find((s) => s.key === "mechanism");
    assert.ok(mech, "the mechanism question was asked");
    assert.equal(mech.verdicts, 0, "asked before any verdict");
    for (const w of ["GRADUATE", "REFUSE", "H-no-regress", "diff-scope", "admitted-traces", "base-suites", r.verdict.id]) assert.ok(!mech.state.includes(w), `state names ${w}`);
    assert.equal(current<Attempt>("attempts.jsonl", r.attempt.id, bed.paths.ledger)![FORECAST_FIELDS.mechanism]?.yes, 0.4, "and recorded");
  } finally { setSubqClient(prev); }
});

test("routeCalibrationOf leaves unscored a route whose only GRADUATE repair ran under a policy (circular), counts it as steered, and reports the uniform-pick chance beside accuracy", () => {
  const { ledger } = routeBed();
  append("incidents.jsonl", { ...current<Incident>("incidents.jsonl", "INC-0001", ledger)!, id: "INC-0002" }, ledger);
  const rt = (sub: Record<string, number>) => ({ subsystem: sub, [ROUTE_SENSOR_KEY]: routeSensor(sub, {})! });
  status("incidents.jsonl", "INC-0001", "route", rt({ ppu_fetcher: 0.6, timer: 0.2, other: 0.2 }), ledger);
  status("incidents.jsonl", "INC-0002", "route", rt({ timer: 0.6, ppu_fetcher: 0.2, other: 0.2 }), ledger);
  const task = (inc: string, policies: string[]) => ({ kind: "incident", incident: inc, base_commit: "b", arm: "fast", skills: [], policies, budget: { max_steps: 1, wall_s: 1 } });
  append("attempts.jsonl", { id: "ATT-0001", at: "2999-01-01T00:00:00.000Z", run: null, task: task("INC-0001", []) }, ledger);
  append("attempts.jsonl", { id: "ATT-0002", at: "2999-01-01T00:00:00.000Z", run: null, task: task("INC-0002", ["POL-0001"]) }, ledger);
  for (const [i, a] of ["ATT-0001", "ATT-0002"].entries()) append("verdicts.jsonl", { id: `VER-000${i + 1}`, subject: { kind: "attempt", id: a }, decision: "GRADUATE", checks: [] }, ledger);
  writeFileSync(join(ledger, "provenance.json"), JSON.stringify([
    { handler: "ppu.fetcher", file: "core/ppu.ts", commit: "c1", attempt: "ATT-0001" },
    { handler: "timer", file: "core/index.ts", commit: "c2", attempt: "ATT-0002" },
  ]));
  const c = routeCalibrationOf(ledger);
  assert.deepEqual([c.subsystem.n, c.subsystem.steered, c.subsystem.accuracy], [1, 1, 1]);
  // core/ppu.ts holds ppu_fetcher, window and oam_dma handlers: of INC-0001's three options only ppu_fetcher is in that set
  assert.equal(c.subsystem.chance, 1 / 3);
});
