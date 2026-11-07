// Play traces per registered game (lockstep/games.ts, S22). A §6.17 game is played by the explorer
// (player/explore.ts explorerTrace). A mapped game is played by puzzleTrace from its start state. When the start
// leaves the game at its title (`start.at` "title"), puzzleTrace first presses START at TITLE_START_AT (title to
// menu) and at MENU_START_AT (menu to play, level 1 low speed: evidence/s22/ram-map.md), each for START_HOLD frames.
// From PLAY_FROM (from PUZZLE_GAP_MIN for a start at play) it presses one of left, right or A for PUZZLE_HOLD frames
// every PUZZLE_GAP_MIN to PUZZLE_GAP_MAX frames, chosen by a seeded PRNG, and never START, so play is not paused.
// The same seed, frame count and start give the same trace. Truth-maker: lockstep/start-state.test.ts ("puzzleTrace ...").
import type { Trace, TraceInput } from "../src/schema.ts";
import { BTN, explorerTrace, prng } from "../player/explore.ts";
import type { GameEntry } from "../lockstep/games.ts";

/** Frames a puzzleTrace press is held. Mario & Yoshi acts on the press edge (evidence/s22/ram-map.md, menu reads). */
export const PUZZLE_HOLD = 4;
/** Frames between puzzleTrace presses, inclusive bounds. */
export const PUZZLE_GAP_MIN = 8, PUZZLE_GAP_MAX = 30;
/** From a title start: the START presses (frame index from the start state) and how long each is held. */
export const TITLE_START_AT = 20, MENU_START_AT = 90, START_HOLD = 6;
/** From a title start: the first puzzle press. Play begins 8 frames after the menu START and is drawn 13 after it (ram-map.md, trace C). */
export const PLAY_FROM = 120;

export function puzzleTrace(o: { rom_sha: string; frames: number; seed: number; fromTitle?: boolean }): Trace {
  const rnd = prng(o.seed);
  const inputs: TraceInput[] = [{ from_counter: 0, mask: 0 }];
  if (o.fromTitle) {
    for (const at of [TITLE_START_AT, MENU_START_AT]) inputs.push({ from_counter: at, mask: BTN.start }, { from_counter: at + START_HOLD, mask: 0 });
  }
  const keys = [BTN.left, BTN.right, BTN.a];
  for (let n = o.fromTitle ? PLAY_FROM : PUZZLE_GAP_MIN; n + PUZZLE_HOLD < o.frames; ) {
    inputs.push({ from_counter: n, mask: keys[Math.floor(rnd() * keys.length)] }, { from_counter: n + PUZZLE_HOLD, mask: 0 });
    n += PUZZLE_HOLD + PUZZLE_GAP_MIN + Math.floor(rnd() * (PUZZLE_GAP_MAX - PUZZLE_GAP_MIN + 1));
  }
  return { id: `puzzle-${o.seed}`, rom_sha: o.rom_sha, align: "frame", inputs, counter_end: o.frames, source: "explorer" };
}

/** The play trace for a game: the explorer for a §6.17 game, puzzleTrace (from the title when its start is there) for a mapped one. */
export function playTrace(g: GameEntry | null, o: { rom_sha: string; frames: number; seed: number }): Trace {
  if (!g || g.contract === "s6.17") return explorerTrace(o);
  return puzzleTrace({ ...o, fromTitle: g.start?.at === "title" });
}
