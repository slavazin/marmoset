// Identical starting conditions (S22): one machine state both sides start from. The oracle runs a fixed input
// prefix from zeroed power-on RAM (oracle/frontend.py RAM_INIT "zero"), saves its own state, and reports the
// machine as its BESS footer states it (op `machine`). The core's side is that machine, written into the core's
// own snapshot format and loaded with core.restore; the oracle's side is its saved state, restored with
// `rebase` so frame-align counters count from the start. The start file lives in the cache, never in git: it
// holds the ROM's RAM and VRAM. Truth-maker: lockstep/start-state.test.ts.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Core, CreateCore, TraceInput } from "../src/schema.ts";
import { OracleClient, ratchetCache, sha256 } from "../oracle/client.ts";

/** The machine state oracle/frontend.py op `machine` returns (SameBoy BESS.md, CORE and MBC blocks). */
export interface Machine {
  model: string; pc: number; af: number; bc: number; de: number; hl: number; sp: number;
  ime: number; ie: number; exec: number; mbc: [number, number][];
  io_b64: string; wram_b64: string; vram_b64: string; cart_ram_b64: string; oam_b64: string; hram_b64: string;
}

/** What a start state is built from; its sha (startKey) names the cache file. */
export interface StartSpec { rom_sha: string; prefix: TraceInput[]; frames: number; ram_init: "zero" }

/** The cache file: $RATCHET_CACHE/start/<rom_sha>/<key>.json. */
export interface StartState { spec: StartSpec; key: string; oracle_state_b64: string; machine: Machine }

/** LY at the frame boundary both sides stop on: core runFrame ends at LY 144 (SPEC §6.1), SameBoy's retro_run at its VBlank. */
export const BOUNDARY_LY = 144;

export function startKey(spec: StartSpec): string {
  return sha256(JSON.stringify({ rom_sha: spec.rom_sha, prefix: spec.prefix, frames: spec.frames, ram_init: spec.ram_init })).slice(0, 16);
}

export function startPath(spec: StartSpec, cache = ratchetCache()): string {
  return join(cache, "start", spec.rom_sha, `${startKey(spec)}.json`);
}

/** Runs the prefix on a fresh oracle and writes the start file; returns it. Reuses a cached file with the same key. */
export async function buildStartState(romPath: string, spec: Omit<StartSpec, "rom_sha">, cache = ratchetCache()): Promise<StartState> {
  const rom_sha = sha256(new Uint8Array(readFileSync(romPath)));
  const full: StartSpec = { rom_sha, ...spec };
  const file = startPath(full, cache);
  if (existsSync(file)) return readStartState(file, rom_sha);
  const oracle = OracleClient.spawn();
  try {
    await oracle.load(romPath, "frame", "DMG", full.ram_init);
    const r = await oracle.runToCounter(full.frames, full.prefix);
    if (r.stalled || r.counter !== full.frames) throw new Error(`oracle did not reach frame ${full.frames} (at ${r.counter})`);
    const st: StartState = { spec: full, key: startKey(full), oracle_state_b64: await oracle.save(), machine: await oracle.machine() as unknown as Machine };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file + ".tmp", JSON.stringify(st));
    renameSync(file + ".tmp", file);
    return st;
  } finally {
    await oracle.close();
  }
}

/** Reads a start file and refuses one whose ROM or key does not match what it states. */
export function readStartState(file: string, rom_sha: string): StartState {
  const st = JSON.parse(readFileSync(file, "utf8")) as StartState;
  if (st.spec.rom_sha !== rom_sha) throw new Error(`start state ${file} is for ROM ${st.spec.rom_sha.slice(0, 12)}, not ${rom_sha.slice(0, 12)}`);
  if (startKey(st.spec) !== st.key) throw new Error(`start state ${file} key does not match its spec`);
  return st;
}

/** The sha256 of the start file's bytes: what a run manifest records. */
export function startFileSha(file: string): string {
  return sha256(new Uint8Array(readFileSync(file)));
}

const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/** Snapshot magic core/index.ts writes ("DMG1"). */
const CORE_MAGIC = 0x444d4731;

/**
 * The machine in core/index.ts's snapshot layout (its snapshot() and restore()). PPU position: LY 144, dot 0,
 * mode 1, the point core runFrame stops at. Residue: BESS carries DIV as its upper byte only (internal divider
 * set to DIV << 8), and no window line counter (0; it resets at LY 0 before it is next read).
 */
