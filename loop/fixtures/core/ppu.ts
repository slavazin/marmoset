// Fixture PPU for gate tests: the shade a whole frame is filled with, from the ROM's first byte.
// The bug the fixture incident reproduces: a ROM whose first byte is 2 renders shade 3; the oracle renders 2.
export function shadeFor(romByte: number): number {
  return romByte === 2 ? 3 : romByte & 3;
}
