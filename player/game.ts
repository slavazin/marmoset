// Game-side helpers the player lane shares: the SPEC §6.17 RAM contract decoded from WRAM bytes, a shade
// frame encoded as PNG for Gemini, and effectsRun, which replays a trace on the oracle and names the game
// effects (game/src/main.c header, effects 1–7) the run reached. Truth-maker: player/player.test.ts.
import { PNG } from "pngjs";
import type { Trace } from "../src/schema.ts";
import { GAME_RAM } from "../src/schema.ts";
import { OracleClient } from "../oracle/client.ts";

export interface GameState { counter: number; scene: number; heroX: number; heroY: number; lives: number }

/** Contract bytes 0xC0F0…0xC0F6, read as one oracle `ram` request. */
export const CONTRACT_LEN = GAME_RAM.lives - GAME_RAM.counter + 1;

export function decodeState(b: Uint8Array): GameState {
  const o = (a: number) => a - GAME_RAM.counter;
  return {
    counter: b[o(GAME_RAM.counter)] | (b[o(GAME_RAM.counter) + 1] << 8),
    scene: b[o(GAME_RAM.scene)],
    heroX: b[o(GAME_RAM.heroX)] | (b[o(GAME_RAM.heroX) + 1] << 8),
    heroY: b[o(GAME_RAM.heroY)],
    lives: b[o(GAME_RAM.lives)],
  };
}

/** DMG greens per shade 0..3 (0 = white), the palette a viewer sees. */
const RGB = [0xe0f8d0, 0x88c070, 0x346856, 0x081820];

export function shadesToPng(shades: Uint8Array, width = 160, height = 144): Buffer {
  const p = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const c = RGB[shades[i] & 3];
    p.data[i * 4] = c >> 16; p.data[i * 4 + 1] = (c >> 8) & 255; p.data[i * 4 + 2] = c & 255; p.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(p);
}

export interface EffectsReport {
  frames_by_scene: Record<string, number>;
  levels_entered: number[];
  lives_lost: number;
  hero_x_max_by_scene: Record<string, number>;
  effects: string[];
}

/** The game's effects by number (game/src/main.c header). 1–5 and 7 run on every level frame; 6 on level entry. */
export const LEVEL_FRAME_EFFECTS = ["1 window HUD split", "2 parallax SCX bands", "3 water band BGP swap", "4 12-sprite firefly row", "5 OAM DMA", "7 water SCX wobble"];

export async function effectsRun(romPath: string, trace: Pick<Trace, "align" | "inputs" | "counter_end">): Promise<EffectsReport> {
  const oracle = OracleClient.spawn();
  const rep: EffectsReport = { frames_by_scene: {}, levels_entered: [], lives_lost: 0, hero_x_max_by_scene: {}, effects: [] };
  try {
    await oracle.load(romPath, trace.align);
    let prev: GameState | null = null;
    for (let n = 1; n <= trace.counter_end; n++) {
      const r = await oracle.runToCounter(n, trace.inputs);
      if (r.stalled) break;
      const s = decodeState(await oracle.ram(GAME_RAM.counter, CONTRACT_LEN));
      const k = String(s.scene);
      rep.frames_by_scene[k] = (rep.frames_by_scene[k] ?? 0) + 1;
      rep.hero_x_max_by_scene[k] = Math.max(rep.hero_x_max_by_scene[k] ?? 0, s.heroX);
      if (s.scene > 0 && prev?.scene !== s.scene) rep.levels_entered.push(s.scene);
      if (prev && prev.scene > 0 && s.scene === prev.scene && s.lives < prev.lives) rep.lives_lost++;
      prev = s;
    }
  } finally {
    await oracle.close();
  }
  if (rep.frames_by_scene["0"]) rep.effects.push("title auto-pan");
  if (Object.keys(rep.frames_by_scene).some((k) => k !== "0")) rep.effects.push(...LEVEL_FRAME_EFFECTS);
  if (rep.levels_entered.length) rep.effects.push(`6 ROM bank switch (levels ${[...new Set(rep.levels_entered)].join(", ")})`);
  return rep;
}
