import type { HandlerId } from "../src/schema.ts";
export class Cart {
  rom: Uint8Array;
  ram: Uint8Array;
  ramOn = false;
  lo = 1;
  hi = 0;
  mode = 0;
  nRom = 2;
  nRam = 0;
  isMbc1 = false;
  hits: Record<HandlerId, number>;
  constructor(rom: Uint8Array, hits: Record<HandlerId, number>) {
    this.rom = rom;
    this.hits = hits;
    const t = rom.length > 0x147 ? rom[0x147] : 0;
    const as = rom.length > 0x149 ? rom[0x149] : 0;
    this.isMbc1 = t === 0x01 || t === 0x02 || t === 0x03;
    let nb = rom.length >> 14;
    if (nb < 2) nb = 2;
    this.nRom = nb;
    let nr = 0;
    if (as === 0x02) nr = 1;
    else if (as === 0x03) nr = 4;
    else if (as === 0x04) nr = 16;
    else if (as === 0x05) nr = 8;
    else if (as === 0x01) nr = 1;
    if (!this.isMbc1) {
      if (nr === 0 && (t === 0x02 || t === 0x03)) nr = 1;
    }
    if (nr > 4 && this.isMbc1) nr = 4;
    if (nr > 16) nr = 16;
    this.nRam = nr;
    this.ram = new Uint8Array(nr * 8192);
  }
  read(a: number): number {
    if (a < 0x4000) {
      if (this.isMbc1 && this.mode === 1) {
        const b = (this.hi << 5) % this.nRom;
        const o = b * 0x4000 + a;
        return o < this.rom.length ? this.rom[o] : 0xff;
      }
      return a < this.rom.length ? this.rom[a] : 0xff;
    }
    const b = ((this.hi << 5) | this.lo) % this.nRom;
    const o = b * 0x4000 + (a - 0x4000);
    return o < this.rom.length ? this.rom[o] : 0xff;
  }
  write(a: number, v: number): void {
    if (!this.isMbc1) return;
    v &= 0xff;
    if (a < 0x2000) {
      this.ramOn = (v & 0x0f) === 0x0a;
      this.hits["mbc1"] = (this.hits["mbc1"] || 0) + 1;
    } else if (a < 0x4000) {
      let l = v & 0x1f;
      if (l === 0) l = 1;
      this.lo = l;
      this.hits["mbc1"] = (this.hits["mbc1"] || 0) + 1;
    } else if (a < 0x6000) {
      this.hi = v & 0x03;
      this.hits["mbc1"] = (this.hits["mbc1"] || 0) + 1;
    } else if (a < 0x8000) {
      this.mode = v & 0x01;
      this.hits["mbc1"] = (this.hits["mbc1"] || 0) + 1;
    }
  }
  readRam(a: number): number {
    if (this.nRam === 0 || !this.ramOn) return 0xff;
    let b = this.mode === 1 ? this.hi % this.nRam : 0;
    if (this.nRam === 1) b = 0;
    const o = b * 8192 + (a - 0xa000);
    return o < this.ram.length ? this.ram[o] : 0xff;
  }
  writeRam(a: number, v: number): void {
    if (this.nRam === 0 || !this.ramOn) return;
    let b = this.mode === 1 ? this.hi % this.nRam : 0;
    if (this.nRam === 1) b = 0;
    const o = b * 8192 + (a - 0xa000);
    if (o < this.ram.length) this.ram[o] = v & 0xff;
  }
}
