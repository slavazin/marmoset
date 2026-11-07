// ROM lookup by content hash, for incidents and traces that name a ROM by rom_sha (SPEC §6.5).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256 } from "../oracle/client.ts";
import { gamePath, type LoopPaths } from "./paths.ts";
import { readRegistry, romPathOf } from "../lockstep/games.ts";

/**
 * The directories an incident's or trace's ROM is looked up in: the suite ROMs, <root>/game, the directory of the
 * run's game (loop/paths.ts gamePath; RATCHET_GAME), and the directory of every games-registry ROM file found outside
 * the repository (lockstep/games.ts romPathOf: env variable or $RATCHET_CACHE/<cache_path>), each once
 * (loop/campaign-cgb.test.ts "romDirs"; lockstep/games.test.ts "romDirs").
 */
export function romDirs(paths: LoopPaths): string[] {
  const reg: string[] = [];
  for (const g of readRegistry()) {
    if (g.rom.repo_path) continue;
    try { reg.push(dirname(romPathOf(g, paths.root))); } catch { /* the ROM file is absent here: nothing to search */ }
  }
  return [...new Set([paths.roms, join(paths.root, "game"), dirname(gamePath(paths)), ...reg])];
}

const memo = new Map<string, string>();

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.gbc?$/i.test(e)) out.push(p);
  }
}

/** The first `.gb`/`.gbc` file under `dirs` whose sha256 is `sha`; throws when none is. */
export function romBySha(sha: string, dirs: string[]): string {
  const hit = memo.get(sha);
  if (hit && existsSync(hit)) return hit;
  for (const d of dirs) {
    const files: string[] = [];
    walk(d, files);
    for (const f of files) {
      const s = sha256(readFileSync(f));
      memo.set(s, f);
      if (s === sha) return f;
    }
  }
  throw new Error(`no ROM with sha256 ${sha.slice(0, 12)} under ${dirs.join(", ")}`);
}
