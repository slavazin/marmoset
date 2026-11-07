// Policies (D-0020): versioned changes to how the repair packet is built, which tool line the repairer gets, or how
// an incident is routed to shown skills, graduated by the skill trial rule (loop/gate-skill.ts decideSkill). Offers:
//   POLICY_MENU                 the fixed menu of parameterised templates a nomination picks from; no free-form code;
//   setRouteSkills(fn)          the seam to S17's loop/route.ts routeSkills(incident, skills, k) (SubQ applies:<SKL-id>
//                               probabilities in Incident.route); DEFAULT_ROUTE_SKILLS stands in until it lands;
//   SUBSYSTEM_GLOBS             S13 spot subsystems (player/vision.ts SUBSYSTEMS, "other" excluded) → core/ globs;
//   loadPolicies(dir, status)   policies/<status>/POL-NNNN/POLICY.md parsed (PolicyFrontmatter), in id order;
//   policiesInForce(paths)      the graduated POL ids, which every fast attempt names in task.policies (loop/fast.ts);
//   applyPolicies(task, ctx)    the one place a policy changes behaviour: for task.policies it returns the routed
//                               shown-skill filter (routing), packet files and TASK.md lines (packet, tool);
//   parsePolicyNomination(j, view)  the consolidator's `policy` reply validated against the menu and the view:
//                               at most MAX_POLICY_NOMINATIONS, anchored to >= MIN_ANCHORS view observations;
//   nominatePolicy(deps)        writes the valid nomination to policies/shadow/POL-NNNN/POLICY.md;
//   makePolicyPlacebo(path, dir) the mechanical twin: same template, name, change, warrant and lifecycle, its own POL
//                               id, and params of the same shape: routing and packet maps deranged by a seed from the
//                               candidate's id (same glob count per subsystem), a SubQ route's order "seeded:<hex>"
//                               (a seeded random pick of the same count as SubQ's pick), a tool hint of matched length from
//                               HINT_POOL. Nothing in its file names it the twin; the pairing lives only in
//                               runs/<run>/trials.jsonl (loop/trial.ts). Tests: loop/policies.test.ts.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nextId } from "./ledger.ts";
import { extractJson, MIN_ANCHORS, slug, type ConsolidateOutput, type ConsolidatorView } from "./consolidate.ts";
import { tlog } from "../src/telemetry.ts";
import type { LoopPaths } from "./paths.ts";
import type { ShownSkill } from "./shown.ts";
import type { Incident, PolicyFrontmatter, PolicyKind, RepairTask, SkillStatus } from "../src/schema.ts";
import type { Subsystem } from "../player/vision.ts";

/** Policy nominations a generation writes at most (D-0020 brief: 1 per generation). */
export const MAX_POLICY_NOMINATIONS = 1;

/** S13 spot subsystem → the core/ globs a failure of that subsystem points at; "other" routes nothing. */
export const SUBSYSTEM_GLOBS: Readonly<Record<Exclude<Subsystem, "other">, string[]>> = {
  ppu_fetcher: ["core/ppu*.ts"], stat_irq: ["core/stat*.ts"], oam_dma: ["core/dma*.ts"], window: ["core/window*.ts"], timer: ["core/timer*.ts"],
};

/** Tool lines a `tool-hint` nomination may pick. */
export const TOOL_HINTS: readonly string[] = [
  "Run node tools/replay.mjs on the task before the first edit and after each edit; write RESULT.json only once it prints clean.",
  "Read HANDLERS in core/index.ts first and open the file the failing handler maps to before editing any other file.",
];
/** Tool lines unrelated to any repair, the source of a tool policy's twin (closest length to the candidate's hint). */
export const HINT_POOL: readonly string[] = [
  "Keep each edited line under 120 characters and keep the file's existing indentation and quote style unchanged.",
  "Write the RESULT.json summary as one present-tense sentence that names the function the diff edits first.",
  "List the edited files in RESULT.json's summary in the order they were edited, separated by commas, one time each.",
];

