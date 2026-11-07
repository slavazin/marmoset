// Play traces per registered game (lockstep/games.ts, S22). A §6.17 game is played by the explorer
// (player/explore.ts explorerTrace). A mapped game with a start state is played by puzzleTrace: from the start
// state (frame 0 is play), it presses one of left, right or A for PUZZLE_HOLD frames every PUZZLE_GAP_MIN to
// PUZZLE_GAP_MAX frames, chosen by a seeded PRNG, and never START, so the run is not paused. The same seed and
// frame count give the same trace. Truth-maker: lockstep/start-state.test.ts ("puzzleTrace ...").
import type { Trace, TraceInput } from "../src/schema.ts";
import { BTN, explorerTrace, prng } from "../player/explore.ts";
import type { GameEntry } from "../lockstep/games.ts";

/** Frames a puzzleTrace press is held. Mario & Yoshi acts on the press edge (evidence/s22/ram-map.md, menu reads). */
export const PUZZLE_HOLD = 4;
/** Frames between puzzleTrace presses, inclusive bounds. */
export const PUZZLE_GAP_MIN = 8, PUZZLE_GAP_MAX = 30;

export function puzzleTrace(o: { rom_sha: string; frames: number; seed: number }): Trace {
  const rnd = prng(o.seed);
  const inputs: TraceInput[] = [{ from_counter: 0, mask: 0 }];
  const keys = [BTN.left, BTN.right, BTN.a];
  for (let n = PUZZLE_GAP_MIN; n + PUZZLE_HOLD < o.frames; ) {
    inputs.push({ from_counter: n, mask: keys[Math.floor(rnd() * keys.length)] }, { from_counter: n + PUZZLE_HOLD, mask: 0 });
    n += PUZZLE_HOLD + PUZZLE_GAP_MIN + Math.floor(rnd() * (PUZZLE_GAP_MAX - PUZZLE_GAP_MIN + 1));
  }
  return { id: `puzzle-${o.seed}`, rom_sha: o.rom_sha, align: "frame", inputs, counter_end: o.frames, source: "explorer" };
}

/** The play trace for a game: the explorer for a §6.17 game, puzzleTrace for a mapped one. */
export function playTrace(g: GameEntry | null, o: { rom_sha: string; frames: number; seed: number }): Trace {
  if (!g || g.contract === "s6.17") return explorerTrace(o);
  return puzzleTrace(o);
}
