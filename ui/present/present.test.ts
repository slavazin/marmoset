import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as layout from "./layout.ts";
import * as units from "./units.ts";
import { stageFor, StageTracker, diagramSvg, STAGES } from "./diagram.ts";
import { historyTab, timelineRows } from "./history.ts";
import { evidenceHtml } from "./evidence.ts";
import { premiseTab, approachTab, preEventTab } from "./tabs.ts";
import { PRE_EVENT_LABEL } from "./pre-event-evidence.ts";
import { readHistory } from "../../server/history.ts";
import type { UiEvent, Verdict, Attempt } from "../../src/schema.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "..", "..");

/**
 * Helper modules that hold named geometry, timing and unit constants, and the one data file allowed to hold
 * pre-event figures (SPEC §1.4). Every other .ts file under ui/present/ is a template.
 */
const NOT_TEMPLATES = new Set(["layout.ts", "units.ts", "pre-event-evidence.ts"]);

/**
 * Numeric literals in a template after comments, imports and references are set aside. A reference names a
 * section or a record, never a figure: "§ 7.4", an id such as "D-0004" or "SKL-0002", and the event's "Track 1".
 */
export function templateLiterals(src: string): string[] {
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*import .*$/gm, "")
    .replace(/§\s?\d+(\.\d+)*/g, "§")
    .replace(/\b[A-Z]{1,4}-\d{4}\b/g, "ID")
    .replace(/\bTrack 1\b/g, "Track");
  return code.match(/(?<![\w$.])(?:0[xob][0-9a-f_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)n?(?![\w$])/gi) ?? [];
}

test("ui/present/** templates contain no numeric literal; only the named helpers and the pre-event data file do", () => {
  const files = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !NOT_TEMPLATES.has(f));
  assert.ok(files.length >= 5, "diagram, tabs, history, evidence and mount templates exist");
  for (const f of files) assert.deepEqual(templateLiterals(readFileSync(join(here, f), "utf8")), [], `${f} carries a numeric literal`);
});

test("the template literal grep flags a planted figure and passes references", () => {
  assert.deepEqual(templateLiterals("const s = `${v.pass} of 15 · GCE V2 § 7.4 · D-0004 · Track 1`;"), ["15"]);
  assert.deepEqual(templateLiterals("x = 0.951"), ["0.951"]);
});

test("every number layout.ts and units.ts export is named for a unit or a grid count", () => {
  for (const [name, v] of [...Object.entries(layout), ...Object.entries(units)]) {
    if (typeof v !== "number") continue;
    assert.match(name, /_(PX|MS|PLACES)$|^GRID_/, `${name} names its unit`);
  }
});

test("pre-event figures appear only in the pre-event tab: no other tab's HTML holds a figure from pre-event-evidence.ts", () => {
  const pre = preEventTab();
  assert.ok(pre.includes(PRE_EVENT_LABEL.replace("'", "&#39;")));
  assert.equal(PRE_EVENT_LABEL, "Pre-event evidence (measured 2026-11-06, not today's ledger)");
  for (const tell of ["99.8%", "499 of 500", "77% mean pixel match", "74.0%"]) {
    assert.ok(pre.includes(tell), `pre-event tab shows ${tell}`);
    for (const html of [premiseTab(), approachTab(diagramSvg({ stage: null, label: "" }), "")]) assert.ok(!html.includes(tell), `${tell} stays off other tabs`);
  }
  const templates = readdirSync(here).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "pre-event-evidence.ts");
  const importers = templates.filter((f) => readFileSync(join(here, f), "utf8").includes("PRE_EVENT_FACTS"));
  assert.deepEqual(importers, ["tabs.ts"], "only the tab template reads the pre-event figures");
});

const verdict = (decision: "GRADUATE" | "REFUSE", kind: "attempt" | "skill" = "attempt"): Verdict => ({
  id: "VER-0001", at: "t", run: null, subject: { kind, id: "ATT-0001" }, decision,
  checks: [{ name: "diff-scope", pass: true, reading: "" }, { name: "H-no-regress", pass: decision === "GRADUATE", reading: "x" }],
  reason: "r", residue: [], rule_version: "x",
});

