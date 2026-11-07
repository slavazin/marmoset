// pnpm replay (tools/replay.mjs, bundled from this file by lockstep/build-replay.ts; it needs no oracle and no
// node_modules, and carries the S2 scorer):
//   --incident <id> --core-dir <dir> [--evidence-dir <dir>] [--rom <path>]
//       reruns the incident's window n-60…n+120 against the cached oracle frames; prints the first
//       mismatching counter or "clean". A suite incident reruns its ROM; it prints "clean" when the ROM passes.
//   --trace <id> --core-dir <dir> --rom <path> [--traces-dir <dir>]
//       the same for an admitted trace traces/<id>.json, counters max(1, first from_counter)…counter_end.
//   --family <name> --core-dir <dir> --roms <file.json> [--split T|H|V]
//       scores one family on the ROM list file: a JSON array of paths under $RATCHET_ROMS, an object
//       { roms: [...] }, or { families: { <name>: [...] } }; prints the SuiteReading as JSON.
// A ROM whose sha is not the incident's or trace's is refused. A core that stalls anywhere up to the window's
// end is a mismatch. Exit 0 clean (or scored), 1 mismatch, 2 usage, missing data or wrong ROM.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Split, Trace } from "../src/schema.ts";
import { romsDir } from "../suites/splits.ts";
import { sha256 } from "../oracle/client.ts";
import { loadCreateCore } from "../lockstep/core-dir.ts";
import { EVIDENCE_ROOT, readWindow } from "../lockstep/evidence.ts";
import { defaultOracleDir, formatOutcome, replayFrames, replaySuite, scoreRomList } from "../lockstep/replay.ts";
import { readStartState, startDirSuffix } from "../lockstep/start-state.ts";

const REPO = resolve(import.meta.dirname, "..");

async function main(): Promise<number> {
  const { values: v } = parseArgs({
    options: {
      incident: { type: "string" }, trace: { type: "string" }, family: { type: "string" },
      "core-dir": { type: "string" }, "evidence-dir": { type: "string" }, rom: { type: "string" },
      "traces-dir": { type: "string" }, roms: { type: "string" }, split: { type: "string" },
    },
  });
  if (!v["core-dir"] || [v.incident, v.trace, v.family].filter(Boolean).length !== 1) {
    console.error("usage: replay (--incident <id> | --trace <id> --rom <path> | --family <name> --roms <file>) --core-dir <dir>");
    return 2;
  }
  const createCore = await loadCreateCore(v["core-dir"]);

  if (v.incident) {
    const w = readWindow(v["evidence-dir"] ?? join(EVIDENCE_ROOT, v.incident));
    if (w.kind === "suite") {
      const romPath = join(romsDir(), w.rom_rel);
      if (sha256(readFileSync(romPath)) !== w.incident.rom_sha) throw new Error(`${romPath} is not the incident's ROM (sha ${w.incident.rom_sha})`);
      const r = replaySuite(createCore, w, romsDir());
      console.log(r.clean ? "clean" : `fail: ${w.rom_rel} pixel match ${r.reading.pixel_match.toFixed(4)} (repro ${r.repro.pixel_match.toFixed(4)}) on ${w.model ?? "DMG"}: ${r.reading.detail}`.slice(0, 400));
      return r.clean ? 0 : 1;
    }
    const rom = new Uint8Array(readFileSync(v.rom ?? w.rom.path));
    if (sha256(rom) !== w.incident.rom_sha) throw new Error(`${v.rom ?? w.rom.path} is not the incident's ROM (sha ${w.incident.rom_sha})`);
    const computed = defaultOracleDir(rom, w.trace.align, w.trace.inputs) + startDirSuffix(w.start);
    // a window run from a start state replays from it; a start file missing or not of the window's sha is an error
    if (w.start && (!existsSync(w.start.file) || sha256(readFileSync(w.start.file)) !== w.start.sha)) throw new Error(`start state ${w.start.file} is missing or not sha ${w.start.sha.slice(0, 12)}`);
    const out = replayFrames(createCore, {
      rom, align: w.trace.align, inputs: w.trace.inputs, window: w.incident.window,
      oracleDir: existsSync(computed) ? computed : w.oracle_dir, oracleRam: w.oracle_ram,
      ...(w.map ? { logic: w.map.logic } : {}), ...(w.start ? { start: readStartState(w.start.file, w.incident.rom_sha) } : {}),
    });
    console.log(formatOutcome(out));
    return out.clean ? 0 : 1;
  }

  if (v.trace) {
    if (!v.rom) { console.error("--trace needs --rom"); return 2; }
    const trace = JSON.parse(readFileSync(join(v["traces-dir"] ?? join(REPO, "traces"), `${v.trace}.json`), "utf8")) as Trace;
    const first = Math.min(...trace.inputs.map((i) => i.from_counter), trace.counter_end);
    const rom = new Uint8Array(readFileSync(v.rom));
    if (sha256(rom) !== trace.rom_sha) throw new Error(`${v.rom} is not the trace's ROM (sha ${trace.rom_sha})`);
    const out = replayFrames(createCore, {
      rom, align: trace.align, inputs: trace.inputs, window: [Math.max(1, first), trace.counter_end],
    });
    console.log(formatOutcome(out));
    return out.clean ? 0 : 1;
  }

  if (!v.roms) { console.error("--family needs --roms"); return 2; }
  const list = JSON.parse(readFileSync(v.roms, "utf8")) as string[] | { roms?: string[]; families?: Record<string, string[]> };
  const roms = Array.isArray(list) ? list : list.families?.[v.family!] ?? list.roms;
  if (!roms) { console.error(`${v.roms}: no ROM list for ${v.family}`); return 2; }
  const reading = scoreRomList(createCore, (v.split ?? "T") as Split, v.family!, roms, romsDir(), undefined,
    (r) => console.error(`  ${r.rom}: ${r.outcome} (${r.detail})`));
  console.log(JSON.stringify(reading));
  return 0;
}

try {
  process.exitCode = await main();
} catch (e) {
  console.error(String(e instanceof Error ? e.message : e));
  process.exitCode = 2;
}
