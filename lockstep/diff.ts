// Frame and game-state comparison for lockstep (SPEC §5 S5) and replay.
// frameDiff counts differing pixels and finds the first differing line and the bounding box;
// signatureOf turns a diff into an incident signature (SPEC §6.5); gameRamDiffers compares the
// §6.17 game-state bytes. Truth-maker: lockstep/lockstep.test.ts.
import type { Incident } from "../src/schema.ts";

export const WIDTH = 160;
export const HEIGHT = 144;

/** The game-state RAM SPEC §6.17 defines: 0xC0F0 counter (2), scene (1), hero x (2), hero y (1), lives (1). */
export const GAME_RAM = { addr: 0xc0f0, len: 7 } as const;
/** Offset of the scene id (0xC0F2) inside GAME_RAM. */
export const SCENE_OFFSET = 2;
/** Band height and bounding-box grid, in pixels (SPEC §5 S5: "the 8-line band", "rounded to 8 px"). */
export const GRID = 8;

export type Signature = Incident["signature"];

export interface FrameDiff {
  pixels: number;
  /** First differing line, or -1 when the frames are equal. */
  firstLine: number;
  /** [x0, y0, x1, y1], x1 and y1 exclusive, unrounded; [0,0,0,0] when equal. */
  box: [number, number, number, number];
}

export function frameDiff(core: Uint8Array, oracle: Uint8Array): FrameDiff {
  let pixels = 0, firstLine = -1, x0 = WIDTH, y0 = HEIGHT, x1 = 0, y1 = 0;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const i = y * WIDTH + x;
      if (core[i] === oracle[i]) continue;
      pixels++;
      if (firstLine < 0) firstLine = y;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x + 1 > x1) x1 = x + 1;
      if (y + 1 > y1) y1 = y + 1;
    }
  }
  return { pixels, firstLine, box: pixels ? [x0, y0, x1, y1] : [0, 0, 0, 0] };
}

const down = (v: number) => Math.floor(v / GRID) * GRID;
const up = (v: number) => Math.ceil(v / GRID) * GRID;

/**
 * The incident signature of a frame diff: `band` is floor(firstLine / 8); `bbox` is [x0, y0, x1, y1] with
 * x1, y1 exclusive, rounded outward to multiples of 8. A diff with no differing pixel has band -1 and bbox
 * [0,0,0,0], the signature a logic incident carries when its frames agree.
 */
export function signatureOf(scene: number, d: FrameDiff): Signature {
  if (d.pixels === 0) return { scene, band: -1, bbox: [0, 0, 0, 0] };
  const [x0, y0, x1, y1] = d.box;
  return { scene, band: Math.floor(d.firstLine / GRID), bbox: [down(x0), down(y0), up(x1), up(y1)] };
}

export function signatureKey(kind: Incident["kind"], rom_sha: string, s: Signature): string {
  return `${kind}|${rom_sha}|${s.scene}|${s.band}|${s.bbox.join(",")}`;
}

/** The core's game-state bytes, read through the side-effect-free bus read. */
export function coreGameRam(read: (addr: number) => number): Uint8Array {
  const out = new Uint8Array(GAME_RAM.len);
  for (let i = 0; i < GAME_RAM.len; i++) out[i] = read(GAME_RAM.addr + i) & 0xff;
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The mask that holds for the frame after counter `key`: the entry with the largest from_counter <= key (oracle/frontend.py). */
export function maskAt(inputs: { from_counter: number; mask: number }[], key: number): number {
  let mask = 0;
  for (const e of [...inputs].sort((a, b) => a.from_counter - b.from_counter)) {
    if (e.from_counter <= key) mask = e.mask;
    else break;
  }
  return mask;
}
