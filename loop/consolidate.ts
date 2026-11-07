// The consolidator (SPEC §2.3 slow loop, declared projection; §5 S9; G7). Offers:
//   consolidatorView(paths, tReadings)  the consolidator projection: arm-"fast" observations, those attempts'
//                                       dispositions and off_map sentences, and T-family readings. It reads no
//                                       verdict, no trial arm and no vread; every H and V family name in its strings
//                                       is replaced by HELD_OUT_MARK, and "refused at <check>" reads "refused", since
//                                       the check a refusal names is an H reading (consolidate.test.ts asserts both);
//   parseReply(text, view)              the consolidator's JSON reply, validated: triage over view observations,
//                                       nominations with a complete pentad anchored to >= MIN_ANCHORS reducible
//                                       observations of their shape (the I11 noise filter), at most MAX_NOMINATIONS;
//   consolidate(deps)                   one call through loop/llm.ts, triage appended as status records ("shape",
//                                       "reducible") on ledger/observations.jsonl, and each nomination written as
//                                       skills/shadow/SKL-NNNN/SKILL.md (SPEC §6.9).
// Irreducible shapes update detection, never skills: they are returned as `detection` and logged.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { all, nextId, status } from "./ledger.ts";
import type { LoopPaths } from "./paths.ts";
import { selectedLlm } from "./claude.ts";
import { recordSpend, CONSOLIDATOR_MODEL, CONSOLIDATE_MAX_TOKENS, type Llm, type LlmCall } from "./llm.ts";
import { loadSplits, familiesIn } from "../suites/splits.ts";
import { tlog } from "../src/telemetry.ts";
import type { Attempt, CheckName, Observation, SkillFrontmatter, Splits, SuiteReading } from "../src/schema.ts";

/** Nominations a generation writes at most (SPEC §2.3 slow loop). */
export const MAX_NOMINATIONS = 2;
/** Observations a nomination is anchored to at least (V2 § 7.4 recurrence bar; SPEC §5 S9). */
export const MIN_ANCHORS = 2;
/** Most recent fast observations the view carries; bounds the prompt. */
export const VIEW_MAX_OBSERVATIONS = 80;
/** What replaces an H or V family name in the view's strings. */
export const HELD_OUT_MARK = "[held-out family]";
/** The consolidator prompt. */
export const PROMPT_FILE = join(import.meta.dirname, "prompts", "consolidate.md");
/** Checks a skill may name in enforcement.checked-by (the gate's repair checks a repairer's diff meets). */
export const SKILL_CHECKS: readonly CheckName[] = ["admitted-traces", "base-suites", "H-no-regress", "repro"];

export interface ConsolidatorView {
  observations: { id: string; anchor: Observation["anchor"]; text: string }[];
  dispositions: { attempt: string; marks: Record<string, "applied" | "considered-not-applicable"> }[];
  off_map: { attempt: string; text: string }[];
  t_readings: SuiteReading[];
}

/** H and V family names from splits.json. */
export function heldOutNames(splits: Splits = loadSplits()): string[] {
  return [...familiesIn(splits, "H"), ...familiesIn(splits, "V")].sort((a, b) => b.length - a.length);
}

/**
 * Strips H and V family names, and the check a refusal names: the gate runs H-no-regress last and stops at the
 * first failure (gate-repair.ts), so "refused at H-no-regress", or by elimination any other check name, is an H reading.
 */
function scrub(s: string, names: string[]): string {
  let out = s.replace(/\brefused at (?:the gate|[A-Za-z-]+)/g, "refused");
  for (const n of names) out = out.split(n).join(HELD_OUT_MARK);
  return out;
}