interface Template { kind: PolicyKind; change: string; params: Record<string, readonly unknown[]>; resolve(p: Record<string, unknown>): Record<string, unknown> }

/** The fixed menu: each template's allowed param values, and the params its POLICY.md carries once resolved. */
export const POLICY_MENU: Readonly<Record<string, Template>> = {
  "route-by-spot-subsystem": {
    kind: "routing",
    change: "Shows only the graduated skills whose activation paths match the globs params.map gives the failure's subsystem (the incident's spot subsystem, else the trial family's).",
    params: { route: ["spot-subsystem"] },
    resolve: (p) => ({ route: p.route, map: SUBSYSTEM_GLOBS }),
  },
  "route-by-subq-applies": {
    kind: "routing",
    change: "Shows the graduated skills the SubQ router picks for the incident from its applies:<SKL-id> probabilities (Incident.route), ranked by params.order.",
    params: { route: ["subq-applies"] },
    resolve: (p) => ({ route: p.route, order: "probability" }),
  },
  "packet-subsystem-focus": {
    kind: "packet",
    change: "Writes packet/focus.json naming the core files matching the globs params.map gives the failure's subsystem, and a TASK.md line pointing at it.",
    params: { files: ["subsystem-pointed"] },
    resolve: (p) => ({ files: p.files, map: SUBSYSTEM_GLOBS }),
  },
  "tool-hint": {
    kind: "tool",
    change: "Appends params.hint to TASK.md as one tool-use line.",
    params: { hint: TOOL_HINTS },
    resolve: (p) => ({ hint: p.hint }),
  },
};

/** S17's router signature (loop/route.ts routeSkills): the shown-skill ids SubQ routes the incident to, at most k. */
export type RouteSkills = (incident: Incident | undefined, skills: ShownSkill[], k: number) => string[];
/** Stand-in: ids whose largest applies:<id> probability in any Incident.route entry is >= 0.5, highest first. */
export const DEFAULT_ROUTE_SKILLS: RouteSkills = (incident, skills, k) => {
  const p = (id: string) => Math.max(-1, ...Object.values(incident?.route ?? {}).map((r) => r?.[`applies:${id}`] ?? -1));
  return skills.map((s) => s.id).filter((id) => p(id) >= 0.5).sort((a, b) => p(b) - p(a)).slice(0, k);
};
let routeSkills: RouteSkills = DEFAULT_ROUTE_SKILLS;
/** Replaces the SubQ router (loop/route.ts routeSkills once on main; a fake in tests); returns the previous one. */
export function setRouteSkills(fn: RouteSkills): RouteSkills { const prev = routeSkills; routeSkills = fn; return prev; }

export interface Policy { fm: PolicyFrontmatter; template: string; dir: string; text: string }

export function policiesDir(paths: Pick<LoopPaths, "root">): string { return join(paths.root, "policies"); }

const q = (s: string) => JSON.stringify(s);

/** POLICY.md text for a frontmatter (flow forms parsePolicy reads); `template` is the menu entry it came from. */
export function policyText(fm: PolicyFrontmatter, template: string): string {
  return [
    "---", `id: ${fm.id}`, `name: ${fm.name}`, `kind: ${fm.kind}`, `status: ${fm.status}`, `template: ${template}`,
    `change: ${q(fm.change)}`, `params: ${JSON.stringify(fm.params)}`,
    "warrant:", `  anchors: [${fm.warrant.anchors.join(", ")}]`, `  false-if: ${q(fm.warrant["false-if"])}`,
    "lifecycle:", `  retire-when: ${q(fm.lifecycle["retire-when"])}`, `  successor: ${fm.lifecycle.successor ?? "null"}`,
    "---", "",
  ].join("\n");
}

