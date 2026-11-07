import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { maskAt } from "../lockstep/diff.ts";
import { BTN, START_AT, explorerTrace } from "./explore.ts";
import { decodeState } from "./game.ts";
import { parseJsonObject } from "./gemini.ts";
import { appendNarration, appendSpend } from "./ledger-append.ts";
import { explorerTrace as et } from "./explore.ts";
import { checkSentence } from "./narrate.ts";
import { checkAction } from "./play.ts";

test("explorerTrace gives the same inputs for the same seed and different inputs for another seed", () => {
  const a = explorerTrace({ rom_sha: "x", frames: 3000, seed: 7 });
  const b = explorerTrace({ rom_sha: "x", frames: 3000, seed: 7 });
  const c = explorerTrace({ rom_sha: "x", frames: 3000, seed: 8 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a.inputs, c.inputs);
  assert.equal(a.align, "counter");
  assert.equal(a.source, "explorer");
  assert.equal(a.counter_end, 3000);
});

test("explorerTrace presses START at START_AT, then walks right, and its inputs ascend below counter_end", () => {
  const t = explorerTrace({ rom_sha: "x", frames: 2000, seed: 1 });
  assert.equal(maskAt(t.inputs, START_AT), BTN.start);
  assert.equal(maskAt(t.inputs, START_AT - 1), 0);
  for (let i = 1; i < t.inputs.length; i++) assert.ok(t.inputs[i].from_counter > t.inputs[i - 1].from_counter);
  assert.ok(t.inputs.every((i) => i.from_counter < 2000));
  const right = t.inputs.filter((i) => i.mask & BTN.right).length;
  const jumps = t.inputs.filter((i) => i.mask & BTN.a).length;
  assert.ok(right > t.inputs.length / 3, `right presses ${right} of ${t.inputs.length}`);
  assert.ok(jumps > 5, `jumps ${jumps}`);
});

test("decodeState reads counter, scene, hero x, hero y and lives at the §6.17 offsets, little-endian", () => {
  assert.deepEqual(decodeState(Uint8Array.of(0x34, 0x12, 2, 0x10, 0x01, 96, 3)), { counter: 0x1234, scene: 2, heroX: 0x110, heroY: 96, lives: 3 });
});

test("checkAction accepts a well-formed PlayerAction, clamps frames to 30, and refuses a bad mask or empty intent", () => {
  assert.deepEqual(checkAction({ mask: 17, frames: 99, intent: " jump the gap " }), { mask: 17, frames: 30, intent: "jump the gap" });
  assert.throws(() => checkAction({ mask: 256, frames: 5, intent: "x" }));
  assert.throws(() => checkAction({ mask: 1, frames: 0, intent: "x" }));
  assert.throws(() => checkAction({ mask: 1, frames: 5, intent: "" }));
});

test("parseJsonObject reads a JSON object out of fenced or prose-wrapped text and throws on none", () => {
  assert.deepEqual(parseJsonObject('```json\n{"mask":1}\n```'), { mask: 1 });
  assert.deepEqual(parseJsonObject('Sure: {"a":{"b":2}} done'), { a: { b: 2 } });
  assert.throws(() => parseJsonObject("no json"));
});

test("checkSentence accepts one sentence and refuses two sentences or an empty one", () => {
  assert.equal(checkSentence({ sentence: "  The water band is  light instead of dark. " }), "The water band is light instead of dark.");
  assert.throws(() => checkSentence({ sentence: "One. Two." }));
  assert.throws(() => checkSentence({ sentence: "" }));
});

test("explorerTrace emits exactly the trace's mask changes, each with a scripted intent", () => {
  const seen: Array<{ counter: number; mask: number; intent: string }> = [];
  const t = et({ rom_sha: "x", frames: 1500, seed: 3, emit: (p) => seen.push(p) });
  assert.deepEqual(seen.map((p) => ({ from_counter: p.counter, mask: p.mask })), t.inputs);
  assert.equal(seen.find((p) => p.mask === BTN.start)?.intent, "start");
  assert.ok(seen.every((p) => ["idle", "start", "jump", "random press", "walk left", "walk right"].includes(p.intent)));
});

test("appendSpend and appendNarration append one parseable line each through loop/ledger.ts", () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-player-"));
  const spend = join(dir, "spend.jsonl"), inc = join(dir, "incidents.jsonl");
  appendSpend({ at: "2026-11-07T00:00:00Z", run: null, role: "player", model: "gemini-3.8-flash", tokens_in: 10, tokens_out: 5, usd: 0 }, dir);
  appendSpend({ at: "2026-11-07T00:00:01Z", run: null, role: "narrator", model: "gemini-4-argon", tokens_in: 1, tokens_out: 1, usd: 0 }, dir);
  const lines = readFileSync(spend, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.role), ["player", "narrator"]);
  const rec = appendNarration("INC-0001", "The fireflies flicker.", dir);
  assert.deepEqual(JSON.parse(readFileSync(inc, "utf8")), rec);
  assert.equal(rec.t, "status");
  assert.equal(rec.field, "narration");
});