/** The consolidator projection (see the file header). */
export function consolidatorView(paths: LoopPaths, tReadings: SuiteReading[], splits: Splits = loadSplits()): ConsolidatorView {
  const held = heldOutNames(splits);
  const tFams = new Set(familiesIn(splits, "T"));
  const fast = new Map(all<Attempt>("attempts.jsonl", paths.ledger).filter((a) => a.task?.arm === "fast").map((a) => [a.id, a]));
  const obs = all<Observation>("observations.jsonl", paths.ledger).filter((o) => fast.has(o.anchor?.attempt)).slice(-VIEW_MAX_OBSERVATIONS);
  const atts = [...new Set(obs.map((o) => o.anchor.attempt))].map((id) => fast.get(id)!);
  return {
    observations: obs.map((o) => ({ id: o.id, anchor: { incident: o.anchor.incident, attempt: o.anchor.attempt, counter: o.anchor.counter }, text: scrub(o.text, held) })),
    dispositions: atts.filter((a) => a.result && Object.keys(a.result.dispositions ?? {}).length).map((a) => ({ attempt: a.id, marks: { ...a.result!.dispositions } })),
    off_map: atts.filter((a) => a.result?.off_map).map((a) => ({ attempt: a.id, text: scrub(a.result!.off_map!, held) })),
    t_readings: tReadings.filter((r) => r.split === "T" && tFams.has(r.family)).map((r) => ({ split: r.split, family: r.family, roms: r.roms, pass: r.pass, exact: r.exact, pixel_match: r.pixel_match })),
  };
}

export interface Triage { id: string; shape: string; reducible: boolean }
export interface Nomination {
  name: string; shape: string; anchors: string[]; fires_when: string; not_this: string; paths: string[]; owed: string;
  do: string; dont: string; false_if: string; checked_by: CheckName[]; residue: string; retire_when: string;
}
export interface Reply { triage: Triage[]; nominations: Nomination[]; dropped: { name: string; why: string }[] }

const STR_FIELDS = ["name", "shape", "fires_when", "not_this", "owed", "do", "dont", "false_if", "residue", "retire_when"] as const;

/** The first JSON object in `text` (a fenced block or bare braces). */
export function extractJson(text: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const src = fence ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(src);
}

/** Validates a reply against the view (see the file header); throws when the text holds no JSON object. */
export function parseReply(text: string, view: ConsolidatorView): Reply {
  const j = extractJson(text) as { triage?: unknown[]; nominations?: unknown[] };
  const ids = new Set(view.observations.map((o) => o.id));
  const triage: Triage[] = [];
  for (const t of (j.triage ?? []) as Record<string, unknown>[]) {
    if (typeof t?.id === "string" && ids.has(t.id) && typeof t.shape === "string" && t.shape.trim() && typeof t.reducible === "boolean")
      if (!triage.some((x) => x.id === t.id)) triage.push({ id: t.id, shape: slug(t.shape), reducible: t.reducible });
  }
  const tri = new Map(triage.map((t) => [t.id, t]));
  const nominations: Nomination[] = [];
  const dropped: Reply["dropped"] = [];
  for (const n of (j.nominations ?? []) as Record<string, any>[]) {
    const name = String(n?.name ?? "?");
    const missing = STR_FIELDS.filter((f) => typeof n?.[f] !== "string" || !n[f].trim());
    if (missing.length) { dropped.push({ name, why: `incomplete pentad: ${missing.join(", ")}` }); continue; }
    const paths = Array.isArray(n.paths) ? n.paths.filter((p: unknown) => typeof p === "string" && p.startsWith("core/")) : [];
    if (!paths.length) { dropped.push({ name, why: "no activation path under core/" }); continue; }
    const checked = (Array.isArray(n.checked_by) ? n.checked_by : []).filter((c: CheckName) => SKILL_CHECKS.includes(c));
    if (!checked.length) { dropped.push({ name, why: "no checked-by among SKILL_CHECKS" }); continue; }
    const shape = slug(n.shape);
    const anchors = [...new Set((Array.isArray(n.anchors) ? n.anchors : []).filter((a: unknown) => typeof a === "string" && ids.has(a)))] as string[];
    const good = anchors.filter((a) => tri.get(a)?.reducible === true && tri.get(a)?.shape === shape);
    if (good.length < MIN_ANCHORS) { dropped.push({ name, why: `${good.length} reducible anchors of shape ${shape}; MIN_ANCHORS is ${MIN_ANCHORS}` }); continue; }
    if (nominations.length >= MAX_NOMINATIONS) { dropped.push({ name, why: `over MAX_NOMINATIONS ${MAX_NOMINATIONS}` }); continue; }
    nominations.push({ ...Object.fromEntries(STR_FIELDS.map((f) => [f, String(n[f]).trim()])) as any, name: slug(n.name), shape, anchors: good, paths, checked_by: checked });
  }
  return { triage, nominations, dropped };
}

