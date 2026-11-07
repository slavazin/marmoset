import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { createServer } from "../../server/index.ts";
import type { TelemetryStream } from "../../src/telemetry.ts";
import { FRAME_MS, FramePacer, MAX_CATCHUP, MIN_HOLD_FRAMES, PLAY_KEYMAP, PlayInput, PlaySession, integerScale, playKeyHandler } from "./session.ts";
import type { PlaySessionBody } from "./session.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = resolve(here, "..", "..");
const fx = join(root, "ui", "fixtures");
const records: { stream: TelemetryStream; kind: string; data: unknown }[] = [];
const { server } = createServer({
  ledger: join(fx, "ledger"), runs: join(fx, "runs"), evidence: join(fx, "evidence"), game: join(root, "game"),
  cache: mkdtempSync(join(tmpdir(), "ratchet-play-")), record: true, log: (stream, kind, data) => { records.push({ stream, kind, data }); },
});
await new Promise<void>((r) => server.listen(0, r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => { server.closeAllConnections(); server.close(); });

/** Every request path the Play seams send, and a poster that awaits them against the real server. */
const requests: string[] = [];
const pending: Promise<unknown>[] = [];
const post = (path: string, body: PlaySessionBody) => {
  requests.push(path);
  pending.push(fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.status));
};

function key(type: "keydown" | "keyup", code: string): Event {
  return Object.assign(new Event(type, { cancelable: true }), { code });
}

/** A window stand-in: the Play handler registered first (ui/present/mount.ts is imported before ui/main.ts's body runs), then the live view's. */
function rig(active: () => boolean) {
  const win = new EventTarget();
  const masks: number[] = [];
  const input = new PlayInput((m) => masks.push(m));
  const onKey = playKeyHandler(input, active);
  win.addEventListener("keydown", onKey as unknown as EventListener, { capture: true });
  win.addEventListener("keyup", onKey as unknown as EventListener, { capture: true });
  const live: string[] = [];
  const liveKey = (e: Event) => { live.push(`${e.type}:${(e as Event & { code: string }).code}`); requests.push("/api/input"); };
  win.addEventListener("keydown", liveKey);
  return { win, masks, input, live, liveKey };
}

test("Play-tab keypresses produce no /api/input request and no input-stream record; the session writes only ui play-session start and stop with a duration", async () => {
  requests.length = 0; records.length = 0;
  let clock = 1000;
  const session = new PlaySession(post, () => clock);
  const { win, masks, live, input } = rig(() => true);
  session.start();
  for (const code of ["Enter", "ArrowRight", "KeyZ", "KeyX", "ShiftLeft", "Backspace", "ArrowUp"]) {
    win.dispatchEvent(key("keydown", code));
    win.dispatchEvent(key("keyup", code));
    for (let f = 0; f < MIN_HOLD_FRAMES; f++) input.frameDone();
  }
  clock += 4321.4;
  session.stop();
  assert.deepEqual(await Promise.all(pending.splice(0)), [200, 200]);
  assert.deepEqual(live, [], "the live view's keydown listener never ran");
  assert.deepEqual(requests, ["/api/play-session", "/api/play-session"]);
  assert.deepEqual(records.filter((r) => r.stream === "input"), []);
  assert.deepEqual(records, [
    { stream: "ui", kind: "play-session", data: { op: "start" } },
    { stream: "ui", kind: "play-session", data: { op: "stop", duration_ms: 4321 } },
  ]);
  assert.deepEqual(masks.slice(0, 2), [1 << PLAY_KEYMAP.Enter, 0], "the key reached the Play core's mask");
  assert.equal(masks.length, 14);
});

test("with the Play tab closed its handler does nothing: a key on the live view reaches the live listener and no Play mask", () => {
  requests.length = 0;
  const { win, masks, live } = rig(() => false);
  win.dispatchEvent(key("keydown", "Enter"));
  assert.deepEqual(live, ["keydown:Enter"]);
  assert.deepEqual(masks, []);
});

test("a key typed into a form field and an unmapped key pass through the Play handler untouched", () => {
  const masks: number[] = [];
  const onKey = playKeyHandler(new PlayInput((m) => masks.push(m)), () => true);
  let stopped = 0;
  const e = (code: string, tagName?: string) => ({ type: "keydown", code, target: { tagName }, preventDefault() {}, stopImmediatePropagation() { stopped++; } });
  onKey(e("KeyZ", "INPUT"));
  onKey(e("KeyQ"));
  assert.deepEqual([masks, stopped], [[], 0]);
});

