import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Incident } from "../src/schema.ts";
import { JsonlIncidentSink, MAX_LINE_BYTES, MemoryIncidentSink } from "./incidents.ts";

const make = (id: string): Incident => ({
  id, at: "2026-11-07T00:00:00.000Z", run: null, kind: "frame", align: "counter",
  signature: { scene: 0, band: 9, bbox: [16, 72, 48, 80] }, rom_sha: "r", trace_sha: "t", window: [240, 420],
  core_commit: "c", counter: 300, pixels: 112, files: { dir: `evidence/incidents/${id}` }, source: "play", status: "open",
});

test("the JSONL sink mints INC-0001 then INC-0002, writes one line each under 4 KB, and removes ledger/.lock after each append", () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-inc-"));
  const sink = new JsonlIncidentSink(join(dir, "incidents.jsonl"));
  assert.equal(sink.record(make).id, "INC-0001");
  assert.equal(existsSync(join(dir, ".lock")), false);
  assert.equal(sink.record(make).id, "INC-0002");
  const lines = readFileSync(join(dir, "incidents.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  for (const l of lines) assert.ok(Buffer.byteLength(l) + 1 < MAX_LINE_BYTES);
  assert.deepEqual(sink.open().map((i) => i.id), ["INC-0001", "INC-0002"]);
});

test("the JSONL sink refuses to append while another writer holds ledger/.lock, and leaves the file unchanged", () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-inc-"));
  writeFileSync(join(dir, ".lock"), "");
  const sink = new JsonlIncidentSink(join(dir, "incidents.jsonl"), join(dir, ".lock"), 50);
  assert.throws(() => sink.record(make), /held/);
  assert.equal(existsSync(join(dir, "incidents.jsonl")), false);
});

test("an appended status record flipping an incident to repaired removes it from open()", () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-inc-"));
  const path = join(dir, "incidents.jsonl");
  const sink = new JsonlIncidentSink(path);
  sink.record(make);
  appendFileSync(path, JSON.stringify({ t: "status", id: "INC-0001", field: "status", value: "repaired", at: "2026-11-07T00:00:01.000Z", run: null }) + "\n");
  assert.deepEqual(sink.open(), []);
  assert.equal(sink.record(make).id, "INC-0002");
});

test("the memory sink mints sequential ids and lists them open", () => {
  const sink = new MemoryIncidentSink();
  sink.record(make);
  sink.record(make);
  assert.deepEqual(sink.open().map((i) => i.id), ["INC-0001", "INC-0002"]);
});