// ---- skill files (SPEC §6.9) ----

/** The slugger every skill name passes through: lowercase kebab-case, at most 6 words and 48 characters. */
export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").split("-").slice(0, 6).join("-").slice(0, 48).replace(/-+$/, "") || "unnamed";
}

/** Every SKL id under skills/shadow, skills/graduated and skills/tombstones. */
export function skillIds(skillsDir: string): string[] {
  const out: string[] = [];
  for (const s of ["shadow", "graduated", "retired"]) { const d = join(skillsDir, s); if (existsSync(d)) out.push(...readdirSync(d).filter((x) => /^SKL-\d+$/.test(x))); }
  const t = join(skillsDir, "tombstones");
  if (existsSync(t)) out.push(...readdirSync(t).map((x) => x.replace(/\.md$/, "")).filter((x) => /^SKL-\d+$/.test(x)));
  return out;
}

/** The next SKL id across every skills/ store. */
export function nextSkillId(skillsDir: string): string {
  return nextId("SKL", skillIds(skillsDir));
}

const q = (s: string) => JSON.stringify(s);

/** SKILL.md text for a frontmatter and its Do and Don't (flow forms loop/shown.ts parseActivation and tools/fire.mjs read). */
export function skillText(fm: SkillFrontmatter, doText: string, dontText: string): string {
  return [
    "---",
    `id: ${fm.id}`,
    `name: ${fm.name}`,
    `status: ${fm.status}`,
    "activation:",
    `  fires-when: ${q(fm.activation["fires-when"])}`,
    `  not-this: ${q(fm.activation["not-this"])}`,
    `  paths: [${fm.activation.paths.map(q).join(", ")}]`,
    `  owed: ${q(fm.activation.owed)}`,
    "warrant:",
    `  anchors: [${fm.warrant.anchors.join(", ")}]`,
    `  false-if: ${q(fm.warrant["false-if"])}`,
    "enforcement:",
    `  checked-by: [${fm.enforcement["checked-by"].map(q).join(", ")}]`,
    `  residue: ${q(fm.enforcement.residue)}`,
    "lifecycle:",
    `  consumer: ${fm.lifecycle.consumer}`,
    `  retire-when: ${q(fm.lifecycle["retire-when"])}`,
    `  successor: ${fm.lifecycle.successor ?? "null"}`,
    "---",
    `**Do:** ${doText}`,
    "",
    `**Don't:** ${dontText}`,
    "",
  ].join("\n");
}

