// geminiPlay: the player (SPEC §2.1) driving game.gb on the oracle. Every `stride` game frames it sends
// Gemini the frame PNG, the §6.17 scene and hero position and the last intent toward a directed goal, and
// receives a PlayerAction (§6.11) whose mask it holds for `frames` frames. It writes a counter-aligned trace
// (§6.5, source "gemini") and an intent feed, one JSON line per decision, and posts each decision to the
// server as a `player` UiEvent (§6.18). It never judges a frame. Truth-maker for the action check:
// player/player.test.ts.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PlayerAction, Trace, TraceInput } from "../src/schema.ts";
import { GAME_RAM } from "../src/schema.ts";
import { OracleClient, ratchetCache, sha256 } from "../oracle/client.ts";
import { readFileSync } from "node:fs";
import { askJson, PLAYER_MODEL } from "./gemini.ts";
import { CONTRACT_LEN, decodeState, shadesToPng, type GameState } from "./game.ts";

/** Game frames between decisions (SPEC §5 S7). */
export const STRIDE = 15;
/** S7 Wiggle: a decision slower than this many milliseconds widens the stride to STRIDE_SLOW. */
export const SLOW_MS = 3000;
export const STRIDE_SLOW = 30;
/** The directed goal Gemini plays toward unless --goal names another. */
export const DEFAULT_GOAL = "reach the water band: fall through a gap in the ground into the dark lake at the bottom of the screen";

export const ACTION_SCHEMA = {
  type: "object",
  properties: {
    mask: { type: "integer", description: "buttons held, bit0 right, bit1 left, bit2 up, bit3 down, bit4 A (jump), bit5 B, bit6 select, bit7 start; 1 = pressed" },
    frames: { type: "integer", description: "game frames to hold the mask, 1 to 30" },
    intent: { type: "string", description: "one short sentence: what this press is for" },
  },
  required: ["mask", "frames", "intent"],
};

/** Accepts a parsed reply as a PlayerAction or throws, so askJson retries. */
export function checkAction(v: unknown): PlayerAction {
  const a = v as Partial<PlayerAction>;
  if (!Number.isInteger(a?.mask) || a.mask! < 0 || a.mask! > 255) throw new Error("mask");
  if (!Number.isInteger(a.frames) || a.frames! < 1) throw new Error("frames");
  if (typeof a.intent !== "string" || !a.intent.trim()) throw new Error("intent");
  return { mask: a.mask!, frames: Math.min(a.frames!, STRIDE_SLOW), intent: a.intent.trim().slice(0, 160) };
}

export function prompt(goal: string, s: GameState, lastIntent: string, stride: number): string {
  return [
    "You play Fernwake, a Game Boy platformer. The image is the current 160x144 screen.",
    `Goal: ${goal}.`,
    `Scene ${s.scene} (0 is the title screen, where START begins level 1; 1-3 are levels). Hero x ${s.heroX} world px, hero y ${s.heroY} screen px, lives ${s.lives}, frame ${s.counter}.`,
    "The d-pad walks; A jumps (a jump needs A released and pressed again); START starts from the title.",
    `Your last intent: ${lastIntent}`,
    `You decide again in ${stride} frames. Reply with JSON {"mask": int, "frames": int, "intent": string}.`,
  ].join("\n");
}

async function postEvent(e: unknown): Promise<void> {
  const base = process.env.RATCHET_SERVER ?? "http://localhost:8787";
  try {
    await fetch(`${base}/api/event`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(e), signal: AbortSignal.timeout(500) });
  } catch { /* the server is optional for play */ }
}

export interface PlayResult { trace: Trace; tracePath: string; intentsPath: string; decisions: number; strides: number[]; models: string[] }

export async function geminiPlay(o: { romPath: string; frames: number; goal?: string; run?: string | null; log?: (s: string) => void }): Promise<PlayResult> {
  const rom_sha = sha256(readFileSync(o.romPath));
  const dir = join(ratchetCache(), "traces");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const intentsPath = join(dir, `gemini-${stamp}.intents.jsonl`);
  const inputs: TraceInput[] = [{ from_counter: 0, mask: 0 }];
  const put = (from_counter: number, mask: number) => {
    const last = inputs.at(-1)!;
    if (last.mask === mask) return;
    if (last.from_counter === from_counter) last.mask = mask;
    else inputs.push({ from_counter, mask });
  };
  let stride = STRIDE;
  let lastIntent = "none yet";
  const strides: number[] = [];
  const models = new Set<string>();
  let decisions = 0;
  const oracle = OracleClient.spawn();
  try {
    await oracle.load(o.romPath, "counter");
    for (let n = 1; n < o.frames; ) {
      const r = await oracle.runToCounter(n, inputs);
      if (r.stalled) throw new Error(`oracle stalled at counter ${r.counter} before ${n}`);
      const shades = await oracle.frame();
      const s = decodeState(await oracle.ram(GAME_RAM.counter, CONTRACT_LEN));
      void postEvent({ t: "frame", source: "oracle", shades_b64: Buffer.from(shades).toString("base64"), counter: n });
      const ask = await askJson({
        model: PLAYER_MODEL, thinking: "low", role: "player", run: o.run, schema: ACTION_SCHEMA, check: checkAction,
        parts: [{ type: "text", text: prompt(o.goal ?? DEFAULT_GOAL, s, lastIntent, stride) }, { type: "image", mime_type: "image/png", data: shadesToPng(shades).toString("base64") }],
      });
      models.add(ask.model);
      const a = ask.value;
      const hold = Math.min(a.frames, stride);
      put(n, a.mask);
      if (hold < stride) put(n + hold, 0);
      lastIntent = a.intent;
      decisions++;
      strides.push(stride);
      const line = { counter: n, scene: s.scene, hero_x: s.heroX, hero_y: s.heroY, mask: a.mask, frames: a.frames, intent: a.intent, model: ask.model, ms: Math.round(ask.ms), stride };
      appendFileSync(intentsPath, JSON.stringify(line) + "\n");
      void postEvent({ t: "player", intent: a.intent, mask: a.mask });
      o.log?.(JSON.stringify(line));
      n += stride;
      if (ask.ms > SLOW_MS) stride = STRIDE_SLOW;
    }
  } finally {
    await oracle.close();
  }
  const body = { rom_sha, align: "counter" as const, inputs: inputs.filter((i) => i.from_counter < o.frames) };
  const id = sha256(JSON.stringify(body));
  const trace: Trace = { id: `gemini-${id.slice(0, 12)}`, ...body, counter_end: o.frames, source: "gemini" };
  const tracePath = join(dir, `${id}.json`);
  writeFileSync(tracePath, JSON.stringify(trace) + "\n");
  return { trace, tracePath, intentsPath, decisions, strides, models: [...models] };
}
