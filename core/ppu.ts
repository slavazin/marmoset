import type { HandlerId } from "../src/schema.ts";
export class Ppu {
  vram = new Uint8Array(0x2000);
  oam = new Uint8Array(0xa0);
  fb = new Uint8Array(160 * 144);
  lcdc = 0x91; stat = 0x85 & 0xf8; scy = 0; scx = 0; ly = 0; lyc = 0;
  bgp = 0xfc; obp0 = 0xff; obp1 = 0xff; wy = 0; wx = 0;
  dot = 0; mode: 0 | 1 | 2 | 3 = 2; winLine = 0; statLine = false;
  m3len = 172; lineSprites: number[] = [];
  hits: Record<HandlerId, number>;
  constructor(hits: Record<HandlerId, number>) { this.hits = hits; this.resetStatLine(); }
  get on(): boolean { return (this.lcdc & 0x80) !== 0; }
  resetStatLine(): void { this.statLine = this.computeStatLine(); }
  computeStatLine(): boolean {
    if (!this.on) return false;
    const s = this.stat;
    const lycEq = (this.stat & 0x04) !== 0;
    if ((s & 0x40) && lycEq) return true;
    if ((s & 0x20) && this.mode === 2) return true;
    if ((s & 0x10) && this.mode === 1) return true;
    if ((s & 0x08) && this.mode === 0) return true;
    return false;
  }
  updCoinc(): void {
    if (this.ly === this.lyc) this.stat |= 0x04; else this.stat &= ~0x04;
  }
  info(): { ly: number; mode: 0 | 1 | 2 | 3; dot: number; stat: number; lcdc: number } {
    return { ly: this.ly, mode: this.mode, dot: this.dot, stat: (this.stat & 0xf8) | (this.on ? this.mode : 0), lcdc: this.lcdc };
  }
  readReg(a: number): number {
    switch (a) {
      case 0xff40: return this.lcdc;
      case 0xff41: return (this.stat & 0xf8) | (this.on ? this.mode : 0) | 0x80;
      case 0xff42: return this.scy;
      case 0xff43: return this.scx;
      case 0xff44: return this.ly;
      case 0xff45: return this.lyc;
      case 0xff47: return this.bgp;
      case 0xff48: return this.obp0;
      case 0xff49: return this.obp1;
      case 0xff4a: return this.wy;
      case 0xff4b: return this.wx;
      default: return 0xff;
    }
  }
  writeReg(a: number, v: number, raise: (b: number) => void): void {
    v &= 0xff;
    switch (a) {
      case 0xff40: {
        const was = this.on; const now = (v & 0x80) !== 0;
        this.lcdc = v;
        if (was && !now) { this.ly = 0; this.dot = 0; this.mode = 0; this.winLine = 0; this.stat &= ~0x03; this.updCoinc(); this.statLine = false; }
        else if (!was && now) { this.dot = 0; this.mode = 2; this.updCoinc(); this.resetStatLine(); this.beginLine(raise); }
        else this.checkStat(raise);
        break;
      }
      case 0xff41: this.stat = (this.stat & 0x07) | (v & 0xf8); this.updCoinc(); this.checkStat(raise); break;
      case 0xff42: this.scy = v; break;
      case 0xff43: this.scx = v; break;
      case 0xff45: this.lyc = v; this.updCoinc(); this.checkStat(raise); break;
      case 0xff47: this.bgp = v; break;
      case 0xff48: this.obp0 = v; break;
      case 0xff49: this.obp1 = v; break;
      case 0xff4a: this.wy = v; break;
      case 0xff4b: this.wx = v; break;
    }
  }
  checkStat(raise: (b: number) => void): void {
    const l = this.computeStatLine();
    if (l && !this.statLine) raise(1);
    this.statLine = l;
  }
  beginLine(raise: (b: number) => void): void {
    if (!this.on || this.ly >= 144) return;
    this.m3len = 172 + (this.scx & 7);
    let n = 0;
    const tall = (this.lcdc & 0x04) !== 0; const h = tall ? 16 : 8;
    for (let i = 0; i < 40; i++) {
      const y = this.oam[i * 4] - 16;
      if (this.ly >= y && this.ly < y + h) { n++; if (n >= 10) break; }
    }
    this.m3len += n * 6; if (this.m3len > 376) this.m3len = 376;
    this.hits["ppu.oam"] = (this.hits["ppu.oam"] || 0) + 1;
  }
  scanSprites(): number[] {
    const out: number[] = [];
    if (!(this.lcdc & 0x02)) return out;
    const tall = (this.lcdc & 0x04) !== 0; const h = tall ? 16 : 8;
    for (let i = 0; i < 40 && out.length < 10; i++) {
      const y = this.oam[i * 4] - 16;
      if (this.ly >= y && this.ly < y + h) out.push(i);
    }
    out.sort((a, b) => (this.oam[a * 4 + 1] - this.oam[b * 4 + 1]) || (a - b));
    return out;
  }
  renderLine(): void {
    const y = this.ly; if (y >= 144) return;
    const row = y * 160;
    const pal = [this.bgp & 3, (this.bgp >> 2) & 3, (this.bgp >> 4) & 3, (this.bgp >> 6) & 3];
    const bgOn = (this.lcdc & 0x01) !== 0;
    const winOn = (this.lcdc & 0x20) !== 0;
    const signed = (this.lcdc & 0x10) === 0;
    const bgMap = (this.lcdc & 0x08) ? 0x1c00 : 0x1800;
    const winMap = (this.lcdc & 0x40) ? 0x1c00 : 0x1800;
    const useWin = this.on && winOn && y >= this.wy && this.wx <= 166;
    const wx = this.wx - 7;
    for (let x = 0; x < 160; x++) {
      let ci = 0;
      if (!bgOn) ci = 0;
      else {
        let px = x, prow = y, map = bgMap;
        if (useWin && x >= wx) { px = x - wx; prow = this.winLine; map = winMap; }
        else if (useWin && x < wx && wx <= 7) { /* bg */ px = (x + this.scx) & 0xff; prow = (y + this.scy) & 0xff; }
        else if (useWin && x >= wx) { px = x - wx; prow = this.winLine; map = winMap; }
        else { px = (x + this.scx) & 0xff; prow = (y + this.scy) & 0xff; }
        const tx = px >> 3, ty = prow >> 3;
        let ti = this.vram[map + ty * 32 + tx];
        let tn = signed ? 0x1000 + (((ti ^ 0x80) - 0x80) << 4) : (ti << 4);
        const r = this.vram[(tn + ((prow & 7) << 1)) & 0x1fff];
        const r2 = this.vram[(tn + ((prow & 7) << 1) + 1) & 0x1fff];
        const b = 7 - (px & 7);
        ci = ((r >> b) & 1) | (((r2 >> b) & 1) << 1);
      }
      this.fb[row + x] = pal[ci];
    }
    this.hits["ppu.fetcher"] = (this.hits["ppu.fetcher"] || 0) + 1;
    this.hits["ppu.fifo"] = (this.hits["ppu.fifo"] || 0) + 1;
    if (useWin) { this.hits["ppu.window"] = (this.hits["ppu.window"] || 0) + 1; this.winLine++; }
    const spr = this.scanSprites();
    if (spr.length) this.hits["ppu.sprites"] = (this.hits["ppu.sprites"] || 0) + 1;
    if (spr.length && this.on) {
      const tall = (this.lcdc & 0x04) !== 0;
      const bgPrio = new Uint8Array(160);
      if (bgOn) {
        for (let x = 0; x < 160; x++) {
          const v = this.fb[row + x];
          bgPrio[x] = (v === pal[0]) ? 0 : 1;
        }
      }
      for (let k = spr.length - 1; k >= 0; k--) {
        const i = spr[k]; const o = i * 4;
        const sy = this.oam[o] - 16, sx = this.oam[o + 1] - 8;
        const tile = this.oam[o + 2], at = this.oam[o + 3];
        const palO = [(at & 0x10 ? this.obp1 : this.obp0) & 3, 0, 0, 0];
        const p = at & 0x10 ? this.obp1 : this.obp0;
        const pc = [(p) & 3, (p >> 2) & 3, (p >> 4) & 3, (p >> 6) & 3];
        void palO;
        let ry = y - sy; if (at & 0x40) ry = (tall ? 15 : 7) - ry;
        let tn2 = tall ? (tile & 0xfe) + (ry >= 8 ? 1 : 0) : tile;
        const lr = ry & 7;
        const b0 = this.vram[(tn2 * 16 + lr * 2) & 0x1fff];
        const b1 = this.vram[(tn2 * 16 + lr * 2 + 1) & 0x1fff];
        for (let px2 = 0; px2 < 8; px2++) {
          const bx = (at & 0x20) ? px2 : 7 - px2;
          const ci2 = ((b0 >> bx) & 1) | (((b1 >> bx) & 1) << 1);
          if (ci2 === 0) continue;
          const dx = sx + px2; if (dx < 0 || dx >= 160) continue;
          if ((at & 0x80) && bgPrio[dx]) continue;
          this.fb[row + dx] = pc[ci2];
        }
      }
    }
  }
  tick(t: number, raise: (b: number) => void): void {
    for (let i = 0; i < t; i++) this.tick1(raise);
  }
  tick1(raise: (b: number) => void): void {
    if (!this.on) return;
    const prevMode = this.mode; const prevLy = this.ly;
    void prevLy;
    this.dot++;
    if (this.ly < 144) {
      const m3end = 80 + this.m3len;
      let nm: 0 | 1 | 2 | 3 = this.mode;
      if (this.dot <= 80) nm = 2; else if (this.dot <= m3end) nm = 3; else nm = 0;
      if (nm !== this.mode) {
        this.mode = nm; this.stat = (this.stat & ~0x03) | nm;
        if (nm === 0) this.renderLine();
        this.checkStat(raise);
      }
      if (this.dot >= 456) {
        this.dot = 0; this.ly++;
        this.updCoinc();
        if (this.ly === 144) {
          this.mode = 1; this.stat = (this.stat & ~0x03) | 1;
          raise(0); this.checkStat(raise);
        } else {
          this.mode = 2; this.stat = (this.stat & ~0x03) | 2;
          this.checkStat(raise); this.beginLine(raise);
        }
      }
    } else {
      this.mode = 1; this.stat = (this.stat & ~0x03) | 1;
      if (this.dot >= 456) {
        this.dot = 0; this.ly++;
        if (this.ly > 153) {
          this.ly = 0; this.winLine = 0; this.mode = 2;
          this.stat = (this.stat & ~0x03) | 2;
          this.updCoinc(); this.checkStat(raise); this.beginLine(raise);
        } else this.updCoinc(), this.checkStat(raise);
      }
    }
    void prevMode;
  }
}
