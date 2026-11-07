// Core dir: the unmutated playback core (lockstep/fixtures/playback.ts); it matches the oracle by construction.
import { createPlaybackCore } from "../playback.ts";
export const createCore = (rom: Uint8Array) => createPlaybackCore(rom);
