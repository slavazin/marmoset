// Prints the serial text of each base Blargg ROM that does not pass, so the S1 edit loop sees which opcodes fail
// (SPEC §5 S1 Wiggle: "hand-drive Muse with the failing ROM's output"). Reads the ROM list from splits.json via
// suites/splits.ts; runs each ROM to "Passed", or to SERIAL_CAP_CYCLES after "Failed", or to the cap.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CreateCore } from "../src/schema.ts";
import { expandGlob, loadSplits, romsDir, SPLITS_PATH } from "../suites/splits.ts";

/** Emulated T-cycles per ROM before giving up: 30 emulated seconds, as suites/score.ts CYCLE_CAP. */
const CAP = 30 * 4_194_304;
/** T-cycles run after "Failed" appears, so the failing-opcode list that follows it is printed too. */
const SERIAL_CAP_CYCLES = 4_194_304;

const dir = process.argv[2] ?? "core";
const { createCore } = (await import(pathToFileURL(resolve(dir, "index.ts")).href)) as { createCore: CreateCore };
const root = romsDir();
for (const g of loadSplits(SPLITS_PATH).families.blargg.roms) {
  for (const rom of expandGlob(root, g)) {
    let text = "";
    try {
      const core = createCore(new Uint8Array(readFileSync(join(root, rom))));
      let failAt = -1;
      for (let n = 0; core.cycles < CAP; n++) {
        core.step();
        if ((n & 1023) !== 0) continue;
        if (core.serial.includes("Passed")) break;
        if (failAt < 0 && core.serial.includes("Failed")) failAt = core.cycles;
        if (failAt >= 0 && core.cycles - failAt > SERIAL_CAP_CYCLES) break;
      }
      if (core.serial.includes("Passed")) continue;
      text = core.serial;
    } catch (e) {
      text = `core threw: ${String(e)}`;
    }
    console.log(`--- ${rom} serial:\n${text.slice(0, 1200)}`);
  }
}