/** Parses the flow-form frontmatter skillText writes, plus the Do and Don't. */
export function parseSkill(text: string): { fm: SkillFrontmatter; do: string; dont: string } {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const get = (k: string): string => {
    const v = (new RegExp(`^\\s*${k}:\\s*(.*)$`, "m").exec(fm)?.[1] ?? "").trim();
    try { return v.startsWith('"') ? JSON.parse(v) : v; } catch { return v; }
  };
  const list = (k: string): string[] => ((new RegExp(`^\\s*${k}:\\s*\\[(.*)\\]\\s*$`, "m").exec(fm)?.[1]) ?? "").split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
  const succ = get("successor");
  return {
    fm: {
      id: get("id"), name: get("name"), status: get("status") as SkillFrontmatter["status"],
      activation: { "fires-when": get("fires-when"), "not-this": get("not-this"), paths: list("paths"), owed: get("owed") },
      warrant: { anchors: list("anchors"), "false-if": get("false-if") },
      enforcement: { "checked-by": list("checked-by") as CheckName[], residue: get("residue") },
      lifecycle: { consumer: "repairer", "retire-when": get("retire-when"), successor: succ && succ !== "null" ? succ : null },
    },
    do: (/\*\*Do:\*\*\s*([\s\S]*?)\n\s*\n\*\*Don't:\*\*/.exec(text)?.[1] ?? "").trim(),
    dont: (/\*\*Don't:\*\*\s*([\s\S]*)$/.exec(text)?.[1] ?? "").trim(),
  };
}

/** Writes skills/shadow/<id>/SKILL.md and returns its path. */
export function writeShadowSkill(skillsDir: string, fm: SkillFrontmatter, doText: string, dontText: string): string {
  const d = join(skillsDir, "shadow", fm.id);
  mkdirSync(d, { recursive: true });
  const p = join(d, "SKILL.md");
  writeFileSync(p, skillText(fm, doText, dontText));
  return p;
}

export function frontmatterFor(id: string, n: Nomination): SkillFrontmatter {
  return {
    id, name: n.name, status: "shadow",
    activation: { "fires-when": n.fires_when, "not-this": n.not_this, paths: n.paths, owed: n.owed },
    warrant: { anchors: n.anchors, "false-if": n.false_if },
    enforcement: { "checked-by": n.checked_by, residue: n.residue },
    lifecycle: { consumer: "repairer", "retire-when": n.retire_when, successor: null },
  };
}

export interface ConsolidateDeps { paths: LoopPaths; tReadings: SuiteReading[]; llm?: Llm; splits?: Splits; generation: number }
export interface ConsolidateOutput {
  view: ConsolidatorView; call: LlmCall; reply: Reply | null;
  nominated: { id: string; shape: string; path: string; nomination: Nomination }[];
  detection: { shape: string; observations: string[] }[];
}

/** One consolidation (see the file header). A failed or unparseable call writes no triage and no skill. */
export async function consolidate(d: ConsolidateDeps): Promise<ConsolidateOutput> {
  const view = consolidatorView(d.paths, d.tReadings, d.splits);
  // the run's consolidator: muse-wonder over loop/llm.ts chat, or Claude for a RATCHET_REPAIRER=claude run (S23)
  const sel = selectedLlm();
  const llm = d.llm ?? sel.llm;
  const model = d.llm ? CONSOLIDATOR_MODEL : sel.model;
  const req = { model, role: "consolidator" as const, max_tokens: CONSOLIDATE_MAX_TOKENS,
    messages: [{ role: "system" as const, content: readFileSync(PROMPT_FILE, "utf8") }, { role: "user" as const, content: JSON.stringify(view) }] };
  const call = await llm(req);
  recordSpend("consolidator", call, model, d.paths.ledger);
  let reply: Reply | null = null;
  let parseError: string | null = null;
  if (call.ok) { try { reply = parseReply(call.text, view); } catch (e) { parseError = (e as Error).message; } }
  tlog("loop", "consolidate.call", { generation: d.generation, ok: call.ok, error: call.error ?? parseError, observations: view.observations.length, model_echoed: call.model_echoed, wall_ms: call.wall_ms });
  if (!reply) return { view, call, reply, nominated: [], detection: [] };

  for (const t of reply.triage) {
    status("observations.jsonl", t.id, "shape", t.shape, d.paths.ledger);
    status("observations.jsonl", t.id, "reducible", t.reducible, d.paths.ledger);
  }
  const irr = new Map<string, string[]>();
  for (const t of reply.triage) if (!t.reducible) irr.set(t.shape, [...(irr.get(t.shape) ?? []), t.id]);
  const detection = [...irr].map(([shape, observations]) => ({ shape, observations }));
  tlog("loop", "consolidate.triage", { generation: d.generation, triage: reply.triage, detection, dropped: reply.dropped });

  const nominated: ConsolidateOutput["nominated"] = [];
  for (const n of reply.nominations) {
    const id = nextSkillId(d.paths.skills);
    const path = writeShadowSkill(d.paths.skills, frontmatterFor(id, n), n.do, n.dont);
    nominated.push({ id, shape: n.shape, path, nomination: n });
  }
  tlog("loop", "consolidate.nominations", { generation: d.generation, nominated: nominated.map((x) => ({ id: x.id, name: x.nomination.name, shape: x.shape, anchors: x.nomination.anchors })) });
  return { view, call, reply, nominated, detection };
}