export function coreSnapshotOf(m: Machine): Uint8Array {
  const io = b64(m.io_b64), wram = b64(m.wram_b64), vram = b64(m.vram_b64), oam = b64(m.oam_b64), hram = b64(m.hram_b64), cram = b64(m.cart_ram_b64);
  if (io[0x44] !== BOUNDARY_LY) throw new Error(`start machine LY is ${io[0x44]}, not ${BOUNDARY_LY}: not at a frame boundary`);
  if (wram.length !== 0x2000 || vram.length < 0x2000 || oam.length < 0xa0 || hram.length < 0x7f) throw new Error("start machine RAM sizes are not DMG sizes");
  const mbc = { ramOn: 0, lo: 1, hi: 0, mode: 0 };
  for (const [addr, v] of m.mbc) {
    if (addr < 0x2000) mbc.ramOn = (v & 0x0f) === 0x0a ? 1 : 0;
    else if (addr < 0x4000) mbc.lo = (v & 0x1f) || 1;
    else if (addr < 0x6000) mbc.hi = v & 0x03;
    else if (addr < 0x8000) mbc.mode = v & 0x01;
  }
  const lyc = io[0x45], lcdc = io[0x40];
  const stat = (io[0x41] & 0x78) | (BOUNDARY_LY === lyc ? 0x04 : 0) | 1;
  const statLine = (lcdc & 0x80) !== 0 && ((stat & 0x40 && stat & 0x04) || (stat & 0x10)) ? 1 : 0;
  const tac = (io[0x07] & 0x07) | 0xf8;
  const div = io[0x04] << 8;
  const bit = [9, 3, 5, 7][tac & 3];
  const prevAnd = ((div >> bit) & 1) & ((tac >> 2) & 1);
  const out: number[] = [];
  const u8 = (v: number) => out.push(v & 0xff);
  const u16 = (v: number) => { u8(v); u8(v >> 8); };
  const u32 = (v: number) => { u16(v); u16(v >>> 16); };
  const bytes = (b: Uint8Array) => { for (const x of b) out.push(x); };
  out.push(0x44, 0x4d, 0x47, 0x31);
  u8(m.af >> 8); u8(m.bc >> 8); u8(m.bc); u8(m.de >> 8); u8(m.de); u8(m.af & 0xf0); u8(m.hl >> 8); u8(m.hl);
  u16(m.sp); u16(m.pc);
  u8(m.ime ? 1 : 0); u8(0); u8(m.exec === 1 ? 1 : 0); u8(0);
  u16(div);
  u8(io[0x05]); u8(io[0x06]); u8(tac); u8(prevAnd); u8(0);
  u8(0xe0 | (io[0x0f] & 0x1f)); u8(m.ie);
  u8(0xc0 | (io[0x00] & 0x30) | 0x0f); u8(0); u8(io[0x01]); u8(io[0x02]);
  u16(0);
  u8(0); u8(0); u8(0); u8(0);
  u32(cram.length); bytes(cram);
  u8(mbc.ramOn); u8(mbc.lo); u8(mbc.hi); u8(mbc.mode);
  bytes(wram);
  const h = new Uint8Array(0x80); h.set(hram.subarray(0, 0x7f)); bytes(h);
  const audio = new Uint8Array(0x40); audio.set(io.subarray(0x10, 0x40), 0x10); bytes(audio);
  bytes(vram.subarray(0, 0x2000));
  bytes(oam.subarray(0, 0xa0));
  bytes(new Uint8Array(160 * 144));
  u8(lcdc); u8(stat); u8(io[0x42]); u8(io[0x43]); u8(BOUNDARY_LY); u8(lyc); u8(io[0x47]); u8(io[0x48]);
  u8(io[0x49]); u8(io[0x4a]); u8(io[0x4b]); u8(1);
  u16(0); u8(0); u8(statLine); u16(172); u32(0); u32(0);
  const snap = new Uint8Array(out);
  if (new DataView(snap.buffer).getUint32(0) !== CORE_MAGIC) throw new Error("snapshot magic");
  return snap;
}

/**
 * Loads the machine into a core and reads it back through the core's own bus: registers, WRAM, VRAM, OAM, HRAM
 * and the PPU registers must equal the machine's. Throws on any difference, so a core whose snapshot layout
 * differs from coreSnapshotOf refuses the start state instead of starting from a garbled one.
 */
export function loadIntoCore(core: Core, m: Machine): void {
  core.restore(coreSnapshotOf(m));
  const io = b64(m.io_b64), wram = b64(m.wram_b64), vram = b64(m.vram_b64), oam = b64(m.oam_b64), hram = b64(m.hram_b64);
  const r = core.cpu;
  const want = { a: m.af >> 8, f: m.af & 0xf0, b: m.bc >> 8, c: m.bc & 0xff, d: m.de >> 8, e: m.de & 0xff, h: m.hl >> 8, l: m.hl & 0xff, sp: m.sp, pc: m.pc };
  for (const [k, v] of Object.entries(want)) if ((r as unknown as Record<string, number>)[k] !== v) throw new Error(`start state: core register ${k} reads ${(r as unknown as Record<string, number>)[k]}, machine ${v}`);
  const check = (base: number, data: Uint8Array, len: number, what: string) => {
    for (let i = 0; i < len; i++) if ((core.read(base + i) & 0xff) !== data[i]) throw new Error(`start state: core ${what} at 0x${(base + i).toString(16)} differs`);
  };
  check(0xc000, wram, 0x2000, "WRAM");
  check(0x8000, vram, 0x2000, "VRAM");
  check(0xfe00, oam, 0xa0, "OAM");
  check(0xff80, hram, 0x7f, "HRAM");
  for (const a of [0x40, 0x42, 0x43, 0x45, 0x47, 0x48, 0x49, 0x4a, 0x4b, 0x05, 0x06]) check(0xff00 + a, io.subarray(a), 1, "IO");
  if ((core.read(0xff44) & 0xff) !== BOUNDARY_LY) throw new Error("start state: core LY is not at the boundary");
  if ((core.read(0xffff) & 0xff) !== m.ie) throw new Error("start state: core IE differs");
}

/** A CreateCore whose every core starts from the start state's machine. */
export function withStart(createCore: CreateCore, st: StartState): CreateCore {
  return (rom: Uint8Array) => {
    if (sha256(rom) !== st.spec.rom_sha) throw new Error("start state is for another ROM");
    const core = createCore(rom);
    loadIntoCore(core, st.machine);
    return core;
  };
}

/** Oracle frames from a start state are cached apart from power-on frames of the same trace. */
export function startDirSuffix(st: Pick<StartState, "key"> | null | undefined): string {
  return st ? `@start-${st.key}` : "";
}