export function parsePolicy(text: string, dir = ""): Policy {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const get = (k: string): string => {
    const v = (new RegExp(`^\\s*${k}:\\s*(.*)$`, "m").exec(fm)?.[1] ?? "").trim();
    try { return v.startsWith('"') ? JSON.parse(v) : v; } catch { return v; }
  };
  const anchors = (/^\s*anchors:\s*\[(.*)\]\s*$/m.exec(fm)?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  let params: Record<string, unknown> = {};
  try { params = JSON.parse(get("params") || "{}"); } catch { params = {}; }
  const succ = get("successor");
  return {
    template: get("template"), dir, text,
    fm: { id: get("id"), name: get("name"), kind: get("kind") as PolicyKind, status: get("status") as SkillStatus, change: get("change"), params,
      warrant: { anchors, "false-if": get("false-if") }, lifecycle: { "retire-when": get("retire-when"), successor: succ && succ !== "null" ? succ : null } },
  };
}

/** Policies under policies/<status>/POL-NNNN/POLICY.md, in id order. */
export function loadPolicies(dir: string, status: "shadow" | "graduated"): Policy[] {
  const base = join(dir, status);
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((d) => /^POL-\d+$/.test(d) && existsSync(join(base, d, "POLICY.md"))).sort()
    .map((id) => parsePolicy(readFileSync(join(base, id, "POLICY.md"), "utf8"), join(base, id)));
}

export function policiesInForce(paths: Pick<LoopPaths, "root">): string[] {
  return loadPolicies(policiesDir(paths), "graduated").map((p) => p.fm.id);
}

/** Every POL id across policies/shadow, graduated and tombstones. */
export function policyIds(dir: string): string[] {
  const out: string[] = [];
  for (const s of ["shadow", "graduated"]) { const d = join(dir, s); if (existsSync(d)) out.push(...readdirSync(d).filter((x) => /^POL-\d+$/.test(x))); }
  const t = join(dir, "tombstones");
  if (existsSync(t)) out.push(...readdirSync(t).map((x) => x.replace(/\.md$/, "")).filter((x) => /^POL-\d+$/.test(x)));
  return out;
}

// ---- applying ----

/** The failure's subsystem: the incident's spot subsystem, else the trial family's suffix matched to a subsystem key. */
export function subsystemOf(task: RepairTask, incident?: Incident): string | null {
  if (incident?.spot?.subsystem) return incident.spot.subsystem;
  const suffix = task.family?.split(":")[1];
  if (!suffix) return null;
  return Object.keys(SUBSYSTEM_GLOBS).find((k) => k === suffix || k.startsWith(`${suffix}_`)) ?? null;
}

function globRe(g: string): RegExp {
  return new RegExp(`^${g.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
}
/** Two globs overlap when equal or when either matches the other read as a literal path. */
export function globsOverlap(a: string, b: string): boolean { return a === b || globRe(a).test(b) || globRe(b).test(a); }

export interface PolicyContext {
  paths: Pick<LoopPaths, "root">;
  incident?: Incident;
  /** The skills route() picks among, with their activation paths. */
  skills?: ShownSkill[];
  /** Posix paths under the scratch core, "core/…", for packet policies. */
  coreFiles?: string[];
  site: "shown" | "packet";
}
export interface PolicyEffect {
  policies: string[]; subsystem: string | null;
  /** The shown-skill ids routing policies keep, in input order; the ids unchanged without a routing policy or a mapped subsystem. */
  route(ids: string[]): string[];
  /** Lines appended to packet/TASK.md. */
  taskLines: string[];
  /** Files written under packet/, by name. */
  packetFiles: Record<string, string>;
}

function loadById(dir: string, ids: string[]): Policy[] {
  const all = [...loadPolicies(dir, "graduated"), ...loadPolicies(dir, "shadow")];
  return ids.map((id) => all.find((p) => p.fm.id === id)).filter((p): p is Policy => !!p);
}

/** The one place a policy changes behaviour (see the file header). */
export function applyPolicies(task: RepairTask, ctx: PolicyContext): PolicyEffect {
  const ids = task.policies ?? [];
  const pols = ids.length ? loadById(policiesDir(ctx.paths), ids) : [];
  const subsystem = subsystemOf(task, ctx.incident);
  const taskLines: string[] = [];
  const packetFiles: Record<string, string> = {};
  const routes: string[][] = [];
  const picks: ((ids: string[]) => string[])[] = [];
  for (const p of pols) {
    if (p.fm.kind === "routing" && p.fm.params.route === "subq-applies") {
      const order = String(p.fm.params.order ?? "probability");
      picks.push((ids) => {
        const skills = (ctx.skills ?? []).filter((s) => ids.includes(s.id));
        const chosen = routeSkills(ctx.incident, skills, ids.length);
        if (!order.startsWith("seeded:")) return ids.filter((id) => chosen.includes(id));
        const rnd = seeded(`${order}:${ctx.incident?.id ?? task.family ?? ""}`);
        const pool = [...ids];
        for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
        const keep = new Set(pool.slice(0, chosen.length));
        return ids.filter((id) => keep.has(id));
      });
      continue;
    }
    const map = (p.fm.params.map ?? {}) as Record<string, string[]>;
    const globs = subsystem ? map[subsystem] : undefined;
    if (p.fm.kind === "routing" && globs) routes.push(globs);
    if (p.fm.kind === "packet" && globs) {
      const files = (ctx.coreFiles ?? []).filter((f) => globs.some((g) => globsOverlap(g, f)));
      packetFiles["focus.json"] = JSON.stringify({ files }, null, 2) + "\n";
      taskLines.push("packet/focus.json names the core files this failure points at; read them first.");
    }
    if (p.fm.kind === "tool" && typeof p.fm.params.hint === "string") taskLines.push(p.fm.params.hint);
  }
  const skills = new Map((ctx.skills ?? []).map((s) => [s.id, s]));
  const route = (xs: string[]) => picks.reduce((ids, pick) => pick(ids), routes.length
    ? xs.filter((id) => routes.every((globs) => (skills.get(id)?.paths ?? []).some((sp) => globs.some((g) => globsOverlap(g, sp)))))
    : [...xs]);
  if (pols.length) tlog("loop", "policy.apply", { site: ctx.site, task_arm: task.arm, policies: pols.map((p) => p.fm.id), kinds: pols.map((p) => p.fm.kind), subsystem, task_lines: taskLines.length, packet_files: Object.keys(packetFiles) });
  return { policies: pols.map((p) => p.fm.id), subsystem, route, taskLines, packetFiles };
}

// ---- nomination ----

export interface PolicyNomination { template: string; params: Record<string, unknown>; anchors: string[]; false_if: string; retire_when: string }

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Validates the reply's `policy` (an object or a list) against POLICY_MENU and the view (see the file header). */
export function parsePolicyNomination(reply: unknown, view: ConsolidatorView): { nominations: PolicyNomination[]; dropped: { template: string; why: string }[] } {
  const r = (reply ?? {}) as { policy?: unknown; policies?: unknown };
  const raw = ([] as unknown[]).concat(r.policy ?? r.policies ?? []) as Record<string, any>[];
  const ids = new Set(view.observations.map((o) => o.id));
  const nominations: PolicyNomination[] = [];
  const dropped: { template: string; why: string }[] = [];
  for (const n of raw) {
    const template = String(n?.template ?? "?");
    const t = POLICY_MENU[template];
    if (!t) { dropped.push({ template, why: `template ${template} is not in POLICY_MENU` }); continue; }
    const params = (n.params && typeof n.params === "object" ? n.params : {}) as Record<string, unknown>;
    const extra = Object.keys(params).filter((k) => !(k in t.params));
    const bad = Object.entries(t.params).filter(([k, allowed]) => !allowed.some((v) => same(v, params[k]))).map(([k]) => k);
    if (extra.length || bad.length) { dropped.push({ template, why: `params outside the menu: ${[...extra, ...bad].join(", ")}` }); continue; }
    const anchors = [...new Set((Array.isArray(n.anchors) ? n.anchors : []).filter((a: unknown) => typeof a === "string" && ids.has(a)))] as string[];
    if (anchors.length < MIN_ANCHORS) { dropped.push({ template, why: `${anchors.length} view observations anchored; MIN_ANCHORS is ${MIN_ANCHORS}` }); continue; }
    const missing = ["false_if", "retire_when"].filter((f) => typeof n[f] !== "string" || !n[f].trim());
    if (missing.length) { dropped.push({ template, why: `missing ${missing.join(", ")}` }); continue; }
    if (nominations.length >= MAX_POLICY_NOMINATIONS) { dropped.push({ template, why: `over MAX_POLICY_NOMINATIONS ${MAX_POLICY_NOMINATIONS}` }); continue; }
    nominations.push({ template, params: Object.fromEntries(Object.keys(t.params).map((k) => [k, params[k]])), anchors, false_if: n.false_if.trim(), retire_when: n.retire_when.trim() });
  }
  return { nominations, dropped };
}

function writePolicy(dir: string, fm: PolicyFrontmatter, template: string): string {
  const d = join(dir, "shadow", fm.id);
  mkdirSync(d, { recursive: true });
  const p = join(d, "POLICY.md");
  writeFileSync(p, policyText(fm, template));
  return p;
}

/** Writes the consolidation's valid policy nomination as a shadow policy; null when none is valid. */
export function nominatePolicy(d: { paths: Pick<LoopPaths, "root">; consolidation: ConsolidateOutput; generation: number }): { id: string; path: string } | null {
  const c = d.consolidation;
  if (!c.call.ok || !c.reply) return null;
  let j: unknown;
  try { j = extractJson(c.call.text); } catch { return null; }
  const { nominations, dropped } = parsePolicyNomination(j, c.view);
  if (dropped.length) tlog("loop", "policy.rejected", { generation: d.generation, dropped });
  const n = nominations[0];
  if (!n) return null;
  const dir = policiesDir(d.paths);
  const t = POLICY_MENU[n.template];
  const id = nextId("POL", policyIds(dir));
  const fm: PolicyFrontmatter = { id, name: slug(n.template), kind: t.kind, status: "shadow", change: t.change, params: t.resolve(n.params),
    warrant: { anchors: n.anchors, "false-if": n.false_if }, lifecycle: { "retire-when": n.retire_when, successor: null } };
  const path = writePolicy(dir, fm, n.template);
  tlog("loop", "policy.nominate", { generation: d.generation, id, template: n.template, kind: t.kind, params: n.params, anchors: n.anchors });
  return { id, path };
}

// ---- the twin ----

function seeded(seed: string): () => number {
  let h = createHash("sha256").update(seed).digest();
  let i = 0;
  return () => { if (i + 4 > h.length) { h = createHash("sha256").update(h).digest(); i = 0; } const x = h.readUInt32BE(i); i += 4; return x / 2 ** 32; };
}

/** A derangement of `map`'s values over its keys, seeded: every key gets another key's globs, so counts match. */
export function derange(map: Record<string, string[]>, seed: string): Record<string, string[]> {
  const keys = Object.keys(map);
  const rnd = seeded(seed);
  const order = [...keys];
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  return Object.fromEntries(keys.map((k) => { const at = order.indexOf(k); return [k, [...map[order[(at + 1) % order.length]]]]; }));
}

/** The candidate's mechanical twin (see the file header); returns its id and path. */
export function makePolicyPlacebo(candidatePath: string, dir: string): { id: string; path: string; source: string } {
  const cand = parsePolicy(readFileSync(candidatePath, "utf8"));
  const id = nextId("POL", policyIds(dir));
  const params = { ...cand.fm.params };
  let source: string;
  if (cand.fm.kind === "tool") {
    const len = String(params.hint ?? "").length;
    params.hint = [...HINT_POOL].sort((a, b) => Math.abs(a.length - len) - Math.abs(b.length - len))[0];
    source = "HINT_POOL";
  } else if (params.route === "subq-applies") {
    params.order = `seeded:${createHash("sha256").update(cand.fm.id).digest("hex").slice(0, 12)}`;
    source = "seeded route";
  } else {
    params.map = derange(params.map as Record<string, string[]>, cand.fm.id);
    source = `derange(${cand.fm.id})`;
  }
  const path = writePolicy(dir, { ...cand.fm, id, params }, cand.template);
  return { id, path, source };
}
