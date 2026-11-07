// A CGB fixture core for suites tests (D-0019): the NOP core (every instruction a 4-cycle NOP, registers 0, serial
// empty) with model "CGB" and frameRgb, an all-black RGB888 frame. Black is no CGB reference's every pixel, so it
// scores 0 on the CGB families; read() returns ROM bytes, so LD B,B fires wherever a 0x40 byte sits in the ROM.
import type { Core, CreateCore } from "../../../src/schema.ts";
import { createCore as nopCore } from "../nop-core/index.ts";

export const createCore: CreateCore = (rom) => {
  const core: Core = nopCore(rom);
  const rgb = new Uint8Array(160 * 144 * 3);
  core.model = "CGB";
  core.frameRgb = () => rgb;
  return core;
};
