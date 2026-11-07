import type { Core, CoreRegs, CreateCore, HandlerId, Handlers, TelemetryTap } from "../src/schema.ts";
import { Cpu } from "./cpu.ts";
import type { CpuBus } from "./cpu.ts";
import { Ppu } from "./ppu.ts";
import { Cart } from "./mbc1.ts";

export const HANDLERS: Record<HandlerId, string> = {
  "cpu.op": "core/cpu.ts",
  "cpu.cb": "core/cpu.ts",
  "ppu.oam": "core/ppu.ts",
  "ppu.fetcher": "core/ppu.ts",
  "ppu.fifo": "core/ppu.ts",
  "ppu.window": "core/ppu.ts",
  "ppu.sprites": "core/ppu.ts",
  "timer": "core/index.ts",
  "irq": "core/index.ts",
  "dma": "core/index.ts",
  "mbc1": "core/mbc1.ts",
  "bus.io": "core/index.ts",
};

const HIDS = ["cpu.op","cpu.cb","ppu.oam","ppu.fetcher","ppu.fifo","ppu.window","ppu.sprites","timer","irq","dma","mbc1","bus.io"] as const;

function newHits(): Record<HandlerId, number> {
  const o: Record<HandlerId, number> = {};
  for (const k of HIDS) o[k] = 0;
  return o;
}

