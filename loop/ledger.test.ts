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

test("LedgerIncidentSink mints INC ids through the ledger and lists open incidents only", () => {
  const d = tmp();
  const sink = new LedgerIncidentSink(d);
  const a = sink.record((id) => ({ id, status: "open" }) as never);
  sink.record((id) => ({ id, status: "open" }) as never);
  status("incidents.jsonl", a.id, "status", "repaired", d);
  assert.equal(a.id, "INC-0001");
  assert.deepEqual(sink.open().map((i) => i.id), ["INC-0002"]);
});