test("POST /api/play-session refuses a body carrying a mask or any field beyond op and duration_ms, and logs nothing for it", async () => {
  records.length = 0;
  const p = (b: unknown) => fetch(base + "/api/play-session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.status);
  assert.equal(await p({ op: "start", mask: 1 }), 400);
  assert.equal(await p({ op: "stop", duration_ms: 5, counter: 3 }), 400);
  assert.equal(await p({ op: "stop" }), 400);
  assert.equal(await p({ op: "stop", duration_ms: -1 }), 400);
  assert.equal(await p({ op: "play" }), 400);
  assert.equal(await p(null), 400);
  assert.deepEqual(records, []);
});

test("every network call in ui/play/ names the ROM route or /api/play-session, never an experiment route", () => {
  const files = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  assert.deepEqual(files.sort(), ["play.ts", "session.ts"]);
  for (const f of files) {
    const src = readFileSync(join(here, f), "utf8").replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!/\/api\/(input|event|trace)|\/fire\b|sendBeacon|EventSource/.test(src), `${f} names an experiment route`);
    for (const m of src.matchAll(/fetch\(([^,)]+)/g)) assert.ok(["PLAY_ROM_URL", "path"].includes(m[1].trim()), `${f}: fetch(${m[1]})`);
  }
  assert.match(readFileSync(join(here, "play.ts"), "utf8"), /const PLAY_ROM_URL = "\/game\/game\.gb"/);
  assert.match(readFileSync(join(here, "play.ts"), "utf8"), /new PlaySession\(postSession\)/);
});

test("FramePacer owes one frame per FRAME_MS and drops the backlog past MAX_CATCHUP", () => {
  const p = new FramePacer();
  assert.equal(p.due(0), 0);
  assert.equal(p.due(FRAME_MS * 2 + 0.5), 2);
  assert.equal(p.due(FRAME_MS * 2 + 0.5 + 60_000), MAX_CATCHUP);
  assert.equal(p.due(FRAME_MS * 2 + 0.5 + 60_000 + FRAME_MS / 2), 0, "the backlog was dropped");
});

test("integerScale picks the largest whole multiple of 160x144 that fits, and 1 when nothing fits", () => {
  assert.equal(integerScale(343, 500, 160, 144), 2);
  assert.equal(integerScale(900, 600, 160, 144), 4);
  assert.equal(integerScale(100, 100, 160, 144), 1);
});

test("a tap released before MIN_HOLD_FRAMES emulated frames stays down until the hold completes; a longer hold releases at once", () => {
  const masks: number[] = [];
  const input = new PlayInput((m) => masks.push(m));
  input.set(PLAY_KEYMAP.Enter, true);
  input.set(PLAY_KEYMAP.Enter, false);
  assert.equal(input.mask, 1 << PLAY_KEYMAP.Enter, "held through the release");
  for (let f = 1; f < MIN_HOLD_FRAMES; f++) { input.frameDone(); assert.equal(input.mask, 1 << PLAY_KEYMAP.Enter); }
  input.frameDone();
  assert.equal(input.mask, 0);
  input.set(PLAY_KEYMAP.KeyZ, true);
  for (let f = 0; f < MIN_HOLD_FRAMES; f++) input.frameDone();
  input.set(PLAY_KEYMAP.KeyZ, false);
  assert.equal(input.mask, 0);
  input.set(PLAY_KEYMAP.KeyX, true); input.set(PLAY_KEYMAP.KeyX, false); input.set(PLAY_KEYMAP.KeyX, true);
  for (let f = 0; f < MIN_HOLD_FRAMES * 2; f++) input.frameDone();
  assert.equal(input.mask, 1 << PLAY_KEYMAP.KeyX, "a re-press cancels the owed release");
  input.clear();
  assert.deepEqual(masks.at(-1), 0);
});

test("PlaySession posts no second start while open and no stop when closed", () => {
  const sent: PlaySessionBody[] = [];
  const s = new PlaySession((_, b) => sent.push(b), () => 0);
  s.stop(); s.start(); s.start(); s.stop(); s.stop();
  assert.deepEqual(sent, [{ op: "start" }, { op: "stop", duration_ms: 0 }]);
});
