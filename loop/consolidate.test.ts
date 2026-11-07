import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.RATCHET_TELEMETRY_DIR ??= mkdtempSync(join(tmpdir(), "ratchet-tel-"));
import { makeBed } from "./fixtures/harness.ts";
import { seedObservations, fakeLlm, REPLY, nomination } from "./fixtures/slow.ts";
import { consolidatorView, consolidate, parseReply, heldOutNames, parseSkill, MAX_NOMINATIONS } from "./consolidate.ts";
import { append, current, read } from "./ledger.ts";
import { loadSplits, familiesIn } from "../suites/splits.ts";
import type { Attempt, SuiteReading, Verdict } from "../src/schema.ts";

test("consolidatorView carries no H or V family name, no verdict, no non-fast attempt and no H reading, even when observations, off_map and readings name them", () => {
  const bed = makeBed();
  const splits = loadSplits();
  const held = heldOutNames(splits);
  assert.ok(held.includes("mealybug:window") && held.includes("mooneye:dma-timer-intr"));
  seedObservations(bed, { offMap: "Running mealybug:window and mooneye:dma-timer-intr showed the fix.", text: "A divergence like mooneye:ppu was refused." });
  // a trial arm attempt and a skill verdict with H checks: neither may reach the view
  const trial: Attempt = { ...(read("attempts.jsonl", bed.paths.ledger)[0] as unknown as Attempt), id: "ATT-0090", task: { kind: "family", family: "mealybug:window", base_commit: "x", arm: "candidate", skills: [], budget: { max_steps: 1, wall_s: 1 } }, result: { dispositions: {}, off_map: "mealybug:wx-obj", beliefs: [], summary: "s" } };
  append("attempts.jsonl", trial, bed.paths.ledger);
  append("observations.jsonl", { id: "OBS-0090", at: "x", run: null, anchor: { attempt: "ATT-0090" }, text: "trial arm on mooneye:ppu" }, bed.paths.ledger);
  const v: Partial<Verdict> = { id: "VER-0001", subject: { kind: "skill", id: "SKL-0001" }, decision: "REFUSE", checks: [{ name: "H-no-regress", pass: false, reading: { family: "mealybug:window" } }], reason: "mealybug:window" };
  append("verdicts.jsonl", v, bed.paths.ledger);
  const readings: SuiteReading[] = [
    ...familiesIn(splits, "T").map((family) => ({ split: "T" as const, family, roms: 9, pass: 1, exact: 1, pixel_match: 0.8 })),
    { split: "H", family: "mealybug:window", roms: 10, pass: 0, exact: 0, pixel_match: 0.5 },
    { split: "T", family: "mooneye:ppu", roms: 12, pass: 3, exact: 3, pixel_match: 0 },
  ];
  const view = consolidatorView(bed.paths, readings, splits);
  const s = JSON.stringify(view);
  for (const name of held) assert.ok(!s.includes(name), `view names ${name}`);
  assert.ok(!s.includes("VER-"), "view carries a verdict id");
  assert.ok(!s.includes("ATT-0090") && !s.includes("OBS-0090"), "view carries a trial-arm attempt");
  assert.deepEqual(Object.keys(view).sort(), ["dispositions", "observations", "off_map", "t_readings"]);
  assert.equal(view.observations.length, 5);
  assert.deepEqual(view.t_readings.map((r) => r.family).sort(), familiesIn(splits, "T").sort());
  assert.deepEqual(view.dispositions, [{ attempt: "ATT-0002", marks: { "SKL-0009": "considered-not-applicable" } }]);
  assert.equal(view.off_map.length, 1);
});

test("consolidatorView does not say which gate check refused a fast attempt, so a refusal at H-no-regress does not reach the consolidator", () => {
  const bed = makeBed();
  seedObservations(bed, { text: "A frame divergence in scene 1, line band 1, was refused at H-no-regress after a repair that shifted tiles." });
  const view = consolidatorView(bed.paths, []);
  const s = JSON.stringify(view);
  assert.ok(!s.includes("H-no-regress"), "view names the H check");
  assert.ok(!/refused at /.test(s), "view names a refusing check");
  assert.match(view.observations[0].text, /was refused after a repair that shifted tiles/);
});

