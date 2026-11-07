import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createServer } from "./index.ts";
import { listRuns, runOverview, selectedRun, selectedMode, DEFAULT_RUN } from "./runs.ts";
import { loadTimeline } from "./replay.ts";
import { makeRunsFixture } from "../ui/fixtures/make-runs.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dir = mkdtempSync(join(tmpdir(), "ratchet-runs-"));
const fx = makeRunsFixture(dir);
const evidence = join(root, "ui", "fixtures", "evidence");
const base = { ledger: fx.ledger, evidence, runs: fx.runs, games: join(root, "games.json") };
const mtimes = () => [fx.ledger, join(fx.runs, "RUN-0004", "ledger")].flatMap((d) => readdirSync(d).map((f) => `${d}/${f}:${statSync(join(d, f)).mtimeMs}`));
const before = mtimes();

const { server } = createServer({ ledger: fx.ledger, runs: fx.runs, evidence, game: join(root, "game"), cache: mkdtempSync(join(tmpdir(), "ratchet-cache-")) });
await new Promise<void>((r) => server.listen(0, r));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => { server.closeAllConnections(); server.close(); });

test("run names come from games.json, the tier, the repairer and runs/labels.json; the description quotes the stop record", () => {
  const runs = listRuns(base);
  assert.deepEqual(runs.map((r) => r.id), ["RUN-0001", "RUN-0004"]);
  const [r1, r4] = runs;
  assert.equal(r1.name, "Fernwake · DMG · Muse");
  assert.equal(r4.game, "mario-yoshi-eu", "game id by conditions.json rom_sha against games.json");
  assert.equal(r4.name, "Mario & Yoshi · DMG · Muse");
  assert.ok(r4.description.includes("stopped 2026-11-07T12:30:00Z: spend stop: $79.14 (priced) ≥ $80 (2 attempts)"));
  assert.ok(r4.description.startsWith("owner's ROM"));
  assert.equal(r1.paths.ledger, fx.ledger, "RUN-0001 reads the shared ledger");
  assert.equal(r4.paths.ledger, join(fx.runs, "RUN-0004", "ledger"));
  assert.equal(r4.paths.evidence, join(fx.runs, "RUN-0004", "evidence"));
});

test("a conditions.json repairer runner names the repairer family; a CGB live branch names the tier", () => {
  const r = join(fx.runs, "RUN-0009");
  mkdirSync(r, { recursive: true });
  writeFileSync(join(r, "manifest.json"), JSON.stringify({ models: { repairer: "claude-sonnet-5" } }));
  writeFileSync(join(r, "conditions.json"), JSON.stringify({ rom_sha: "c8444ff9a470e23e3b17de184d992e15c2f80b6f46004714d37b9ea39d2408f3", live_branch: "core-cgb", repairer: { runner: "claude", model: "claude-sonnet-5" } }));
  const e = listRuns(base).find((x) => x.id === "RUN-0009")!;
  assert.equal(e.name, "Fernwake · CGB · Claude");
  assert.equal(e.description.includes("no stop record"), true);
});

test("run id: ?run= beats the cookie, the fallback stands without either, and an ill-formed id is refused", () => {
  assert.equal(selectedRun(new URL("http://x/?run=RUN-0004"), "ratchet_run=RUN-0002"), "RUN-0004");
  assert.equal(selectedRun(new URL("http://x/"), "a=1; ratchet_run=RUN-0002"), "RUN-0002");
  assert.equal(selectedRun(new URL("http://x/"), undefined), DEFAULT_RUN);
  for (const bad of ["../x", "RUN-1", "run-0001", "RUN-0001/.."]) assert.throws(() => selectedRun(new URL(`http://x/?run=${encodeURIComponent(bad)}`), undefined));
  assert.equal(selectedMode(new URL("http://x/?mode=replay"), undefined), "replay");
  assert.equal(selectedMode(new URL("http://x/"), "ratchet_mode=replay"), "replay");
  assert.equal(selectedMode(new URL("http://x/?mode=bogus"), undefined), "live");
});

