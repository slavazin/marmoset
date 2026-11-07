// explorerTrace: the explorer (SPEC §2.1), a scripted player that writes a counter-aligned Trace (§6.5) for
// `frames` game frames from a seed alone: it presses START on the title, walks right, jumps at intervals and
// makes random presses. It reads no frame, so it runs faster than real time and the same seed and frame count
// give the same trace. Truth-maker: player/player.test.ts.
import type { Trace, TraceInput } from "../src/schema.ts";

export const BTN = { right: 1, left: 2, up: 4, down: 8, a: 16, b: 32, select: 64, start: 128 } as const;

/** Counter at which the explorer first presses START: the title must have drawn (game/src/main.c update_title). */
export const START_AT = 30;
/** Frames START is held; update_title acts on the press edge. */
export const START_HOLD = 4;
/** Frames between explorer decisions (one TraceInput at most per segment). */
export const SEGMENT = 12;
/** Per-segment probabilities: jump, a random press, a short left walk; otherwise walk right. */
export const P_JUMP = 0.3, P_RANDOM = 0.1, P_LEFT = 0.08;
/** Frames between explorer presses of START, so a game over returns to play within this many frames; update_level ignores START (game/src/main.c). */
export const START_EVERY = 120;

/** mulberry32: a deterministic 32-bit PRNG on [0, 1). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One mask change the explorer emits, with the scripted move it belongs to. */
export interface ExplorerPress { counter: number; mask: number; intent: string }

/** `emit`, when given, receives every mask change that enters the trace, in counter order. */
export function explorerTrace(o: { rom_sha: string; frames: number; seed: number; emit?: (p: ExplorerPress) => void }): Trace {
  const rnd = prng(o.seed);
  const inputs: TraceInput[] = [];
  const intents = new Map<TraceInput, string>();
  let intent = "idle";
  const put = (from_counter: number, mask: number) => {
    const last = inputs.at(-1);
    if (last && last.mask === mask) return;
    if (last && last.from_counter === from_counter) { last.mask = mask; intents.set(last, intent); }
    else { const e = { from_counter, mask }; inputs.push(e); intents.set(e, intent); }
  };
  put(0, 0);
  for (let n = START_AT; n < o.frames; n += SEGMENT) {
    if ((n - START_AT) % START_EVERY < SEGMENT) {
      intent = "start";
      put(n, BTN.start);
      put(n + START_HOLD, 0);
      continue;
    }
    const r = rnd();
    intent = r < P_JUMP ? "jump" : r < P_JUMP + P_RANDOM ? "random press" : r < P_JUMP + P_RANDOM + P_LEFT ? "walk left" : "walk right";
    if (r < P_JUMP) {
      // Release A first so each jump is a fresh press edge (update_level jumps on the A edge).
      put(n, BTN.right);
      put(n + 2, BTN.right | BTN.a);
    } else if (r < P_JUMP + P_RANDOM) {
      put(n, 1 << Math.floor(rnd() * 6)); // right, left, up, down, A, B; never START or SELECT
    } else if (r < P_JUMP + P_RANDOM + P_LEFT) {
      put(n, BTN.left);
    } else {
      put(n, BTN.right);
    }
  }
  const kept = inputs.filter((i) => i.from_counter < o.frames);
  if (o.emit) for (const i of kept) o.emit({ counter: i.from_counter, mask: i.mask, intent: intents.get(i) ?? "idle" });
  return { id: `explorer-${o.seed}-${o.frames}`, rom_sha: o.rom_sha, align: "counter", inputs: kept, counter_end: o.frames, source: "explorer" };
}
