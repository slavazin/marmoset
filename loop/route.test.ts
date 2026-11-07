import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.RATCHET_TELEMETRY_DIR = mkdtempSync(join(tmpdir(), "ratchet-tel-"));
delete process.env.RATCHET_RUN;
const { route, routeSkills, routeCalibration, MAX_QUESTIONS, MAX_IMAGES, ROUTE_META_KEY } = await import("./route.ts");
const { read, current, append, status } = await import("./ledger.ts");
import type { Incident } from "../src/schema.ts";
import type { SubqClient, SubqRequest, RouteSkill } from "./route.ts";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

function fixture(): { root: string; ledger: string; inc: Incident } {
  const root = mkdtempSync(join(tmpdir(), "ratchet-route-"));
  const ledger = join(root, "ledger");
  mkdirSync(ledger);
  const ev = join(root, "evidence/incidents/INC-0001");
  mkdirSync(ev, { recursive: true });
  for (const f of ["core.png", "oracle.png", "diff.png"]) writeFileSync(join(ev, f), PNG);
  writeFileSync(join(ev, "regwrites.jsonl"), `{"addr":65344,"value":145,"ly":0,"dot":4,"cycles":10}\n{"addr":65347,"value":3,"ly":2,"dot":80,"cycles":900}\n`);
  mkdirSync(join(root, "core"));
  writeFileSync(join(root, "core/ppu.ts"), "");
  const inc: Incident = { id: "INC-0001", at: "2026-11-07T00:00:00.000Z", run: null, kind: "frame", align: "counter", signature: { scene: 0, band: 2, bbox: [0, 16, 160, 136] },
    rom_sha: "r", trace_sha: "t", window: [1, 121], core_commit: "c", counter: 13, pixels: 260, files: { dir: "evidence/incidents/INC-0001" }, source: "play", status: "open", narration: "the title shifts" };
  append("incidents.jsonl", inc, ledger);
  return { root, ledger, inc };
}

function fakeClient(calls: SubqRequest[]): SubqClient {
  return async (req) => {
    calls.push(req);
    const answers: Record<string, any> = {};
    for (const [k, q] of Object.entries(req.questions)) {
      if (q.type === "noul") answers[k] = { type: "noul", noul: k.endsWith("0002") ? 0.9 : 0.2 };
      else if (q.type === "choice") answers[k] = { type: "choice", choice: "ppu_fetcher", probabilities: { ppu_fetcher: 0.7, stat_irq: 0.1, oam_dma: 0.05, window: 0.05, timer: 0.05, other: 0.05 }, confidence: 0.7 };
      else answers[k] = { type: "score", score: 1.2, legend: { 0: "a", 1: "b", 2: "c" }, probabilities: { 0: 0.2, 1: 0.4, 2: 0.4 }, confidence: 0.4 };
    }
    return { status: 200, wall_ms: 5, body: { model: "subq-snap-1.1", answers, usage: { input_tokens: 1000, output_tokens: 0 } } };
  };
}

const skills = (n: number): RouteSkill[] => Array.from({ length: n }, (_, i) => ({ id: `SKL-${String(i + 1).padStart(4, "0")}`, firesWhen: "a PPU file is edited", notThis: "CPU timing", paths: ["core/ppu.ts"] }));

test("route asks every question in one call carrying at most MAX_QUESTIONS questions and at most MAX_IMAGES images, with the full regwrites and narration in state", async () => {
  const { root, ledger, inc } = fixture();
  const calls: SubqRequest[] = [];
  const r = await route(inc, { client: fakeClient(calls), root, ledger, skills: skills(3), observations: [{ id: "OBS-0001", text: "LCDC bit flips mid-frame", anchor: { attempt: "ATT-0001" } }] });
  assert.equal(calls.length, 1);
  assert.ok(Object.keys(calls[0].questions).length <= MAX_QUESTIONS);
  assert.deepEqual(Object.keys(calls[0].questions), ["subsystem", "mid_line", "severity", "applies:SKL-0001", "applies:SKL-0002", "applies:SKL-0003", "same_shape_as:OBS-0001"]);
  assert.equal(calls[0].images?.length, 3);
  assert.ok((calls[0].images?.length ?? 0) <= MAX_IMAGES);
  assert.equal(calls[0].images?.[0].base64, PNG.toString("base64"));
  const st = calls[0].state as Record<string, any>;
  assert.equal(st.regwrites.length, 2);
  assert.equal(st.narration, "the title shifts");
  assert.ok(st.core.files.includes("core/ppu.ts") && st.core.handlers["ppu.fetcher"]);
  assert.equal(r.meter.questions, 7);
  assert.equal(r.meter.tokens_in, 1000);
});

