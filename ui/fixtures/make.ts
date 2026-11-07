// Writes the UI fixtures: a small ledger (ui/fixtures/ledger/) and one incident's evidence PNGs
// (ui/fixtures/evidence/incidents/INC-0001/). Run: node ui/fixtures/make.ts. The values are fixtures and enter no figure.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeGrey, SHADE_GREY } from "./png.ts";
import { testPattern, LCD_W, LCD_H } from "./core.ts";
import type { Incident, Attempt, Verdict, ProvenanceEntry, Fire, StatusRecord } from "../../src/schema.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const ledger = join(here, "ledger");
const inc = join(here, "evidence", "incidents", "INC-0001");
mkdirSync(ledger, { recursive: true });
mkdirSync(inc, { recursive: true });

// Evidence: the core frame lacks an 8-line band of the block that the oracle frame draws.
const coreShades = new Uint8Array(LCD_W * LCD_H);
const oracleShades = new Uint8Array(LCD_W * LCD_H);
testPattern(coreShades, 300, 40, 40);
testPattern(oracleShades, 300, 40, 40);
for (let y = 48; y < 56; y++) for (let x = 40; x < 56; x++) coreShades[y * LCD_W + x] = 0;
const grey = (s: Uint8Array) => s.map((v) => SHADE_GREY[v]);
const diff = coreShades.map((v, i) => (v === oracleShades[i] ? 0 : 255));
writeFileSync(join(inc, "core.png"), encodeGrey(LCD_W, LCD_H, grey(coreShades)));
writeFileSync(join(inc, "oracle.png"), encodeGrey(LCD_W, LCD_H, grey(oracleShades)));
writeFileSync(join(inc, "diff.png"), encodeGrey(LCD_W, LCD_H, diff));
writeFileSync(join(inc, "window.json"), JSON.stringify({ window: [240, 420], counter: 300 }));
writeFileSync(join(inc, "regwrites.jsonl"), JSON.stringify({ addr: 0xff4a, value: 40, ly: 47, dot: 252, cycles: 21053440 }) + "\n");
const pixels = diff.reduce((n, v) => n + (v ? 1 : 0), 0);