test("stageFor maps a verdict to graduate or refuse with its deciding check, an attempt to packet or gate, a fire to hook", () => {
  assert.deepEqual([stageFor({ t: "verdict", verdict: verdict("REFUSE") })!.stage, stageFor({ t: "verdict", verdict: verdict("REFUSE") })!.check], ["refuse", "H-no-regress"]);
  assert.equal(stageFor({ t: "verdict", verdict: verdict("GRADUATE") })!.stage, "graduate");
  assert.equal(stageFor({ t: "verdict", verdict: verdict("REFUSE", "skill") })!.stage, "tombstone");
  const att = { id: "ATT-0001" } as Attempt;
  assert.equal(stageFor({ t: "attempt", attempt: att, phase: "start" })!.stage, "packet");
  assert.equal(stageFor({ t: "attempt", attempt: att, phase: "end" })!.stage, "gate");
  assert.equal(stageFor({ t: "fire", fire: { id: "FIR-0001", skill: "SKL-0002", attempt: "ATT-0001" } } as UiEvent)!.stage, "hook");
  for (const s of STAGES) assert.ok(diagramSvg({ stage: s.id, label: "" }).includes(`class="stage ${s.id} on"`), `${s.id} can be lit`);
});

test("StageTracker holds a verdict's stage against frame events for STAGE_HOLD_MS, then frames take the highlight back", () => {
  const t = new StageTracker();
  const frame: UiEvent = { t: "frame", source: "oracle", shades_b64: "", counter: layout.PAD_PX };
  t.push(frame, layout.ORIGIN_PX);
  assert.equal(t.lit.stage, "lockstep");
  assert.ok(t.push({ t: "verdict", verdict: verdict("REFUSE") }, layout.ORIGIN_PX));
  t.push(frame, layout.STAGE_HOLD_MS - layout.HEAD_PX);
  assert.equal(t.lit.stage, "refuse", "held");
  t.push(frame, layout.STAGE_HOLD_MS + layout.HEAD_PX);
  assert.equal(t.lit.stage, "lockstep", "released");
  const svg = diagramSvg({ stage: "refuse", check: "H-no-regress", pass: false, label: "" });
  assert.match(svg, /class="line hit fail"[^>]*>H-no-regress</, "the deciding check is marked failed");
  assert.ok(!/NaN|undefined/.test(svg));
});

test("History over the fixture ledger lists every fixture verdict with its stamp and deciding reading, opens its evidence, and shows no run figure for run-null records", async () => {
  const h = await readHistory({ ledger: join(root, "ui/fixtures/ledger"), runs: join(root, "ui/fixtures/runs"), skills: join(root, "skills"), live: join(root, "no-live-clone"), registers: join(root, "ledger"), root });
  const html = historyTab(h);
  for (const v of h.verdicts) assert.ok(html.includes(`data-ev="verdict:${v.id}"`), `${v.id} listed`);
  assert.match(html, /GRADUATED/);
  assert.match(html, /REFUSED/);
  assert.match(html, /enters no figure/);
  assert.match(html, /V is sealed/);
  assert.equal(timelineRows(h).length, h.incidents.length + h.attempts.length + h.verdicts.length + h.fires.length + h.steers.length);
  assert.match(evidenceHtml(h, "verdict", "VER-0001")!, /oracle\.png/);
  assert.match(evidenceHtml(h, "decision", "D-0004")!, /Gemini plays/);
});

test("History over an empty ledger shows empty states and prints no zero as a result", async () => {
  const h = await readHistory({ ledger: join(root, "no-ledger"), runs: join(root, "no-runs"), skills: join(root, "no-skills"), live: join(root, "no-live"), registers: join(root, "no-registers"), root });
  const html = historyTab(h);
  assert.match(html, /holds no incident, attempt or verdict/);
  assert.ok(!/(?<![\w-])0(?![\w.])/.test(html.replace(/<[^>]+>/g, " ")), "no bare zero is printed");
});
