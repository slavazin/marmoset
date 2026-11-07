// node scripts/game2-lockstep.ts [--core-dir core] [--frames 3000] [--seed 21] [--out evidence/s21]:
// one lockstep reading (lockstep/lockstep.ts) of game2/game2.gb on a core against the oracle under an explorer
// trace (player/explore.ts). Incidents go to an in-memory sink, never ledger/; their evidence goes to
// <out>/incidents/<id>/ and the summary to <out>/lockstep.json. Evidence for S21.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { sha256 } from "../oracle/client.ts";
import { explorerTrace } from "../player/explore.ts";
import { loadCreateCore } from "../lockstep/core-dir.ts";
import { MemoryIncidentSink } from "../lockstep/incidents.ts";
import { lockstep } from "../lockstep/lockstep.ts";
import { readPngShades } from "../oracle/png.ts";

const REPO = resolve(import.meta.dirname, "..");
const { values: v } = parseArgs({
  options: { rom: { type: "string" }, "core-dir": { type: "string" }, frames: { type: "string" }, seed: { type: "string" }, out: { type: "string" } },
});
const coreDir = resolve(v["core-dir"] ?? join(REPO, "core"));
const frames = Number(v.frames ?? 3000);
const seed = Number(v.seed ?? 21);
const out = resolve(v.out ?? join(REPO, "evidence", "s21"));
const rom = resolve(v.rom ?? join(REPO, "game2", "game2.gb"));
const rom_sha = sha256(readFileSync(rom));
const trace = explorerTrace({ rom_sha, frames, seed });
const scenes = new Map<number, number>();
const sink = new MemoryIncidentSink();
mkdirSync(out, { recursive: true });
const res = await lockstep({
  romPath: rom, trace, createCore: await loadCreateCore(coreDir), coreCommit: "core/ at slice/s21-game2 base",
  sink, evidenceRoot: join(out, "incidents"), source: "play", run: null,
  onCompared: (_n, _f, scene) => scenes.set(scene, (scenes.get(scene) ?? 0) + 1),
});
const summary = {
  rom: v.rom ?? "game2/game2.gb", rom_sha, seed, frames, compared: res.compared, stopped: res.stopped,
  compared_by_scene: Object.fromEntries(scenes),
  opened: res.opened.map((i) => ({ id: i.id, kind: i.kind, counter: i.counter, pixels: i.pixels, signature: i.signature, lines: diffLines(i.id) })),
  known: res.known,
};
/** The screen lines on which an incident's core.png and oracle.png differ, with the pixel count on each. */
function diffLines(id: string): Record<number, number> {
  const dir = join(out, "incidents", id);
  const a = readPngShades(join(dir, "core.png")).shades, b = readPngShades(join(dir, "oracle.png")).shades;
  const lines: Record<number, number> = {};
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) lines[Math.floor(i / 160)] = (lines[Math.floor(i / 160)] ?? 0) + 1;
  return lines;
}
writeFileSync(join(out, "lockstep.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({ compared: res.compared, opened: res.opened.length, stopped: res.stopped, scenes: summary.compared_by_scene }));
