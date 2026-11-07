// Core dir: the playback core with one planted PPU mutation: shades flipped on lines 74..77, x 17..44,
// from counter 300 on. Its signature is band 9, bbox [16, 72, 48, 80] (lockstep/diff.ts signatureOf).
import { createPlaybackCore, type Mutation } from "../playback.ts";
export const MUTATION: Mutation = { kind: "ppu-band", from: 300, lines: [74, 78], xs: [17, 45] };
export const createCore = (rom: Uint8Array) => createPlaybackCore(rom, MUTATION);