export function createCore(rom: Uint8Array): Core {
  const hits = newHits();
  const cart = new Cart(rom, hits);
  const ppu = new Ppu(hits);
  const wram = new Uint8Array(0x2000);
  const hram = new Uint8Array(0x80);
  const audio = new Uint8Array(0x40);
  const audInit: Array<[number, number]> = [
    [0x10,0x80],[0x11,0xbf],[0x12,0xf3],[0x14,0xbf],[0x16,0x3f],[0x17,0x00],
    [0x19,0xbf],[0x1a,0x7f],[0x1b,0xff],[0x1c,0x9f],[0x1e,0xbf],[0x20,0xff],
    [0x21,0x00],[0x22,0x00],[0x23,0xbf],[0x24,0x77],[0x25,0xf3],[0x26,0xf1],
  ];
  for (const [o,v] of audInit) audio[o & 0x3f] = v;

  let div = 0xab00;
  let tima = 0, tma = 0, tac = 0xf8;
  let prevAnd = 0;
  let reload = 0;
  let IF = 0xe1, IE = 0x00;
  let p1 = 0xcf;
  let joyMask = 0;
  let sb = 0x00, sc = 0x7e;
  let serialText = "";
  let dmaOn = false, dmaBase = 0, dmaPos = 0, dmaT = 0;
  let cycles = 0;
  let onRegWrite: TelemetryTap["onRegWrite"] | undefined = undefined;
  const tapHits = hits;

  const raise = (b: number): void => { IF = (IF | (1 << b)) & 0xff; };

  function timerBit(): number {
    const s = tac & 0x03;
    return s === 0 ? 9 : s === 1 ? 3 : s === 2 ? 5 : 7;
  }
  function curAnd(): number {
    return (((div >> timerBit()) & 1) & ((tac >> 2) & 1));
  }
  function incTima(): void {
    hits["timer"] = (hits["timer"] || 0) + 1;
    if (tima === 0xff) { tima = 0; reload = 4; }
    else tima = (tima + 1) & 0xff;
  }
  function timerStep(): void {
    if (reload > 0) {
      reload--;
      if (reload === 0) { tima = tma & 0xff; IF = (IF | 0x04) & 0xff; }
    }
    div = (div + 1) & 0xffff;
    const c = curAnd();
    if (prevAnd === 1 && c === 0) {
      if (reload === 0) incTima();
    }
    prevAnd = c;
  }

  function peek(a: number): number {
    a &= 0xffff;
    if (a < 0x8000) return cart.read(a);
    if (a < 0xa000) {
      return ppu.vram[a - 0x8000] & 0xff;
    }
    if (a < 0xc000) return cart.readRam(a);
    if (a < 0xe000) return wram[a - 0xc000] & 0xff;
    if (a < 0xfe00) return wram[a - 0xe000] & 0xff;
    if (a < 0xfea0) {
      if (dmaOn) return 0xff;
      return ppu.oam[a - 0xfe00] & 0xff;
    }
    if (a < 0xff00) return 0xff;
    if (a < 0xff80) return ioRead(a);
    if (a < 0xffff) return hram[a - 0xff80] & 0xff;
    return IE & 0xff;
  }

  function ioRead(a: number): number {
    switch (a) {
      case 0xff00: {
        const sel = p1 & 0x30;
        const dir = (joyMask & 0x0f);
        const btn = ((joyMask >> 4) & 0x0f);
        let v = 0x0f;
        if ((sel & 0x10) === 0) v &= (~dir) & 0x0f;
        if ((sel & 0x20) === 0) v &= (~btn) & 0x0f;
        if ((sel & 0x30) === 0x30) v = 0x0f;
        return 0xc0 | (sel & 0x30) | (v & 0x0f);
      }
      case 0xff01: return sb & 0xff;
      case 0xff02: return (sc & 0xff) | 0x7c;
      case 0xff04: return (div >> 8) & 0xff;
      case 0xff05: return tima & 0xff;
      case 0xff06: return tma & 0xff;
      case 0xff07: return 0xf8 | (tac & 0x07);
      case 0xff0f: return 0xe0 | (IF & 0x1f);
      case 0xff46: return 0xff;
      case 0xff40: case 0xff41: case 0xff42: case 0xff43: case 0xff44:
      case 0xff45: case 0xff47: case 0xff48: case 0xff49: case 0xff4a: case 0xff4b:
        return ppu.readReg(a);
      default:
        if (a >= 0xff10 && a <= 0xff3f) {
          return audio[a - 0xff00] & 0xff;
        }
        return 0xff;
    }
  }

  function poke(a: number, v: number): void {
    v &= 0xff;
    if (a < 0x8000) { cart.write(a, v); return; }
    if (a < 0xa000) { ppu.vram[a - 0x8000] = v; return; }
    if (a < 0xc000) { cart.writeRam(a, v); return; }
    if (a < 0xe000) { wram[a - 0xc000] = v; return; }
    if (a < 0xfe00) { wram[a - 0xe000] = v; return; }
    if (a < 0xfea0) {
      if (!dmaOn) ppu.oam[a - 0xfe00] = v;
      return;
    }
    if (a < 0xff00) return;
    if (a < 0xff80) { ioWrite(a, v); return; }
    if (a < 0xffff) { hram[a - 0xff80] = v; return; }
    IE = v & 0xff;
  }

  function ioWrite(a: number, v: number): void {
    v &= 0xff;
    switch (a) {
      case 0xff00: p1 = (0xc0 | (v & 0x30) | 0x0f) & 0xff; break;
      case 0xff01: sb = v; break;
      case 0xff02: {
        sc = v;
        if ((v & 0x81) === 0x81) {
          serialText += String.fromCharCode(sb & 0xff);
          sb = 0xff;
          raise(3);
        }
        break;
      }
      case 0xff04: {
        div = 0;
        const c = curAnd();
        if (prevAnd === 1 && c === 0) { if (reload === 0) incTima(); }
        prevAnd = c;
        break;
      }
      case 0xff05:
        if (reload > 0) reload = 0;
        tima = v;
        break;
      case 0xff06: tma = v; break;
      case 0xff07: {
        tac = (v & 0x07) | 0xf8;
        const c = curAnd();
        if (prevAnd === 1 && c === 0) { if (reload === 0) incTima(); }
        prevAnd = c;
        break;
      }
      case 0xff0f: IF = 0xe0 | (v & 0x1f); break;
      case 0xff46: {
        dmaOn = true; dmaBase = (v << 8) & 0xffff; dmaPos = 0; dmaT = 0;
        break;
      }
      case 0xff40: case 0xff41: case 0xff42: case 0xff43: case 0xff45:
      case 0xff47: case 0xff48: case 0xff49: case 0xff4a: case 0xff4b:
        ppu.writeReg(a, v, raise);
        break;
      case 0xff44: break;
      default:
        if (a >= 0xff10 && a <= 0xff3f) audio[a - 0xff00] = v;
        break;
    }
  }

  function dmaStep(): void {
    if (!dmaOn) return;
    dmaT++;
    if (dmaT >= 4) {
      dmaT = 0;
      const src = (dmaBase + dmaPos) & 0xffff;
      let b = 0xff;
      if (src < 0x8000) b = cart.read(src);
      else if (src < 0xa000) b = ppu.vram[src - 0x8000];
      else if (src < 0xc000) b = cart.readRam(src);
      else if (src < 0xe000) b = wram[src - 0xc000];
      else if (src < 0xfe00) b = wram[src - 0xe000];
      else if (src < 0xfea0) b = ppu.oam[src - 0xfe00];
      else if (src < 0xff00) b = 0xff;
      else if (src < 0xff80) b = ioRead(src);
      else if (src < 0xffff) b = hram[src - 0xff80];
      else b = IE;
      ppu.oam[dmaPos] = b & 0xff;
      hits["dma"] = (hits["dma"] || 0) + 1;
      dmaPos++;
      if (dmaPos >= 160) { dmaOn = false; }
    }
  }

  function tick(n: number): void {
    for (let i = 0; i < n; i++) {
      cycles++;
      timerStep();
      ppu.tick1(raise);
      dmaStep();
    }
  }

  const cpu = new Cpu(hits);
  const bus: CpuBus = {
    read(a: number): number {
      a &= 0xffff;
      tick(4);
      return peek(a);
    },
    write(a: number, v: number): void {
      a &= 0xffff; v &= 0xff;
      tick(4);
      if (a === 0xffff || (a >= 0xff00 && a <= 0xff7f)) {
        hits["bus.io"] = (hits["bus.io"] || 0) + 1;
        if (onRegWrite) {
          const pi = ppu.info();
          onRegWrite({ addr: a, value: v, ly: pi.ly, dot: pi.dot, cycles });
        }
      }
      if (a === 0xffff) { IE = v & 0xff; return; }
      poke(a, v);
    },
    idle(): void { tick(4); },
    pendingIrqs(): number { return (IF & IE & 0x1f); },
    ackIrq(bit: number): void { IF = (IF & ~(1 << bit)) & 0xff; },
  };
  cpu.attach(bus);
  prevAnd = curAnd();

  function step(): void { cpu.step(); }

  function runFrame(): void {
    if (!ppu.on) {
      const target = cycles + 70224;
      while (cycles < target) step();
      return;
    }
    if (ppu.ly === 144) {
      let guard = 0;
      while (ppu.ly === 144 && guard++ < 1000000) step();
    }
    let guard = 0;
    while (ppu.ly !== 144 && guard++ < 1000000) step();
  }

  function read(a: number): number { return peek(a & 0xffff); }

  function frame(): Uint8Array { return ppu.fb.slice(); }

  function setButtons(mask: number): void {
    mask &= 0xff;
    const newly = (mask & ~joyMask) & 0xff;
    joyMask = mask;
    if (newly !== 0) raise(4);
  }

  function runToCounter(n: number, wramAddr = 0xc0f0): boolean {
    let last = -1;
    let stall = 0;
    for (let f = 0; f < 200000; f++) {
      runFrame();
      const v = (read(wramAddr) | (read(wramAddr + 1) << 8)) & 0xffff;
      if (v === (n & 0xffff)) return true;
      if (v === last) {
        stall++;
        if (stall >= 4) return false;
      } else { stall = 0; last = v; }
    }
    return false;
  }

  function snapshot(): Uint8Array {
    const sbytes = new TextEncoder().encode(serialText);
    const ramLen = cart.ram.length;
    const total = 4 + 8 + 2 + 2 + 4 + (2+1+1+1+1+1+1+1+1) + (1+1+1+1) + 2 + sbytes.length + (1+1+1+1) + 4 + ramLen + 0x2000 + 0x80 + 0x40 + 0x2000 + 0xa0 + 23040 + 16 + 8;
    const buf = new Uint8Array(total + 64);
    const dv = new DataView(buf.buffer);
    let o = 0;
    dv.setUint32(o, 0x444d4731); o += 4;
    buf[o++] = cpu.a; buf[o++] = cpu.b; buf[o++] = cpu.c; buf[o++] = cpu.d;
    buf[o++] = cpu.e; buf[o++] = cpu.f; buf[o++] = cpu.h; buf[o++] = cpu.l;
    dv.setUint16(o, cpu.sp, true); o += 2;
    dv.setUint16(o, cpu.pc, true); o += 2;
    buf[o++] = cpu.ime ? 1 : 0; buf[o++] = cpu.eiDelay ? 1 : 0;
    buf[o++] = cpu.halted ? 1 : 0; buf[o++] = cpu.haltBug ? 1 : 0;
    dv.setUint16(o, div, true); o += 2;
    buf[o++] = tima; buf[o++] = tma; buf[o++] = tac; buf[o++] = prevAnd; buf[o++] = reload;
    buf[o++] = IF; buf[o++] = IE;
    buf[o++] = p1; buf[o++] = joyMask; buf[o++] = sb; buf[o++] = sc;
    dv.setUint16(o, sbytes.length, true); o += 2;
    buf.set(sbytes, o); o += sbytes.length;
    buf[o++] = dmaOn ? 1 : 0; buf[o++] = (dmaBase >> 8) & 0xff; buf[o++] = dmaPos & 0xff; buf[o++] = dmaT & 0xff;
    dv.setUint32(o, ramLen, true); o += 4;
    buf.set(cart.ram.subarray(0, ramLen), o); o += ramLen;
    buf[o++] = cart.ramOn ? 1 : 0; buf[o++] = cart.lo & 0xff; buf[o++] = cart.hi & 0xff; buf[o++] = cart.mode & 0xff;
    buf.set(wram, o); o += 0x2000;
    buf.set(hram, o); o += 0x80;
    buf.set(audio, o); o += 0x40;
    buf.set(ppu.vram, o); o += 0x2000;
    buf.set(ppu.oam, o); o += 0xa0;
    buf.set(ppu.fb, o); o += 23040;
    buf[o++] = ppu.lcdc; buf[o++] = ppu.stat; buf[o++] = ppu.scy; buf[o++] = ppu.scx;
    buf[o++] = ppu.ly; buf[o++] = ppu.lyc; buf[o++] = ppu.bgp; buf[o++] = ppu.obp0;
    buf[o++] = ppu.obp1; buf[o++] = ppu.wy; buf[o++] = ppu.wx; buf[o++] = ppu.mode;
    dv.setUint16(o, ppu.dot, true); o += 2;
    buf[o++] = ppu.winLine & 0xff; buf[o++] = ppu.statLine ? 1 : 0;
    dv.setUint16(o, ppu.m3len, true); o += 2;
    const cyc = Math.floor(cycles);
    dv.setUint32(o, cyc >>> 0, true); o += 4;
    dv.setUint32(o, Math.floor(cyc / 4294967296), true); o += 4;
    return buf.slice(0, o);
  }

  function restore(s: Uint8Array): void {
    const dv = new DataView(s.buffer, s.byteOffset, s.byteLength);
    let o = 0;
    o += 4;
    cpu.a = s[o++]; cpu.b = s[o++]; cpu.c = s[o++]; cpu.d = s[o++];
    cpu.e = s[o++]; cpu.f = s[o++] & 0xf0; cpu.h = s[o++]; cpu.l = s[o++];
    cpu.sp = dv.getUint16(o, true); o += 2;
    cpu.pc = dv.getUint16(o, true); o += 2;
    cpu.ime = s[o++] !== 0; cpu.eiDelay = s[o++] !== 0;
    cpu.halted = s[o++] !== 0; cpu.haltBug = s[o++] !== 0;
    div = dv.getUint16(o, true); o += 2;
    tima = s[o++]; tma = s[o++]; tac = s[o++]; prevAnd = s[o++]; reload = s[o++];
    IF = s[o++]; IE = s[o++];
    p1 = s[o++]; joyMask = s[o++]; sb = s[o++]; sc = s[o++];
    const slen = dv.getUint16(o, true); o += 2;
    serialText = new TextDecoder().decode(s.subarray(o, o + slen)); o += slen;
    dmaOn = s[o++] !== 0; dmaBase = (s[o++] << 8) & 0xffff; dmaPos = s[o++]; dmaT = s[o++];
    const ramLen = dv.getUint32(o, true); o += 4;
    cart.ram.set(s.subarray(o, o + ramLen).subarray(0, cart.ram.length)); o += ramLen;
    cart.ramOn = s[o++] !== 0; cart.lo = s[o++]; cart.hi = s[o++]; cart.mode = s[o++];
    wram.set(s.subarray(o, o + 0x2000)); o += 0x2000;
    hram.set(s.subarray(o, o + 0x80)); o += 0x80;
    audio.set(s.subarray(o, o + 0x40)); o += 0x40;
    ppu.vram.set(s.subarray(o, o + 0x2000)); o += 0x2000;
    ppu.oam.set(s.subarray(o, o + 0xa0)); o += 0xa0;
    ppu.fb.set(s.subarray(o, o + 23040)); o += 23040;
    ppu.lcdc = s[o++]; ppu.stat = s[o++]; ppu.scy = s[o++]; ppu.scx = s[o++];
    ppu.ly = s[o++]; ppu.lyc = s[o++]; ppu.bgp = s[o++]; ppu.obp0 = s[o++];
    ppu.obp1 = s[o++]; ppu.wy = s[o++]; ppu.wx = s[o++]; ppu.mode = (s[o++] as 0 | 1 | 2 | 3);
    ppu.dot = dv.getUint16(o, true); o += 2;
    ppu.winLine = s[o++]; ppu.statLine = s[o++] !== 0;
    ppu.m3len = dv.getUint16(o, true); o += 2;
    const lo32 = dv.getUint32(o, true); o += 4;
    const hi32 = dv.getUint32(o, true); o += 4;
    cycles = hi32 * 4294967296 + lo32;
  }

  const tap: TelemetryTap = {
    set onRegWrite(fn) { onRegWrite = fn as typeof onRegWrite; },
    get onRegWrite() { return onRegWrite as TelemetryTap["onRegWrite"]; },
    handlerHits(): Record<HandlerId, number> {
      const out: Record<HandlerId, number> = {};
      for (const k of HIDS) { out[k] = tapHits[k] || 0; tapHits[k] = 0; }
      return out;
    },
    ppu: () => ppu.info(),
  };

  const regs: CoreRegs = { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, h: 0, l: 0, sp: 0, pc: 0 };
  const core = {
    step,
    runFrame,
    runToCounter,
    get cpu(): CoreRegs {
      regs.a = cpu.a; regs.b = cpu.b; regs.c = cpu.c; regs.d = cpu.d; regs.e = cpu.e;
      regs.f = cpu.f; regs.h = cpu.h; regs.l = cpu.l; regs.sp = cpu.sp; regs.pc = cpu.pc;
      return regs;
    },
    read,
    frame,
    get serial(): string { return serialText; },
    get cycles(): number { return cycles; },
    setButtons,
    snapshot,
    restore,
    tap,
  };
  return core as unknown as Core;
}

export const createCoreFn: CreateCore = createCore;
void createCoreFn;
void (null as unknown as Handlers);
