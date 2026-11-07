// node scripts/game2-shots.ts [--out <dir>] [--seed <n>]: runs game2/game2.gb on the oracle (oracle/frontend.py)
// under an explorer trace (player/explore.ts) and writes the title and play-scene frames as PNG, printing the
// §6.17 RAM each one read. Evidence for S21 (evidence/s21/).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { OracleClient, sha256 } from "../oracle/client.ts";
import { explorerTrace } from "../player/explore.ts";
import { decodeState, shadesToPng } from "../player/game.ts";

const REPO = resolve(import.meta.dirname, "..");
/** Title counter, shot with no input, after the title card's WX slide ends (80 frames from 166 by 2). */
export const TITLE_AT = 100;
/** Play counters, shot under the explorer trace: sector 1, and sector 2 (SCENE_FRAMES 900 in game2/src/main.c). */
export const SHOT_COUNTERS = { sector1: 400, sector2: 1500 } as const;

const { values: v } = parseArgs({ options: { out: { type: "string" }, seed: { type: "string" } } });
const out = resolve(v.out ?? join(REPO, "evidence", "s21"));
const rom = join(REPO, "game2", "game2.gb");
const trace = explorerTrace({ rom_sha: sha256(readFileSync(rom)), frames: 2000, seed: Number(v.seed ?? 21) });
mkdirSync(out, { recursive: true });
const o = OracleClient.spawn();
try {
  await o.load(rom, "counter");
  await shot("title", TITLE_AT, []);
  await o.load(rom, "counter");
  for (const [name, n] of Object.entries(SHOT_COUNTERS)) await shot(name, n, trace.inputs);
} finally {
  await o.close();
}

async function shot(name: string, n: number, inputs: typeof trace.inputs): Promise<void> {
  const r = await o.runToCounter(n, inputs);
  if (r.stalled) throw new Error(`oracle stalled at ${r.counter}`);
  const s = decodeState(await o.ram(0xc0f0, 7));
  writeFileSync(join(out, `oracle-${name}.png`), shadesToPng(await o.frame()));
  console.log(JSON.stringify({ shot: name, ...s }));
}
