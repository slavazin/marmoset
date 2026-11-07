// Fixtures for the slow-loop tests: fast-arm attempts and observations in a bed's ledger, a fake consolidator reply,
// a fake runner that marks its arm and shown skills in core/arm.txt, and a judge that scores from that mark.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { append } from "../ledger.ts";
import type { Bed } from "./harness.ts";
import type { LlmCall, Llm, ChatRequest } from "../llm.ts";
import type { MuseRunner, MuseRun } from "../repair.ts";
import type { TrialJudge } from "../trial.ts";
import type { Attempt, Observation, SuiteReading } from "../../src/schema.ts";

/** Appends 5 fast attempts and their observations: OBS-0001/2 and OBS-0003/4 share two shapes; OBS-0005 is noise. */
export function seedObservations(bed: Bed, extra: { offMap?: string; text?: string } = {}): void {
  for (let i = 1; i <= 5; i++) {
    const id = `ATT-${String(i).padStart(4, "0")}`;
    const att: Attempt = {
      id, at: "2026-11-07T00:00:00.000Z", run: null, branch: `attempt/${id}`, model: "fake", fires: [],
      task: { kind: "incident", incident: `INC-010${i}`, base_commit: "x", arm: "fast", skills: i === 2 ? ["SKL-0009"] : [], budget: { max_steps: 1, wall_s: 1 } },
      result: { dispositions: i === 2 ? { "SKL-0009": "considered-not-applicable" } : {}, off_map: i === 3 ? (extra.offMap ?? "Counting fetcher steps per tile fixed the shift.") : null, beliefs: [], summary: "s" },
      spent: { steps: 0, wall_s: 0, tokens_in: 0, tokens_out: 0, usd: 0 }, scratch_files: [], isolation: { home: "", skills_list: "", observers: "off", web_tools: "off" },
    };
    append("attempts.jsonl", att, bed.paths.ledger);
    const obs: Observation = { id: `OBS-${String(i).padStart(4, "0")}`, at: "2026-11-07T00:00:00.000Z", run: null, anchor: { incident: `INC-010${i}`, attempt: id, counter: 4 },
      text: i === 1 && extra.text ? extra.text : `A frame divergence in scene 1, line band ${i}, was refused at repro after a repair that shifted tiles.` };
    append("observations.jsonl", obs, bed.paths.ledger);
  }
}

export function nomination(name: string, shape: string, anchors: string[]) {
  return {
    name, shape, anchors, fires_when: "a mode-3 divergence whose diff is a horizontal shift of whole tiles", not_this: "single-pixel edge errors; palette-only differences",
    paths: ["core/ppu*.ts"], owed: "run node tools/replay.mjs --family mealybug:palette-scroll-bg --core-dir core --roms packet/roms.json before writing RESULT.json",
    do: "Derive mode-3 length from the fetcher's modelled steps, one step per dot, so a scroll or window start lengthens mode 3 by the steps it adds.",
    dont: "Don't add a constant startup delay that fits one test (OBS-0002: the shift moved, the repro still failed).",
    false_if: "a repair passes the train family by adding a constant mode-3 delay", checked_by: ["admitted-traces", "H-no-regress"],
    residue: "does not check sprite stall lengths", retire_when: "moot: the scanline renderer is gone",
  };
}

export const REPLY = {
  triage: [
    { id: "OBS-0001", shape: "tile-shift", reducible: true }, { id: "OBS-0002", shape: "tile-shift", reducible: true },
    { id: "OBS-0003", shape: "palette-latch", reducible: true }, { id: "OBS-0004", shape: "palette-latch", reducible: true },
    { id: "OBS-0005", shape: "replay-flake", reducible: false },
  ],
  nominations: [nomination("fetcher-steps-not-delays", "tile-shift", ["OBS-0001", "OBS-0002"]), { ...nomination("latch-palette-at-fetch", "palette-latch", ["OBS-0003", "OBS-0004"]), do: "Read BGP when the fetcher pushes each pixel to the FIFO, not when the scanline starts, so a mid-line BGP write recolours only the pixels pushed after it." }],
};

export function okCall(text: string): LlmCall {
  return { ok: true, text, reasoning: "", model_echoed: "muse-wonder-1.0", finish_reason: "stop", usage: { prompt: 100, completion: 50, reasoning: 20 }, wall_ms: 1, http_status: 200 };
}

export function fakeLlm(reply: unknown = REPLY): Llm & { reqs: ChatRequest[] } {
  const reqs: ChatRequest[] = [];
  const f = (async (r: ChatRequest) => { reqs.push(r); return okCall("```json\n" + JSON.stringify(reply) + "\n```"); }) as Llm & { reqs: ChatRequest[] };
  f.reqs = reqs;
  return f;
}

/** A runner writing core/arm.txt = "<arm> <shown skill ids>" from packet/task.json; `onRun` sees each run. */
export function markingRunner(onRun?: (r: MuseRun) => void): MuseRunner & { calls: MuseRun[] } {
  const calls: MuseRun[] = [];
  return {
    calls,
    async skillsList() { return "[]"; },
    async run(r) {
      calls.push(r);
      const task = JSON.parse(readFileSync(join(r.cwd, "packet", "task.json"), "utf8"));
      writeFileSync(join(r.cwd, "core", "arm.txt"), `${task.arm} ${task.skills.join(",")}\n`);
      writeFileSync(join(r.cwd, "packet", "RESULT.json"), JSON.stringify({ dispositions: Object.fromEntries(task.skills.map((s: string) => [s, "applied"])), off_map: null, beliefs: [], summary: "Marks the arm." }));
      onRun?.(r);
      return { exitCode: 0, model: "fake-muse", steps: 1, tokens_in: 0, tokens_out: 0, wall_s: 0 };
    },
  };
}

/** Scores high only for the candidate arm showing `winner`; every base reading is the same. */
export function markJudge(winner: string): TrialJudge & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async score(coreDir, split, family) {
      const mark = existsSync(join(coreDir, "arm.txt")) ? readFileSync(join(coreDir, "arm.txt"), "utf8") : "none";
      calls.push(`${split}:${family ?? "*"}:${mark.trim()}`);
      if (split === "base") return [{ split: "base", family: "blargg", roms: 15, pass: 15, exact: 15, pixel_match: 1 }];
      const win = mark.startsWith("candidate") && mark.includes(winner);
      const f = family!;
      const r: SuiteReading = f.startsWith("mealybug") ? { split: "H", family: f, roms: 10, pass: 0, exact: 0, pixel_match: win ? 0.9 : 0.5 } : { split: "H", family: f, roms: 12, pass: win ? 8 : 3, exact: win ? 8 : 3, pixel_match: 0 };
      return [r];
    },
  };
}
