import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { packFrame, unpackFrame } from "./compact.ts";
import type { FrameEvent } from "./compact.ts";
import { testPattern, LCD_W, LCD_H } from "../ui/fixtures/core.ts";
import { TELEMETRY_FRAME_HZ } from "../src/telemetry.ts";

/** Bytes a run's telemetry may reach over RUN_MINUTES of play to stay committable (owner directive 2026-11-07). */
const RUN_BUDGET_BYTES = 50e6;
const RUN_MINUTES = 75;
/** Frame sources recorded per second of play: the core and the oracle. */
const SOURCES = 2;

let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 16) / 65536;
function frames(kind: "pattern" | "tiles" | "noise", n: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  const tiles = Array.from({ length: 48 }, () => Uint8Array.from({ length: 64 }, () => Math.floor(rnd() * 4)));
  for (let k = 0; k < n; k++) {
    const fb = new Uint8Array(LCD_W * LCD_H);
    if (kind === "pattern") testPattern(fb, k * 60, (k * 5) % 144, (k * 3) % 128);
    else if (kind === "noise") for (let i = 0; i < fb.length; i++) fb[i] = Math.floor(rnd() * 4);
    else for (let ty = 0; ty < 18; ty++) for (let tx = 0; tx < 20; tx++) { const t = tiles[Math.floor(rnd() * (ty < 2 ? 4 : 48))]; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) fb[(ty * 8 + y) * LCD_W + tx * 8 + x] = t[y * 8 + x]; }
    out.push(fb);
  }
  return out;
}
const ev = (fb: Uint8Array, counter: number): FrameEvent => ({ t: "frame", source: "core", shades_b64: Buffer.from(fb).toString("base64"), counter });
/** One recorded frame line as tlog writes it, envelope included. */
const line = (fb: Uint8Array) => JSON.stringify({ at: "2026-11-07T12:00:00.000Z", seq: 123456, pid: 54321, run: "RUN-0001", stream: "ui", kind: "frame", data: { origin: "producer", ...packFrame(ev(fb, 1234)) } }).length + 1;

test("a packed frame unpacks to the identical UiEvent", () => {
  const [fb] = frames("tiles", 1);
  assert.deepEqual(unpackFrame(packFrame(ev(fb, 9))), ev(fb, 9));
});

/** game.gb frames the oracle rendered (S3 playback cache, 23,040-byte shade arrays keyed by counter); absent on a fresh clone. */
function gameFrames(): Uint8Array[] {
  const base = join(process.env.RATCHET_CACHE ?? join(homedir(), ".cache", "ratchet"), "playback");
  if (!existsSync(base)) return [];
  for (const rom of readdirSync(base)) {
    const d = join(base, rom);
    const bins = readdirSync(d).filter((f) => f.endsWith(".bin")).map((f) => readFileSync(join(d, f))).filter((b) => b.length === LCD_W * LCD_H);
    if (bins.length >= 30) return bins.map((b) => new Uint8Array(b));
  }
  return [];
}
const perMin = (fs: Uint8Array[]) => Math.round((fs.reduce((s, f) => s + line(f), 0) / fs.length) * TELEMETRY_FRAME_HZ * 60 * SOURCES);

test("game.gb frames at TELEMETRY_FRAME_HZ from two sources keep a 75-minute run under 50 MB", (t) => {
  const game = gameFrames();
  const pattern = perMin(frames("pattern", 30));
  const stress = perMin(frames("tiles", 30)); // 360 tiles drawn at random from 48 random tiles: a busier screen than game.gb draws
  const raw = Math.round((Math.ceil((LCD_W * LCD_H) / 3) * 4 + 200) * TELEMETRY_FRAME_HZ * 60 * SOURCES);
  const g = game.length ? perMin(game) : NaN;
  console.log(`FRAME_BYTES_PER_MIN game.gb=${g} (${game.length} oracle frames) fixture_pattern=${pattern} random_tiles=${stress} uncompressed_b64=${raw} at ${TELEMETRY_FRAME_HZ} Hz × ${SOURCES} sources; ${RUN_MINUTES} min game.gb=${(g * RUN_MINUTES / 1e6).toFixed(1)} MB random_tiles=${(stress * RUN_MINUTES / 1e6).toFixed(1)} MB`);
  if (!game.length) return t.skip("no oracle playback cache: run the S3 oracle on game.gb first");
  assert.ok(g * RUN_MINUTES < RUN_BUDGET_BYTES);
});