test("a 129th question is split into a second call, and both calls' answers land in one route status record with one router spend record per call", async () => {
  const { root, ledger, inc } = fixture();
  const calls: SubqRequest[] = [];
  const r = await route(inc, { client: fakeClient(calls), root, ledger, skills: skills(MAX_QUESTIONS + 1 - 3), observations: [] });
  assert.deepEqual(calls.map((c) => Object.keys(c.questions).length), [MAX_QUESTIONS, 1]);
  const routes = read("incidents.jsonl", ledger).filter((x) => x.t === "status" && x.field === "route");
  assert.equal(routes.length, 1);
  const cur = current<Incident>("incidents.jsonl", inc.id, ledger)!;
  assert.equal(cur.route?.subsystem.ppu_fetcher, 0.7);
  assert.equal(cur.route?.mid_line.yes, 0.2);
  assert.equal(cur.route?.[ROUTE_META_KEY].calls, 2);
  assert.equal(cur.route?.[ROUTE_META_KEY].questions, MAX_QUESTIONS + 1);
  const spend = read("spend.jsonl", ledger);
  assert.equal(spend.length, 2);
  assert.ok(spend.every((s) => s.role === "router" && s.tokens_in === 1000 && s.tokens_out === 0 && Math.abs((s.usd as number) - 0.00004) < 1e-12));
  assert.ok(r.meter.dropped >= 0);
});

test("a failed call writes spend but no route record", async () => {
  const { root, ledger, inc } = fixture();
  const r = await route(inc, { client: async () => ({ status: 401, body: null, error: "HTTP 401", wall_ms: 3 }), root, ledger, skills: [], observations: [] });
  assert.deepEqual(r.errors, ["HTTP 401"]);
  assert.equal(read("incidents.jsonl", ledger).filter((x) => x.t === "status").length, 0);
  assert.equal(read("spend.jsonl", ledger).length, 1);
});

test("routeSkills orders skill ids by applies: probability, unrouted last, and keeps k", () => {
  const inc = { route: { "applies:SKL-0001": { yes: 0.2 }, "applies:SKL-0002": { yes: 0.9 }, "applies:SKL-0003": { yes: 0.5 } } };
  assert.deepEqual(routeSkills(inc, ["SKL-0001", "SKL-0002", "SKL-0003", "SKL-0004"], 3), ["SKL-0002", "SKL-0003", "SKL-0001"]);
  assert.deepEqual(routeSkills(inc, ["SKL-0004", "SKL-0001"], 5), ["SKL-0001", "SKL-0004"]);
  assert.deepEqual(routeSkills({}, ["SKL-0002", "SKL-0001"], 1), ["SKL-0001"]);
});

test("routeCalibration on an empty ledger reports n = 0 with null brier and accuracy, never 0 accuracy", () => {
  const c = routeCalibration(mkdtempSync(join(tmpdir(), "ratchet-cal-")));
  assert.deepEqual(c, { routed: 0, subsystem: { n: 0, brier: null, accuracy: null }, applies: { n: 0, brier: null, accuracy: null } });
});

test("routeCalibration scores subsystem against a GRADUATED repair's provenance files and applies: against later fires", () => {
  const { ledger, inc } = fixture();
  status("incidents.jsonl", inc.id, "route", { subsystem: { ppu_fetcher: 0.7, timer: 0.3 }, "applies:SKL-0001": { yes: 0.8 }, "applies:SKL-0002": { yes: 0.6 } }, ledger);
  const att = (id: string) => ({ id, at: "2999-01-01T00:00:00.000Z", run: null, task: { kind: "incident", incident: inc.id, base_commit: "b", arm: "fast", skills: ["SKL-0001", "SKL-0002"], budget: { max_steps: 1, wall_s: 1 } } });
  append("attempts.jsonl", att("ATT-0001"), ledger);
  append("verdicts.jsonl", { id: "VER-0001", subject: { kind: "attempt", id: "ATT-0001" }, decision: "GRADUATE" }, ledger);
  append("fires.jsonl", { id: "FIR-0001", skill: "SKL-0001", attempt: "ATT-0001", path: "core/ppu.ts", owed: "x" }, ledger);
  writeFileSync(join(ledger, "provenance.json"), JSON.stringify([{ handler: "ppu.fetcher", file: "core/ppu.ts", commit: "c", attempt: "ATT-0001" }]));
  const c = routeCalibration(ledger);
  assert.equal(c.subsystem.n, 1);
  assert.equal(c.subsystem.accuracy, 1);
  assert.equal(c.applies.n, 2);
  assert.equal(c.applies.accuracy, 0.5); // SKL-0001 fired at 0.8 (hit), SKL-0002 did not at 0.6 (miss)
});
