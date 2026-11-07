import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createServer } from "./index.ts";
import type { ServerOptions } from "./index.ts";
import { sseCollect } from "./sse-client.ts";
import type { SseMsg } from "./sse-client.ts";
import { tlog } from "../src/telemetry.ts";
import { append } from "../loop/ledger.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const servers: Server[] = [];
after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } });

async function listen(o: ServerOptions) {
  const made = createServer(o);
  servers.push(made.server);
  await new Promise<void>((r) => made.server.listen(0, r));
  return { ...made, base: `http://127.0.0.1:${(made.server.address() as AddressInfo).port}` };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = (base: string, path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const shades = (v: number) => Buffer.alloc(160 * 144, v).toString("base64");

test("a session recorded through the live server replays to an SSE client in the same order with the same payloads, frames thinned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-rec-"));
  const paths = { ledger: join(dir, "ledger"), runs: join(dir, "runs"), evidence: join(dir, "evidence"), game: join(root, "game"), cache: join(dir, "cache") };
  mkdirSync(paths.ledger, { recursive: true });
  process.env.RATCHET_TELEMETRY_DIR = join(paths.runs, "prerun", "telemetry");
  const prevRun = process.env.RATCHET_RUN; delete process.env.RATCHET_RUN;
  try {
    const live = await listen({ ...paths, record: true });
    const client = sseCollect(live.base + "/events");
    await sleep(50);
    const expected: unknown[] = [];
    const take = async (n: number) => { const want = expected.length - expected.filter((x) => (x as { stream?: string }).stream).length + n; await client.until((m) => m.filter((x) => x.event === "message" && (x.data as { t: string }).t !== "frame").length >= want); };
    const liveEvents = () => client.msgs.filter((m) => m.event === "message" && (m.data as { t: string }).t !== "frame").map((m) => m.data);
    const syncExpected = () => { for (const e of liveEvents().slice(expected.filter((x) => !(x as { stream?: string }).stream).length)) expected.push(e); };

    await post(live.base, "/api/event", { t: "meta", pc: 0x150, op: "NOP", ly: 3, mode: 2, stat: 0x85, ie: 1, if_: 0, hits: { "cpu.op": 4 }, provenance: [] });
    await take(1); syncExpected(); await sleep(5);
    await post(live.base, "/api/input", { counter: 10, mask: 0x10 });
    await take(1); syncExpected(); await sleep(5);
    const llm = { role: "player", model: "gemini-x", request: { prompt: "press A?" }, response: "A", tokens: { in: 4, out: 1 }, wall_ms: 120, outcome: "ok" };
    tlog("llm", "call", llm); expected.push({ stream: "llm", kind: "call", data: llm }); await sleep(5);
    append("incidents.jsonl", { id: "INC-0001", at: new Date().toISOString(), run: null, kind: "frame", counter: 10 }, paths.ledger);
    live.bus.poll(); await take(1); syncExpected(); await sleep(5);
    for (let i = 0; i < 3; i++) { await post(live.base, "/api/event", { t: "frame", source: "core", shades_b64: shades(i), counter: 10 + i }); await sleep(40); } // 40 ms passes MAX_FRAMES_PER_S
    await sleep(5);
    const msp = { attempt: "ATT-0001", record: { schema_version: 1, stream: "s", record_type: "event", payload: { kind: "run_usage", input_tokens: 9 } } };
    tlog("muse", "msp", msp); expected.push({ stream: "muse", kind: "msp", data: msp }); await sleep(5);
    append("attempts.jsonl", { id: "ATT-0001", at: new Date().toISOString(), run: null, task: { incident: "INC-0001" } }, paths.ledger);
    live.bus.poll(); await take(1); syncExpected(); await sleep(5);
    append("incidents.jsonl", { t: "status", id: "INC-0001", field: "status", value: "unrepaired", at: new Date().toISOString(), run: null }, paths.ledger);
    live.bus.poll(); await take(1); syncExpected(); await sleep(5);
    append("verdicts.jsonl", { id: "VER-0001", at: new Date().toISOString(), run: null, subject: { kind: "attempt", id: "ATT-0001" }, decision: "REFUSE", checks: [], reason: "r", residue: [], rule_version: "x" }, paths.ledger);
    live.bus.poll(); await take(1); syncExpected();
    client.close();
    const liveFrames = client.msgs.filter((m) => (m.data as { t: string }).t === "frame").length;

    const rep = await listen({ ...paths, replay: { run: "prerun", speed: 1e6 } });
    const rc = sseCollect(rep.base + "/events");
    await rc.until((m) => m.some((x) => x.event === "replay"));
    await post(rep.base, "/api/replay/control", { op: "play" });
    await rc.until((m) => m.some((x) => x.event === "replay" && (x.data as { done: boolean }).done));
    rc.close();
    const got = rc.msgs.filter((m: SseMsg) => (m.event === "message" && (m.data as { t: string }).t !== "frame") || (m.event === "telemetry" && ["llm", "muse"].includes((m.data as { stream: string }).stream)))
      .map((m) => (m.event === "telemetry" ? { stream: (m.data as { stream: string }).stream, kind: (m.data as { kind: string }).kind, data: (m.data as { data: unknown }).data } : m.data));
    assert.deepEqual(got, expected);
    const frames = rc.msgs.filter((m) => (m.data as { t: string }).t === "frame");
    assert.equal(liveFrames, 3);
    assert.equal(frames.length, 1, "three frames inside one second thin to one at TELEMETRY_FRAME_HZ = 1");
    assert.deepEqual(frames[0].data, { t: "frame", source: "core", shades_b64: shades(0), counter: 10 });
    const st = await (await fetch(rep.base + "/api/replay")).json();
    assert.deepEqual(st.markers.map((m: { kind: string; id: string }) => `${m.kind}:${m.id}`), ["incident:INC-0001", "verdict:VER-0001"]);
    assert.equal((await post(rep.base, "/api/input", { counter: 1, mask: 1 })).status, 409);
    const muse = await (await fetch(rep.base + "/api/replay/muse?attempt=ATT-0001")).json();
    assert.deepEqual(muse.map((r: { data: unknown }) => r.data), [msp]);
  } finally {
    delete process.env.RATCHET_TELEMETRY_DIR;
    if (prevRun !== undefined) process.env.RATCHET_RUN = prevRun;
  }
});

test("the replay server serves the same /api/state as the live server over the same ledger", async () => {
  const fx = join(root, "ui", "fixtures");
  const cache = mkdtempSync(join(tmpdir(), "ratchet-cache-"));
  const paths = { ledger: join(fx, "ledger"), runs: join(fx, "runs"), evidence: join(fx, "evidence"), game: join(root, "game"), cache };
  const live = await listen(paths);
  const rep = await listen({ ...paths, replay: { run: "prerun" } });
  const a = await (await fetch(live.base + "/api/state")).json();
  const b = await (await fetch(rep.base + "/api/state")).json();
  assert.ok(a.verdicts.length > 0);
  assert.deepEqual(b, a);
});
