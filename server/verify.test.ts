import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verify, staticGap, parseSince } from "./verify.ts";
import { DISPLAYABLES, type Displayable } from "../src/displayables.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

function sandbox(tel: Record<string, unknown[]>, ledger: Record<string, unknown[]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-verify-"));
  const paths = { ledger: join(dir, "ledger"), runs: join(dir, "runs"), evidence: join(dir, "evidence") };
  mkdirSync(paths.ledger, { recursive: true });
  const td = join(paths.runs, "prerun", "telemetry");
  mkdirSync(td, { recursive: true });
  for (const [s, recs] of Object.entries(tel)) writeFileSync(join(td, `${s}.jsonl`), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  for (const [f, recs] of Object.entries(ledger)) writeFileSync(join(paths.ledger, f), recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { paths, dotEnv: join(dir, ".env") };
}
const rec = (seq: number, stream: string, kind: string, data: unknown, at = "2026-11-07T12:00:00.000Z") => ({ at, seq, pid: 1, run: null, stream, kind, data });
const proc: Displayable = { id: "process", shows: "p", where: "panel", trigger: { always: true }, sources: [{ telemetry: { stream: "process", kind: "start" } }], producers: [{ file: "src/telemetry-process.ts", pattern: String.raw`tlog\("process", "start"` }] };

test("a displayable with no producer is reported as a static gap", async () => {
  const planted: Displayable = { id: "planted", shows: "x", where: "panel", trigger: { always: true }, sources: [{ telemetry: { stream: "ui", kind: "meta" } }], producers: [] };
  const missing: Displayable = { ...planted, id: "missing-file", producers: [{ file: "nowhere/none.ts", pattern: "x" }] };
  const s = sandbox({ process: [rec(0, "process", "start", { name: "server" })] });
  const r = await verify({ ...s, run: "prerun", root, manifest: [proc, planted, missing], replay: false });
  assert.deepEqual(r.rows.map((x) => `${x.id}:${x.status}`), ["process:pass", "planted:gap", "missing-file:gap"]);
  assert.deepEqual(r.gaps.map((g) => `${g.check}:${g.id}`), ["static:planted", "static:missing-file"]);
  assert.equal(staticGap(planted, root), "no producer named");
});

test("an unredacted secret key, a credential-shaped value and a .env value are each reported", async () => {
  const s = sandbox({
    process: [rec(0, "process", "start", {})],
    llm: [rec(1, "llm", "call", { headers: { authorization: "Bearer abc" } })],
    spot: [rec(2, "spot", "answer", { note: "key AIzaSyA1234567890abcdefghijklmnopqrstu" })],
    muse: [rec(3, "muse", "msp", { text: "value-from-dotenv-123" })],
  });
  writeFileSync(s.dotEnv, "GEMINI_KEY=value-from-dotenv-123\nPORT=8787\n");
  const r = await verify({ ...s, run: "prerun", root, manifest: [proc], replay: false });
  const why = r.gaps.map((g) => `${g.id}: ${g.why}`).sort();
  assert.deepEqual(why, ["llm.jsonl: llm.jsonl.headers.authorization is not redacted", "muse.jsonl: muse.jsonl: a .env value appears unredacted", "spot.jsonl: spot.jsonl: a credential-shaped value"]);
});

test("generation-curve and beat-tombstones are due on a policy verdict with trial arms alone", async () => {
  const manifest = DISPLAYABLES.filter((d) => d.id === "generation-curve" || d.id === "beat-tombstones");
  const s = sandbox({ process: [rec(0, "process", "start", {})] }, { "verdicts.jsonl": [{ id: "VER-0001", at: "t", run: null, subject: { kind: "policy", id: "POL-0001" }, decision: "REFUSE",
    checks: [], arms: { candidate: [], baseline: [], placebo: [], margin: {}, n_family_runs_per_arm: 1 }, reason: "r", residue: [], rule_version: "x" }] });
  const r = await verify({ ...s, run: "prerun", root, manifest, replay: false });
  assert.deepEqual(r.rows.map((x) => `${x.id}:${x.status}`), ["generation-curve:pass", "beat-tombstones:pass"]);
});

test("a displayable whose trigger has not happened reads not-yet, never pass", async () => {
  const vr: Displayable = { id: "vread", shows: "v", where: "panel", trigger: { runs: { file: "vread.json" } }, sources: [{ runs: { file: "vread.json" } }], producers: [proc.producers[0]] };
  const inc: Displayable = { id: "feed", shows: "f", where: "panel", trigger: { ledger: { file: "incidents.jsonl" } }, sources: [{ ledger: { file: "incidents.jsonl" } }], producers: [proc.producers[0]] };
  const s = sandbox({ process: [rec(0, "process", "start", {})] });
  const r = await verify({ ...s, run: "prerun", root, manifest: [vr, inc], replay: false });
  assert.deepEqual(r.rows.map((x) => x.status), ["not-yet", "not-yet"]);
  assert.equal(r.covered, 0);
  assert.equal(r.gaps.length, 0);
});

test("seq falling within a pid, an unparseable line, and sparse frames over play are gaps; replay state matches live", async () => {
  const t = (s: number) => new Date(Date.parse("2026-11-07T12:00:00Z") + s * 1000).toISOString();
  const s = sandbox({
    process: [rec(5, "process", "start", {}), rec(4, "process", "stop", {})],
    input: [rec(6, "input", "mask", { counter: 1, mask: 1 }, t(0)), rec(7, "input", "mask", { counter: 600, mask: 0 }, t(60))],
    ui: [rec(8, "ui", "frame", { source: "core", counter: 1, gz_b64: "" }, t(1))],
  }, { "incidents.jsonl": [{ id: "INC-0001", at: t(1), run: null }] });
  writeFileSync(join(s.paths.runs, "prerun", "telemetry", "loop.jsonl"), "{not json\n" + JSON.stringify(rec(9, "loop", "x", {})) + "\n");
  const r = await verify({ ...s, run: "prerun", root, manifest: [proc] });
  const ids = r.gaps.map((g) => g.id).sort();
  assert.deepEqual(ids, ["frames", "loop.jsonl", "process.jsonl"]);
  assert.equal(r.replay, "pass");
  assert.equal(parseSince("5m"), 300_000);
});
