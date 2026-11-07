import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { append, appendNew, current, all, status, nextId, LINE_LIMIT } from "./ledger.ts";
import { LedgerIncidentSink } from "./incident-sink.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "ratchet-ledger-"));

test("appendNew mints PREFIX-NNNN one past the highest id in the file", () => {
  const d = tmp();
  assert.equal(appendNew("attempts.jsonl", "ATT", (id) => ({ id }), d).id, "ATT-0001");
  append("attempts.jsonl", { id: "ATT-0007" }, d);
  assert.equal(appendNew("attempts.jsonl", "ATT", (id) => ({ id }), d).id, "ATT-0008");
  assert.equal(nextId("VER", []), "VER-0001");
});

test("current(id) folds status records, the last one written wins", () => {
  const d = tmp();
  append("incidents.jsonl", { id: "INC-0001", status: "open" }, d);
  status("incidents.jsonl", "INC-0001", "status", "repaired", d);
  status("incidents.jsonl", "INC-0001", "status", "unrepaired", d);
  assert.equal(current<{ status: string }>("incidents.jsonl", "INC-0001", d)!.status, "unrepaired");
  assert.equal(all("incidents.jsonl", d).length, 1);
});

test("a line of LINE_LIMIT bytes or more is refused and nothing is written", () => {
  const d = tmp();
  assert.throws(() => append("steers.jsonl", { id: "x", text: "a".repeat(LINE_LIMIT) }, d), /LINE_LIMIT/);
  assert.equal(existsSync(join(d, "steers.jsonl")), false);
  assert.equal(existsSync(join(d, ".lock")), false);
});

test("appends from 4 processes at once leave 200 whole lines with 200 distinct ids", () => {
  const d = tmp();
  const script = join(d, "w.ts");
  writeFileSync(script, `import { appendNew } from ${JSON.stringify(join(import.meta.dirname, "ledger.ts"))};\nfor (let i = 0; i < 50; i++) appendNew("fires.jsonl", "FIR", (id) => ({ id, pad: "x".repeat(500) }), ${JSON.stringify(d)});\n`);
  const sh = spawnSync("sh", ["-c", Array.from({ length: 4 }, () => `${JSON.stringify(process.execPath)} ${JSON.stringify(script)} &`).join(" ") + " wait"], { encoding: "utf8" });
  assert.equal(sh.status, 0, sh.stderr);
  const lines = readFileSync(join(d, "fires.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 200);
  const ids = new Set(lines.map((l) => JSON.parse(l).id));
  assert.equal(ids.size, 200);
});

test("two run processes (RUN-0001, RUN-0002) appending incidents and status records to one ledger at once mint INC-0001…INC-0200 with no gap or repeat, and every record carries its own process's run", () => {
  const d = tmp();
  const script = join(d, "w.ts");
  writeFileSync(script, `import { appendNew, status } from ${JSON.stringify(join(import.meta.dirname, "ledger.ts"))};
for (let i = 0; i < 100; i++) {
  const r = appendNew("incidents.jsonl", "INC", (id) => ({ id, run: process.env.RATCHET_RUN, status: "open", pad: "x".repeat(300) }), ${JSON.stringify(d)});
  status("incidents.jsonl", r.id, "route", { by: process.env.RATCHET_RUN }, ${JSON.stringify(d)});
}\n`);
  const sh = spawnSync("sh", ["-c", ["RUN-0001", "RUN-0002"].map((r) => `RATCHET_RUN=${r} ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} &`).join(" ") + " wait"], { encoding: "utf8" });
  assert.equal(sh.status, 0, sh.stderr);
  const recs = readFileSync(join(d, "incidents.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(recs.length, 400);
  const incs = recs.filter((r) => r.t !== "status");
  assert.deepEqual(incs.map((r) => r.id).sort(), Array.from({ length: 200 }, (_, i) => `INC-${String(i + 1).padStart(4, "0")}`));
  assert.deepEqual([...new Set(incs.map((r) => r.run))].sort(), ["RUN-0001", "RUN-0002"]);
  assert.equal(incs.filter((r) => r.run === "RUN-0002").length, 100);
  for (const s of recs.filter((r) => r.t === "status")) {
    assert.equal(s.run, s.value.by, "a status record carries its writer's run");
    assert.equal(incs.find((i) => i.id === s.id)?.run, s.run, "a status record's incident is its own run's");
  }
  for (const i of all<{ id: string; run: string; route?: { by: string } }>("incidents.jsonl", d)) assert.equal(i.route?.by, i.run);
});

test("LedgerIncidentSink mints INC ids through the ledger and lists open incidents only", () => {
  const d = tmp();
  const sink = new LedgerIncidentSink(d);
  const a = sink.record((id) => ({ id, status: "open" }) as never);
  sink.record((id) => ({ id, status: "open" }) as never);
  status("incidents.jsonl", a.id, "status", "repaired", d);
  assert.equal(a.id, "INC-0001");
  assert.deepEqual(sink.open().map((i) => i.id), ["INC-0002"]);
});