test("overview: per-run attempts, graduations and refusals by first failing check are read from that run's ledger", async () => {
  const [r1, r4] = listRuns(base);
  const o1 = await runOverview(r1), o4 = await runOverview(r4);
  assert.equal(o1.attempts, 2);
  assert.equal(o1.graduated, 1);
  assert.equal(o4.attempts, 1);
  assert.equal(o4.refused, 1);
  assert.deepEqual(o4.refused_by_check, { "H-no-regress": 1 });
  assert.equal(o4.vread_state, "not read");
});

test("the server serves the selected run: /api/state, /api/history and /evidence differ by ?run= or cookie", async () => {
  const list = await (await fetch(`${url}/api/runs`)).json();
  assert.equal(list.default, "RUN-0001");
  assert.deepEqual(list.runs.map((r: { name: string }) => r.name).slice(0, 2), ["Fernwake · DMG · Muse", "Mario & Yoshi · DMG · Muse"]);
  const s1 = await (await fetch(`${url}/api/state`)).json();
  const s4 = await (await fetch(`${url}/api/state?run=RUN-0004`)).json();
  const s4c = await (await fetch(`${url}/api/state`, { headers: { cookie: "ratchet_run=RUN-0004" } })).json();
  assert.equal(s1.attempts.length, 2);
  assert.equal(s4.attempts.length, 1);
  assert.deepEqual(s4c.attempts.map((a: { id: string }) => a.id), s4.attempts.map((a: { id: string }) => a.id));
  const h4 = await (await fetch(`${url}/api/history?run=RUN-0004`)).json();
  assert.equal(h4.selected, "RUN-0004");
  assert.equal(h4.attempts.length, 1);
  assert.equal(h4.runs.length >= 2, true);
  assert.equal((await fetch(`${url}/evidence/incidents/INC-0001/oracle.png?run=RUN-0004`)).status, 200);
  assert.equal((await fetch(`${url}/api/state?run=RUN-0003`)).status, 404, "a run with no directory is refused");
  assert.equal((await fetch(`${url}/api/state?run=..%2Fledger`)).status, 400);
});

test("a run other than the server's own is read-only: every POST but replay control is refused and no ledger file changes", async () => {
  for (const p of ["/fire", "/api/input", "/api/event", "/api/trace/reset"]) {
    const r = await fetch(`${url}${p}?run=RUN-0004`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 409, p);
  }
  assert.deepEqual(mtimes(), before);
});

test("replay mode per run: /api/replay?run=&mode=replay plays that run's telemetry with stop, pause and attempt markers", async () => {
  const st = await (await fetch(`${url}/api/replay?run=RUN-0001&mode=replay`)).json();
  assert.equal(st.run, "RUN-0001");
  const kinds = new Set(st.markers.map((m: { kind: string }) => m.kind));
  for (const k of ["incident", "attempt", "verdict", "pause", "stop", "open"]) assert.ok(kinds.has(k), k);
  const st4 = await (await fetch(`${url}/api/replay`, { headers: { cookie: "ratchet_run=RUN-0004; ratchet_mode=replay" } })).json();
  assert.equal(st4.run, "RUN-0004");
  assert.ok(st4.markers.some((m: { kind: string; label: string }) => m.kind === "stop" && m.label.includes("$79.14")));
  assert.equal((await fetch(`${url}/api/replay?run=RUN-0004`)).status, 404, "live mode serves no replay status");
  const seek = await fetch(`${url}/api/replay/control?run=RUN-0004&mode=replay`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "seek", value: st4.t0 }) });
  assert.equal(seek.status, 200);
  const tl = loadTimeline({ ledger: join(fx.runs, "RUN-0004", "ledger"), runs: fx.runs, evidence }, "RUN-0004");
  assert.ok(tl.records.length > 0, "the timeline reads runs/RUN-0004/telemetry");
});
