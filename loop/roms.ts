// ROM lookup by content hash, for incidents and traces that name a ROM by rom_sha (SPEC §6.5).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../oracle/client.ts";

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
