// The games registry (games.json at the repository root, S22): which ROMs Ratchet plays and how lockstep reads
// each. A ROM is selected by its sha256, never by its name or path: gameBySha hashes what it is handed.
//   contract "s6.17": the game writes SPEC §6.17's RAM contract; lockstep compares GAME_RAM and reads the scene
//     at 0xC0F2 (lockstep/diff.ts), as every ROM outside the registry is read.
//   contract "map": the entry's `map` names the bytes lockstep compares (`logic`), the scene byte, and the frame
//     counter for align "counter" (null: align "frame"). Each address cites its evidence file.
// `ram_init` is the oracle's power-on RAM (oracle/frontend.py RAM_INIT); `start`, when set, is the input prefix
// and frame count that lockstep/start-state.ts builds both sides' start from. A ROM file outside the repository
// is found through the entry's env variable or under $RATCHET_CACHE/<cache_path>, and is never committed.
// Truth-maker: lockstep/games.test.ts.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TraceInput } from "../src/schema.ts";
import { ratchetCache, sha256 } from "../oracle/client.ts";
import type { RamInit } from "../oracle/client.ts";
import { GAME_RAM, SCENE_OFFSET } from "./diff.ts";

export const REGISTRY = resolve(import.meta.dirname, "..", "games.json");

export interface Range { name?: string; addr: number; len: number }

/** What lockstep compares and where it reads the scene and counter. */
export interface GameMap { counter: number | null; scene: { addr: number; names?: Record<string, string> }; logic: Range[]; evidence?: string }

export interface GameEntry {
  id: string; title: string;
  rom: { repo_path?: string; env?: string; cache_path?: string; sha256: string };
  contract: "s6.17" | "map";
  align: "counter" | "frame";
  ram_init: RamInit;
  map: GameMap | null;
  /** The start state every run and window on this game uses; `at` says where it leaves the game (loop/game-trace.ts reads it). */
  start: GameStart | null;
  /** Further registered start states, by name; lockstep and the gate use `start` alone. */
  other_starts?: Record<string, GameStart>;
}

export interface GameStart { at: "title" | "play"; frames: number; prefix: TraceInput[] }

/** SPEC §6.17's map: GAME_RAM compared whole, the scene at 0xC0F2, the counter at 0xC0F0. */
export const CONTRACT_MAP: GameMap = { counter: GAME_RAM.addr, scene: { addr: GAME_RAM.addr + SCENE_OFFSET }, logic: [{ addr: GAME_RAM.addr, len: GAME_RAM.len }] };

/** WRAM bounds: the oracle reads game-state bytes through op `ram`, which reads WRAM only (SPEC §6.4). */
const WRAM = [0xc000, 0xe000] as const;

export function readRegistry(file = REGISTRY): GameEntry[] {
  const games = (JSON.parse(readFileSync(file, "utf8")) as { games: GameEntry[] }).games;
  const ids = new Set<string>(), shas = new Set<string>();
  for (const g of games) {
    if (ids.has(g.id) || shas.has(g.rom.sha256)) throw new Error(`games registry: duplicate id or sha (${g.id})`);
    ids.add(g.id); shas.add(g.rom.sha256);
    if (!/^[0-9a-f]{64}$/.test(g.rom.sha256)) throw new Error(`games registry: ${g.id} sha256 is not a sha256`);
    if (g.contract === "map" && !g.map) throw new Error(`games registry: ${g.id} has contract map and no map`);
    if (g.contract === "s6.17" && g.map) throw new Error(`games registry: ${g.id} has contract s6.17 and a map`);
    for (const s of [g.start, ...Object.values(g.other_starts ?? {})]) {
      if (s && s.at !== "title" && s.at !== "play") throw new Error(`games registry: ${g.id} start at ${String(s.at)}: want title or play`);
    }
    if (g.start && g.ram_init !== "zero") throw new Error(`games registry: ${g.id} has a start state and ram_init ${g.ram_init}; a start state is built from zeroed RAM`);
    if (g.map) {
      if (sceneOffset(g.map) < 0) throw new Error(`games registry: ${g.id} scene byte is outside its logic ranges`);
      if ((g.map.counter === null) !== (g.align === "frame")) throw new Error(`games registry: ${g.id} align ${g.align} disagrees with its counter`);
      for (const r of [...g.map.logic, { addr: g.map.scene.addr, len: 1 }, ...(g.map.counter === null ? [] : [{ addr: g.map.counter, len: 2 }])]) {
        if (r.addr < WRAM[0] || r.addr + r.len > WRAM[1] || r.len < 1) throw new Error(`games registry: ${g.id} address 0x${r.addr.toString(16)} is outside WRAM`);
      }
    }
  }
  return games;
}

/** The entry whose sha256 is the sha of `rom`'s bytes, or null when the ROM is not registered. */
export function gameBySha(rom: Uint8Array, games = readRegistry()): GameEntry | null {
  const s = sha256(rom);
  return games.find((g) => g.rom.sha256 === s) ?? null;
}

export function gameById(id: string, games = readRegistry()): GameEntry {
  const g = games.find((e) => e.id === id);
  if (!g) throw new Error(`games registry: no game ${id}`);
  return g;
}

/** The ROM file for an entry: env variable, then repository path, then cache path. Throws unless its bytes hash to the entry's sha. */
export function romPathOf(g: GameEntry, root = resolve(import.meta.dirname, "..")): string {
  const tries = [g.rom.env ? process.env[g.rom.env] : undefined, g.rom.repo_path ? join(root, g.rom.repo_path) : undefined, g.rom.cache_path ? join(ratchetCache(), g.rom.cache_path) : undefined];
  for (const p of tries) {
    if (!p || !existsSync(p)) continue;
    const real = realpathSync(p);
    if (sha256(new Uint8Array(readFileSync(real))) !== g.rom.sha256) throw new Error(`games registry: ${p} does not hash to ${g.id}'s sha256`);
    return real;
  }
  throw new Error(`games registry: no ROM file for ${g.id}`);
}

/** The map lockstep reads for a ROM: its entry's map, or SPEC §6.17's for a contract entry and an unregistered ROM. */
export function mapOf(g: GameEntry | null): GameMap {
  return g?.map ?? CONTRACT_MAP;
}

/** The mapped game-state bytes, concatenated in `logic` order, through a side-effect-free read. */
export function mappedRam(map: GameMap, read: (addr: number) => number): Uint8Array {
  const out = new Uint8Array(map.logic.reduce((s, r) => s + r.len, 0));
  let o = 0;
  for (const r of map.logic) for (let i = 0; i < r.len; i++) out[o++] = read(r.addr + i) & 0xff;
  return out;
}

/** Offset of the scene byte inside mappedRam's bytes, or -1 when no logic range holds it. */
export function sceneOffset(map: GameMap): number {
  let o = 0;
  for (const r of map.logic) {
    if (map.scene.addr >= r.addr && map.scene.addr < r.addr + r.len) return o + map.scene.addr - r.addr;
    o += r.len;
  }
  return -1;
}