test("parseReply keeps at most MAX_NOMINATIONS, each with a complete pentad and >= 2 reducible anchors of its shape", () => {
  const bed = makeBed();
  seedObservations(bed);
  const view = consolidatorView(bed.paths, []);
  const reply = {
    triage: REPLY.triage,
    nominations: [
      ...REPLY.nominations,
      nomination("third-one", "tile-shift", ["OBS-0001", "OBS-0002"]),
      nomination("noise-skill", "replay-flake", ["OBS-0005", "OBS-0001"]),
      nomination("one-anchor", "tile-shift", ["OBS-0001", "OBS-0099"]),
      { ...nomination("no-dont", "tile-shift", ["OBS-0001", "OBS-0002"]), dont: "" },
    ],
  };
  const r = parseReply(JSON.stringify(reply), view);
  assert.equal(r.nominations.length, MAX_NOMINATIONS);
  assert.deepEqual(r.nominations.map((n) => n.name), ["fetcher-steps-not-delays", "latch-palette-at-fetch"]);
  const why = Object.fromEntries(r.dropped.map((d) => [d.name, d.why]));
  assert.match(why["third-one"], /MAX_NOMINATIONS/);
  assert.match(why["noise-skill"], /reducible anchors/);
  assert.match(why["one-anchor"], /reducible anchors/);
  assert.match(why["no-dont"], /incomplete pentad: dont/);
});

test("consolidate appends shape and reducible status records per observation, writes each nomination as a shadow SKILL.md with a complete pentad, and records spend", async () => {
  const bed = makeBed();
  seedObservations(bed);
  const llm = fakeLlm();
  const out = await consolidate({ paths: bed.paths, tReadings: [], llm, generation: 1 });
  assert.equal(llm.reqs[0].model, "muse-wonder-1.0");
  assert.equal(llm.reqs[0].role, "consolidator");
  assert.deepEqual(out.nominated.map((n) => n.id), ["SKL-0001", "SKL-0002"]);
  assert.deepEqual(out.detection, [{ shape: "replay-flake", observations: ["OBS-0005"] }]);
  const o1 = current<Record<string, unknown>>("observations.jsonl", "OBS-0001", bed.paths.ledger)!;
  assert.equal(o1.shape, "tile-shift");
  assert.equal(o1.reducible, true);
  assert.equal(current<Record<string, unknown>>("observations.jsonl", "OBS-0005", bed.paths.ledger)!.reducible, false);
  const sk = parseSkill(readFileSync(join(bed.paths.skills, "shadow", "SKL-0001", "SKILL.md"), "utf8"));
  assert.equal(sk.fm.status, "shadow");
  assert.equal(sk.fm.name, "fetcher-steps-not-delays");
  assert.deepEqual(sk.fm.activation.paths, ["core/ppu*.ts"]);
  assert.deepEqual(sk.fm.warrant.anchors, ["OBS-0001", "OBS-0002"]);
  for (const v of [sk.fm.activation["fires-when"], sk.fm.activation["not-this"], sk.fm.activation.owed, sk.fm.warrant["false-if"], sk.fm.enforcement.residue, sk.fm.lifecycle["retire-when"], sk.do, sk.dont]) assert.ok(v.length > 10, v);
  assert.deepEqual(sk.fm.enforcement["checked-by"], ["admitted-traces", "H-no-regress"]);
  const spend = read("spend.jsonl", bed.paths.ledger);
  assert.equal(spend.length, 1);
  assert.equal(spend[0].role, "consolidator");
  assert.ok(Number(spend[0].usd) > 0);
});

test("a failed consolidator call writes no triage and no skill", async () => {
  const bed = makeBed();
  seedObservations(bed);
  const out = await consolidate({ paths: bed.paths, tReadings: [], generation: 1, llm: async () => ({ ok: false, text: "", reasoning: "", model_echoed: "muse-wonder-1.0", finish_reason: "stop", usage: { prompt: 1, completion: 1, reasoning: 1 }, wall_ms: 1, http_status: 200, error: "no usable output" }) });
  assert.equal(out.nominated.length, 0);
  assert.equal(read("observations.jsonl", bed.paths.ledger).filter((r) => r.t === "status").length, 0);
});