const at = (m: number) => `2026-11-07T12:${String(m).padStart(2, "0")}:00Z`;
const incidents: (Incident | StatusRecord)[] = [
  { id: "INC-0001", at: at(1), run: null, kind: "frame", align: "counter", signature: { scene: 1, band: 6, bbox: [40, 48, 56, 56] },
    rom_sha: "fixture", trace_sha: "fixture", window: [240, 420], core_commit: "f1x7ure", counter: 300, pixels,
    files: { dir: "evidence/incidents/INC-0001" }, source: "play", narration: "The block loses its middle band as the window turns on.", status: "open" },
  { id: "INC-0002", at: at(9), run: null, kind: "frame", align: "frame", signature: { scene: 0, band: 0, bbox: [0, 0, 160, 8] },
    rom_sha: "fixture", trace_sha: "fixture", window: [0, 120], core_commit: "f1x7ure", counter: 60, pixels: 1280,
    files: { dir: "evidence/incidents/INC-0002" }, source: "suite", status: "open" },
  { t: "status", id: "INC-0001", field: "status", value: "repaired", at: at(30), run: null },
];
const isolation = { home: "/tmp/fixture", skills_list: "", observers: "off" as const, web_tools: "off" as const };
const attempts: Attempt[] = [
  { id: "ATT-0001", at: at(10), run: null, task: { kind: "incident", incident: "INC-0001", base_commit: "f1x7ure", arm: "fast", skills: [], budget: { max_steps: 60, wall_s: 600 } },
    branch: "att/ATT-0001", head_commit: "a11ce01", model: "fixture-model", fires: [], spent: { steps: 12, wall_s: 140, tokens_in: 1, tokens_out: 1, usd: 0 },
    scratch_files: [], isolation, result: { dispositions: {}, off_map: null, beliefs: [], summary: "Delays the fetcher by a constant." } },
  { id: "ATT-0002", at: at(20), run: null, task: { kind: "incident", incident: "INC-0001", base_commit: "f1x7ure", arm: "fast", skills: ["SKL-0002"], budget: { max_steps: 60, wall_s: 600 } },
    branch: "att/ATT-0002", head_commit: "b0b0b02", model: "fixture-model", fires: ["FIR-0001"], spent: { steps: 20, wall_s: 210, tokens_in: 1, tokens_out: 1, usd: 0 },
    scratch_files: [], isolation, result: { dispositions: { "SKL-0002": "applied" }, off_map: null, beliefs: [], summary: "Restarts the fetcher on window trigger." } },
];
const h = (family: string, pixel_match: number) => ({ split: "H" as const, family, roms: 8, pass: 5, exact: 2, pixel_match });
const verdicts: Verdict[] = [
  { id: "VER-0001", at: at(12), run: null, subject: { kind: "attempt", id: "ATT-0001" }, decision: "REFUSE",
    checks: [{ name: "diff-scope", pass: true, reading: "core/ppu.ts" }, { name: "repro", pass: true, reading: "clean" },
      { name: "admitted-traces", pass: true, reading: "0/0 dirty" }, { name: "base-suites", pass: true, reading: [{ split: "base", family: "blargg:cpu_instrs", roms: 11, pass: 11, exact: 0, pixel_match: 1 }] },
      { name: "H-no-regress", pass: false, reading: [h("mealybug:window", 0.912)] }],
    reason: "H-no-regress: mealybug:window mean pixel match fell below the tolerance", residue: ["audio", "CGB"], rule_version: "fixture" },
  { id: "VER-0002", at: at(29), run: null, subject: { kind: "attempt", id: "ATT-0002" }, decision: "GRADUATE",
    checks: [{ name: "diff-scope", pass: true, reading: "core/ppu.ts" }, { name: "repro", pass: true, reading: "clean" },
      { name: "admitted-traces", pass: true, reading: "0/0 dirty" }, { name: "base-suites", pass: true, reading: "no regress" },
      { name: "H-no-regress", pass: true, reading: [h("mealybug:window", 0.951), { split: "H", family: "mooneye:ppu", roms: 6, pass: 4, exact: 4, pixel_match: 0.97 }, { split: "T", family: "mooneye:timer", roms: 5, pass: 3, exact: 3, pixel_match: 0.9 }] }],
    reason: "all checks pass; repro clean on window 240…420", residue: ["audio", "V (sealed)"], rule_version: "fixture" },
  { id: "VER-0003", at: at(40), run: null, subject: { kind: "skill", id: "SKL-0002" }, decision: "REFUSE",
    checks: [{ name: "trial-margin", pass: false, reading: { "mealybug:window": 0.4, "mooneye:ppu": 0 } }],
    arms: { candidate: [h("mealybug:window", 0.95)], baseline: [h("mealybug:window", 0.946)], placebo: [h("mealybug:window", 0.94)],
      margin: { "mealybug:window": 0.4, "mooneye:ppu": 0 }, n_family_runs_per_arm: 2 },
    reason: "trial-margin: mealybug:window candidate − max(baseline, placebo) is below MARGIN_FLOOR", residue: ["V (sealed)"], rule_version: "fixture" },
];
const fires: Fire[] = [{ id: "FIR-0001", at: at(20), run: null, skill: "SKL-0002", attempt: "ATT-0002", path: "core/ppu.ts", owed: "restart the fetcher" }];
const provenance: ProvenanceEntry[] = [
  { handler: "ppu.fetcher", file: "core/ppu.ts", commit: "b0b0b02", attempt: "ATT-0002", skill: "SKL-0002" },
  { handler: "ppu.fifo", file: "core/ppu.ts", commit: "b0b0b02", attempt: "ATT-0002", skill: "SKL-0002" },
  { handler: "cpu.op", file: "core/cpu.ts", commit: "f1x7ure" },
  { handler: "timer", file: "core/timer.ts", commit: "f1x7ure" },
];

const jsonl = (rs: unknown[]) => rs.map((r) => JSON.stringify(r)).join("\n") + "\n";
writeFileSync(join(ledger, "incidents.jsonl"), jsonl(incidents));
writeFileSync(join(ledger, "attempts.jsonl"), jsonl(attempts));
writeFileSync(join(ledger, "verdicts.jsonl"), jsonl(verdicts));
writeFileSync(join(ledger, "fires.jsonl"), jsonl(fires));
writeFileSync(join(ledger, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
console.log(`fixtures written: ${ledger}, ${inc} (${pixels} differing pixels)`);
