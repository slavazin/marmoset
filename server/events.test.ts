import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonl, Fold, EventBus, MAX_FRAMES_PER_S, curveEvents } from "./events.ts";
import type { UiEvent } from "../src/schema.ts";

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "ratchet-ui-"));
  const paths = { ledger: join(d, "ledger"), runs: join(d, "runs"), evidence: join(d, "evidence") };
  mkdirSync(paths.ledger); mkdirSync(paths.runs);
  return paths;
};

test("parseJsonl returns a trailing partial line as rest and skips malformed lines", () => {
  const r = parseJsonl('{"id":"A"}\nnot json\n{"id":"B"}\n{"id":"C"');
  assert.deepEqual(r.records, [{ id: "A" }, { id: "B" }]);
  assert.equal(r.rest, '{"id":"C"');
});

test("Fold applies status records to their id, the last one written wins, and ignores unknown ids", () => {
  const f = new Fold();
  f.apply({ id: "INC-0001", status: "open" });
  f.apply({ t: "status", id: "INC-0001", field: "status", value: "repaired", at: "x", run: null });
  f.apply({ t: "status", id: "INC-0001", field: "status", value: "unrepaired", at: "y", run: null });
  assert.equal(f.apply({ t: "status", id: "INC-9999", field: "status", value: "open", at: "z", run: null }), null);
  assert.equal(f.get("INC-0001")!.status, "unrepaired");
  assert.equal(f.all().length, 1);
});

test("EventBus.poll emits one event per record appended to a tailed ledger file, across a split append", () => {
  const paths = tmp();
  const file = join(paths.ledger, "verdicts.jsonl");
  writeFileSync(file, JSON.stringify({ id: "VER-0001", decision: "REFUSE", subject: { kind: "attempt", id: "ATT-0001" }, checks: [] }) + "\n");
  const bus = new EventBus(paths);
  const got: UiEvent[] = [];
  bus.subscribe((e) => got.push(e));
  appendFileSync(file, '{"id":"VER-0002","decision":"GRA');
  bus.poll();
  assert.equal(got.length, 0, "a half-written line emits nothing");
  appendFileSync(file, 'DUATE","subject":{"kind":"attempt","id":"ATT-0002"},"checks":[]}\n');
  bus.poll();
  assert.equal(got.length, 1);
  assert.equal(got[0].t === "verdict" && got[0].verdict.id, "VER-0002");
  assert.equal(bus.state().verdicts.length, 2);
});

test("EventBus.publish forwards at most MAX_FRAMES_PER_S frames per second per source", () => {
  const bus = new EventBus(tmp());
  const frame = (source: "core" | "oracle"): UiEvent => ({ t: "frame", source, shades_b64: "", counter: 0 });
  let forwarded = 0;
  for (let ms = 0; ms < 1000; ms++) if (bus.publish(frame("oracle"), ms)) forwarded++;
  assert.equal(forwarded, MAX_FRAMES_PER_S);
  assert.equal(bus.publish(frame("core"), 999), true, "the cap is per source");
});

test("the V read stays out of state and snapshot until runs/RUN-*/vread.json exists", () => {
  const paths = tmp();
  const bus = new EventBus(paths);
  assert.equal(bus.state().vread, null);
  assert.ok(!bus.snapshot().some((e) => e.t === "vread"));
  mkdirSync(join(paths.runs, "RUN-0001"));
  writeFileSync(join(paths.runs, "RUN-0001", "vread.json"), JSON.stringify({ run: "RUN-0001", arms: { baseline: [], ratchet: [] }, n_family_runs_per_arm: 1, residue: [] }));
  const got: UiEvent[] = [];
  bus.subscribe((e) => got.push(e));
  bus.poll();
  assert.ok(got.some((e) => e.t === "vread"));
});

test("curveEvents numbers skill verdicts with arms as generations and skips attempt verdicts", () => {
  const arms = { candidate: [], baseline: [], placebo: [], margin: {}, n_family_runs_per_arm: 2 };
  const c = curveEvents([
    { id: "VER-0001", subject: { kind: "attempt", id: "ATT-0001" } },
    { id: "VER-0002", subject: { kind: "skill", id: "SKL-0001" }, arms },
    { id: "VER-0003", subject: { kind: "skill", id: "SKL-0002" }, arms },
  ]);
  assert.deepEqual(c.map((e) => e.t === "curve" && e.generation), [1, 2]);
});

test("curveEvents plots a skill verdict at its generation, so a generation's trials share one point, and numbers verdicts without one in order after the last", () => {
  const arms = { candidate: [], baseline: [], placebo: [], margin: {}, n_family_runs_per_arm: 1 };
  const c = curveEvents([
    { id: "VER-0001", subject: { kind: "skill", id: "SKL-0001" }, arms, generation: 1 },
    { id: "VER-0002", subject: { kind: "skill", id: "SKL-0002" }, arms, generation: 1 },
    { id: "VER-0003", subject: { kind: "attempt", id: "ATT-0001" } },
    { id: "VER-0004", subject: { kind: "skill", id: "SKL-0005" }, arms, generation: 2 },
    { id: "VER-0005", subject: { kind: "skill", id: "SKL-0007" }, arms },
  ]);
  assert.deepEqual(c.map((e) => e.t === "curve" && e.generation), [1, 1, 2, 3]);
});
