// pnpm suites --core-dir <dir> --split <base|T|H|V> [--family f] [--cgb] [--json]
// Imports createCore from <dir>/index.ts and scores it with scoreFamilies (suites/score.ts).
// --cgb scores splits-cgb.json's families (CGB tier, D-0019) in place of splits.json's.
// --json prints SuiteReading[] (SPEC §6.8) on stdout; without it, one line per family. Per-ROM lines go to stderr.
// Exit 2 when split V is refused (no matching RATCHET_VREAD_TOKEN), 1 on a usage or reference-load error.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { CreateCore, Split } from "../src/schema.ts";
import { scoreFamilies, VReadRefused } from "./score.ts";
import { loadSplits, SPLITS_CGB_PATH } from "./splits.ts";

const SPLITS: Split[] = ["base", "T", "H", "V"];

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      "core-dir": { type: "string" }, split: { type: "string" }, family: { type: "string" }, json: { type: "boolean", default: false },
      cgb: { type: "boolean", default: false },
    },
  });
  const split = values.split as Split | undefined;
  if (!values["core-dir"] || !split || !SPLITS.includes(split)) {
    console.error("usage: suites/run.ts --core-dir <dir> --split <base|T|H|V> [--family f] [--cgb] [--json]");
    return 1;
  }
  const mod = (await import(pathToFileURL(resolve(values["core-dir"], "index.ts")).href)) as { createCore: CreateCore };
  try {
    const readings = scoreFamilies(mod.createCore, {
      split, family: values.family, splits: values.cgb ? loadSplits(SPLITS_CGB_PATH) : undefined,
      onRom: (fam, r) => console.error(`  ${fam} ${r.rom}: ${r.outcome} (${r.detail})`),
    });
    if (values.json) console.log(JSON.stringify(readings, null, 2));
    else for (const r of readings) console.log(`${r.family} ${r.pass}/${r.roms}, pixel match ${(r.pixel_match * 100).toFixed(1)}%`);
    return 0;
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e));
    return e instanceof VReadRefused ? 2 : 1;
  }
}

process.exitCode = await main();
