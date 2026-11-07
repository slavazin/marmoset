// pnpm lockstep --rom <path> --trace <file.json> --core-dir <dir> [--align counter|frame] [--ledger <dir>]
// Runs lockstep (lockstep/lockstep.ts) over one trace (SPEC §6.5 Trace JSON). Incidents append to
// <ledger>/incidents.jsonl (default ledger/) through LedgerIncidentSink (loop/incident-sink.ts, appending via loop/ledger.ts)
// and their evidence goes to evidence/incidents/<id>/. --align overrides the trace's own align.
// Prints one JSON summary line. Exit 0 with no incident opened, 1 with any, 2 on a usage or oracle error.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Trace } from "../src/schema.ts";
import { loadCreateCore } from "./core-dir.ts";
import { LedgerIncidentSink } from "../loop/incident-sink.ts";
import { lockstep } from "./lockstep.ts";
import { processStart } from "../src/telemetry-process.ts"; processStart("lockstep");

const REPO = resolve(import.meta.dirname, "..");

function commitOf(dir: string): string {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "unknown";
  }
}

async function main(): Promise<number> {
  const { values: v } = parseArgs({
    options: { rom: { type: "string" }, trace: { type: "string" }, "core-dir": { type: "string" }, align: { type: "string" }, ledger: { type: "string" } },
  });
  if (!v.rom || !v.trace || !v["core-dir"] || (v.align && v.align !== "counter" && v.align !== "frame")) {
    console.error("usage: lockstep/run.ts --rom <path> --trace <file.json> --core-dir <dir> [--align counter|frame] [--ledger <dir>]");
    return 2;
  }
  const trace = JSON.parse(readFileSync(v.trace, "utf8")) as Trace;
  const align = (v.align as Trace["align"] | undefined) ?? trace.align;
  const res = await lockstep({
    romPath: v.rom, trace: { ...trace, align }, createCore: await loadCreateCore(v["core-dir"]),
    coreCommit: commitOf(v["core-dir"]), sink: new LedgerIncidentSink(v.ledger ?? resolve(REPO, "ledger")),
    source: trace.source === "sabotage" ? "sabotage" : "play", run: process.env.RATCHET_RUN ?? null,
  });
  console.log(JSON.stringify({ compared: res.compared, opened: res.opened.map((i) => i.id), known: res.known, stopped: res.stopped, fps: Math.round(res.fps) }));
  return res.opened.length ? 1 : 0;
}

try {
  process.exitCode = await main();
} catch (e) {
  console.error(String(e instanceof Error ? e.message : e));
  process.exitCode = 2;
}
