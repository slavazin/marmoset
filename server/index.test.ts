import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createServer } from "./index.ts";
import type { Trace, UiEvent } from "../src/schema.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fx = join(root, "ui", "fixtures");
const cache = mkdtempSync(join(tmpdir(), "ratchet-cache-"));
const ledgerBefore = readdirSync(join(fx, "ledger")).map((f) => [f, statSync(join(fx, "ledger", f)).mtimeMs]);
const { server } = createServer({ ledger: join(fx, "ledger"), runs: join(fx, "runs"), evidence: join(fx, "evidence"), game: join(root, "game"), cache });
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => { server.closeAllConnections(); server.close(); });

const postJson = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("GET /api/state returns the folded fixture ledger with no V read", async () => {
  const s = await (await fetch(base + "/api/state")).json();
  assert.equal(s.verdicts.length, 3);
  assert.equal(s.incidents.find((i: { id: string }) => i.id === "INC-0001").status, "repaired");
  assert.equal(s.provenance[0].handler, "ppu.fetcher");
  assert.equal(s.curve.length, 1);
  assert.equal(s.vread, null);
});

test("GET /evidence serves an incident's PNG and refuses a path outside the evidence dir", async () => {
  const r = await fetch(base + "/evidence/incidents/INC-0001/oracle.png");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()).slice(1, 4), new Uint8Array([0x50, 0x4e, 0x47]));
  const bad = await fetch(base + "/evidence/..%2F..%2Fpackage.json");
  assert.notEqual(bad.status, 200);
});

test("POST /api/input records mask changes into the live trace file, keyed by counter", async () => {
  assert.equal((await postJson("/api/trace/reset", { rom_sha: "abc" })).status, 200);
  for (const [counter, mask] of [[10, 1], [12, 1], [20, 0], [20, 16]]) assert.equal((await postJson("/api/input", { counter, mask })).status, 200);
  assert.equal((await postJson("/api/input", { counter: -1, mask: 1 })).status, 400);
  const t = JSON.parse(readFileSync(join(cache, "traces", "live.json"), "utf8")) as Trace;
  assert.equal(t.rom_sha, "abc");
  assert.equal(t.align, "counter");
  assert.deepEqual(t.inputs, [{ from_counter: 10, mask: 1 }, { from_counter: 20, mask: 16 }]);
  assert.equal(t.counter_end, 20);
});

test("POST /api/event accepts producer frames and refuses verdicts, which reach the screen only through the ledger", async () => {
  assert.equal((await postJson("/api/event", { t: "verdict", verdict: {} })).status, 400);
  const r = await postJson("/api/event", { t: "frame", source: "oracle", shades_b64: "", counter: 1 });
  assert.equal(r.status, 200);
});

test("GET /events opens with a snapshot carrying every fixture verdict, and the server wrote no ledger file", async () => {
  const ac = new AbortController();
  const r = await fetch(base + "/events", { signal: ac.signal });
  assert.equal(r.headers.get("content-type"), "text/event-stream");
  const reader = r.body!.getReader();
  let text = "";
  while ((text.match(/"t":"verdict"/g) ?? []).length < 3) text += new TextDecoder().decode((await reader.read()).value);
  ac.abort();
  const events = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)) as UiEvent);
  assert.deepEqual(events.filter((e) => e.t === "verdict").map((e) => e.t === "verdict" && e.verdict.id), ["VER-0001", "VER-0002", "VER-0003"]);
  const ledgerAfter = readdirSync(join(fx, "ledger")).map((f) => [f, statSync(join(fx, "ledger", f)).mtimeMs]);
  assert.deepEqual(ledgerAfter, ledgerBefore);
});
