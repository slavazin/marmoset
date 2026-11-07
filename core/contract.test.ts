// The §6.1–§6.3 contract of core/index.ts, read on the bug-surface game (game/game.gb, built by S4).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { GAME_RAM } from "../src/schema.ts";
import type { Core, CreateCore, Handlers } from "../src/schema.ts";
import { createCore as createCoreImpl, HANDLERS as HANDLERS_IMPL } from "./index.ts";

const createCore: CreateCore = createCoreImpl;
const HANDLERS: Handlers = HANDLERS_IMPL;
const ROOT = resolve(import.meta.dirname, "..");
const GAME = resolve(ROOT, "game", "game.gb");
const rom = (): Uint8Array => new Uint8Array(readFileSync(GAME));

/** Frames before the snapshot: past boot and the title's first VBlanks. */
const WARMUP_FRAMES = 120;
/** Frames after the snapshot that both runs must agree on (SPEC §5 S1 Accept). */
const RESUME_FRAMES = 1000;

/** An input schedule keyed by frame index, so the resumed run is fed the same buttons as the straight one. */
const buttonsAt = (f: number): number => ((f >> 6) & 1 ? 0x80 : 0) | ((f >> 4) & 1 ? 0x01 : 0) | ((f >> 5) & 1 ? 0x10 : 0);

function fingerprint(core: Core): string {
  const h = createHash("sha256");
  h.update(core.frame());
  h.update(JSON.stringify({ cpu: core.cpu, cycles: core.cycles, serial: core.serial }));
  h.update(core.snapshot());
  return h.digest("hex");
}

function runFrames(core: Core, from: number, count: number, perFrame?: (f: number) => void): void {
  for (let f = from; f < from + count; f++) {
    core.setButtons(buttonsAt(f));
    core.runFrame();
    perFrame?.(f);
  }
}

test("restore(snapshot()) into a fresh core followed by 1,000 frames equals the straight run's frame, registers, cycles and snapshot", () => {
  const straight = createCore(rom());
  runFrames(straight, 0, WARMUP_FRAMES);
  const snap = straight.snapshot();
  const resumedFrames: string[] = [];
  const straightFrames: string[] = [];
  runFrames(straight, WARMUP_FRAMES, RESUME_FRAMES, () => straightFrames.push(createHash("sha1").update(straight.frame()).digest("hex")));

  const resumed = createCore(rom());
  resumed.restore(snap);
  runFrames(resumed, WARMUP_FRAMES, RESUME_FRAMES, () => resumedFrames.push(createHash("sha1").update(resumed.frame()).digest("hex")));

  assert.deepEqual(resumedFrames, straightFrames);
  assert.equal(fingerprint(resumed), fingerprint(straight));
});

test("HANDLERS holds every handler id the tap emits over 600 frames of the game, each mapped to an existing core/ file", () => {
  const core = createCore(rom());
  const emitted = new Set<string>();
  runFrames(core, 0, 600, () => { for (const [id, n] of Object.entries(core.tap.handlerHits())) if (n > 0) emitted.add(id); });
  assert.ok(emitted.size > 0, "the tap emitted no handler id");
  const missing = [...emitted].filter((id) => !(id in HANDLERS));
  assert.deepEqual(missing, []);
  for (const [id, file] of Object.entries(HANDLERS)) {
    assert.match(file, /^core\//, `${id} → ${file}`);
    assert.ok(existsSync(resolve(ROOT, file)), `${id} → ${file} does not exist`);
  }
});

test("handlerHits resets on read: a second read with no step between returns no positive count", () => {
  const core = createCore(rom());
  core.runFrame();
  core.tap.handlerHits();
  assert.deepEqual(Object.values(core.tap.handlerHits()).filter((n) => n > 0), []);
});

test("runToCounter(n) stops with the game's LE16 counter at 0xC0F0 equal to n, and returns false on a stalled counter", () => {
  const core = createCore(rom());
  assert.equal(core.runToCounter(200), true);
  assert.equal(core.read(GAME_RAM.counter) | (core.read(GAME_RAM.counter + 1) << 8), 200);
  // The lives byte holds still on the title with no buttons pressed, so the run stalls and returns false.
  assert.equal(core.runToCounter(0x1234, GAME_RAM.lives), false);
});

test("runFrame ends at LY 144 and advances 70,224 T-cycles per frame on a running LCD", () => {
  const core = createCore(rom());
  core.runToCounter(60);
  core.runFrame();
  const c0 = core.cycles;
  core.runFrame();
  assert.equal(core.tap.ppu().ly, 144);
  const dt = core.cycles - c0;
  assert.ok(Math.abs(dt - 70_224) <= 24, `frame took ${dt} T-cycles`);
  assert.equal(core.frame().length, 160 * 144);
});
