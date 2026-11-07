// Core dir: the playback core with one planted game-state mutation: lives (0xC0F6) XOR 1 from counter 400 on.
import { createPlaybackCore, type Mutation } from "../playback.ts";
export const MUTATION: Mutation = { kind: "ram", from: 400, offset: 6, xor: 1 };
export const createCore = (rom: Uint8Array) => createPlaybackCore(rom, MUTATION);
