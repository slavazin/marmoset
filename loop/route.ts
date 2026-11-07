// The SubQ router (SPEC §2.1 "router", §4 N7, §6.13). It nominates, never decides (D-0004). Offers:
//   buildQuestions(skills, observations)  the typed questions for one incident: subsystem, mid_line, severity, one
//                                          applies:<SKL> per graduated or shadow skill, one same_shape_as:<OBS> per
//                                          recent fast observation;
//   buildState(incident, root)            the long-context state: the full regwrites.jsonl of the window, the signature,
//                                          narration and Gemini spot if present, the core file list and HANDLERS;
//   route(incident, o)                    asks every question at once (split into calls of MAX_QUESTIONS), sends
//                                          core.png, oracle.png and diff.png, appends one `route` status record to
//                                          ledger/incidents.jsonl, one spend record per call (role "router"), and logs
//                                          each call to the telemetry `llm` stream with its latency;
//   routeSkills(incident, skills, k)      pure: the k skill ids with the highest applies: probability;
//   routeCalibration(ledgerDir)           Brier and accuracy from the ledger only, with n.
// CLI: `pnpm route INC-NNNN | --all | --calibration`. Tests: loop/route.test.ts (a fake SubQ client).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { all, append, ledgerDir, read, runId, status, LINE_LIMIT } from "./ledger.ts";
import { readDotEnv } from "./repair.ts";
import { listSkills } from "./shown.ts";
import { tlog } from "../src/telemetry.ts";
import { HANDLERS } from "../core/index.ts";
import type { Attempt, Fire, Incident, Observation, ProvenanceEntry, RouterQuestion, SpendRecord, StatusRecord, Verdict } from "../src/schema.ts";

/** The SubQ Decisions endpoint and model (docs.subq.ai, read 2026-11-07). */
export const SUBQ_ENDPOINT = "https://api.subq.ai/v1/systemone";
export const SUBQ_MODEL = "subq-snap-1.1";
/** Questions per request: the docs' cap of 1–128. A 129th question goes into a second call. */
export const MAX_QUESTIONS = 128;
/** Images per request (docs: ≤ 4), bytes per image (4 MiB) and per request (8 MiB). */
export const MAX_IMAGES = 4;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGES_BYTES = 8 * 1024 * 1024;
/** USD per input token: $0.04 per 1M input tokens, output free (docs.subq.ai pricing, read 2026-11-07). */
export const SUBQ_USD_PER_INPUT_TOKEN = 0.04 / 1_000_000;
/** How many of the most recent fast observations get a same_shape_as question. Set by the brief, not tuned. */
export const RECENT_OBSERVATIONS = 16;
/** Characters of skill activation or observation text a criterion carries. */
export const CRITERION_CHARS = 600;
/** Decimal places a stored probability keeps, so the route status record stays under LINE_LIMIT. */
export const PROB_DECIMALS = 3;
/**
 * The pseudo-question under which the route record carries its call meter (questions, calls, input tokens, usd,
 * latency). Incident.route is Record<question, Record<answer, number>>; SPEC §6.5 names no field for the meter
 * (a finding for the orchestrator), so the meter rides inside route under this key.
 */
export const ROUTE_META_KEY = "_call";
/** Bytes fitRoute leaves under LINE_LIMIT for the meter's `dropped` count, written after the fit. */
export const FIT_SLACK_BYTES = 16;

/** §6.13 RouterQuestion plus the docs' third type, score (ordered levels; criteria an array). Not in schema.ts: a finding. */
export type ScoreQuestion = { type: "score"; instructions: string; criteria: string[] };
export type SubqQuestion = RouterQuestion | ScoreQuestion;
export interface SubqImage { mediaType: "image/png" | "image/jpeg" | "image/webp"; base64: string }
export interface SubqRequest { model: string; state: unknown; questions: Record<string, SubqQuestion>; images?: SubqImage[] }
export type SubqAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };
export interface SubqResponse { model?: string; answers: Record<string, SubqAnswer>; usage?: { input_tokens: number; output_tokens: number } }
export interface SubqReply { status: number; body: SubqResponse | null; error?: string; wall_ms: number }
/** The seam every SubQ call passes through; tests pass a fake. */
export type SubqClient = (req: SubqRequest) => Promise<SubqReply>;

/** SPEC §6.13's questions, verbatim. */
export const BASE_QUESTIONS: Record<string, SubqQuestion> = {
  subsystem: { type: "choice", instructions: "Which emulator subsystem most likely produced this frame divergence?",
    criteria: { ppu_fetcher: "pixels shifted or wrong within a line during mode 3", stat_irq: "a raster split lands on the wrong line",
      oam_dma: "sprites missing or stale", window: "window position or line counter wrong", timer: "timing-dependent state off", other: null } },
  mid_line: { type: "noul", instructions: "Does the divergence start mid-scanline rather than at x = 0?",
    criteria: { true: "the first differing pixel on a line is not at x = 0", false: "whole lines differ from x = 0" } },
  severity: { type: "score", instructions: "How severe is this divergence for a player of the game?",
    criteria: ["cosmetic: a few pixels differ, play unaffected", "visible: a region or band of the frame is wrong", "severe: most of the frame is wrong or game state is broken"] },
};

/** The subsystem a core handler id belongs to, in §6.13's subsystem options. */
export const HANDLER_SUBSYSTEM: Record<string, string> = {
  "ppu.fetcher": "ppu_fetcher", "ppu.fifo": "ppu_fetcher", "ppu.window": "window", "ppu.sprites": "oam_dma", "ppu.oam": "oam_dma",
  dma: "oam_dma", irq: "stat_irq", timer: "timer", "cpu.op": "other", "cpu.cb": "other", mbc1: "other", "bus.io": "other",
};

export interface RouteSkill { id: string; firesWhen: string; notThis: string; paths: string[] }

/** Graduated and shadow skills under `skillsDir`, with their fires-when and not-this activation text (SPEC §6.9). */
export function routableSkills(skillsDir: string): RouteSkill[] {
  const out: RouteSkill[] = [];
  for (const st of ["graduated", "shadow"] as const) {
    for (const s of listSkills(skillsDir, st)) {
      const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(join(s.dir, "SKILL.md"), "utf8"))?.[1] ?? "";
      const field = (k: string) => (new RegExp(`^\\s*${k}:\\s*(.*)$`, "m").exec(fm)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
      out.push({ id: s.id, firesWhen: field("fires-when"), notThis: field("not-this"), paths: s.paths });
    }
  }
  return out;
}

/** Every question for one incident, base questions first; callers split them into calls of MAX_QUESTIONS. */
export function buildQuestions(skills: RouteSkill[], observations: Pick<Observation, "id" | "text">[]): Record<string, SubqQuestion> {
  const q: Record<string, SubqQuestion> = { ...BASE_QUESTIONS };
  for (const s of skills) {
    q[`applies:${s.id}`] = { type: "noul", instructions: `Does skill ${s.id} apply to this incident: would a repairer fixing it touch what the skill covers?`,
      criteria: { true: `fires when: ${s.firesWhen}; paths: ${s.paths.join(", ")}`.slice(0, CRITERION_CHARS), false: `not this: ${s.notThis}`.slice(0, CRITERION_CHARS) } };
  }
  for (const o of observations) {
    q[`same_shape_as:${o.id}`] = { type: "noul", instructions: `Is this incident the same failure shape as observation ${o.id}?`,
      criteria: { true: o.text.slice(0, CRITERION_CHARS), false: "a different failure shape" } };
  }
  return q;
}

/** Splits questions into chunks of at most `max`, in insertion order. */
export function chunkQuestions(q: Record<string, SubqQuestion>, max = MAX_QUESTIONS): Record<string, SubqQuestion>[] {
  const out: Record<string, SubqQuestion>[] = [];
  for (const [k, v] of Object.entries(q)) {
    if (!out.length || Object.keys(out[out.length - 1]).length >= max) out.push({});
    out[out.length - 1][k] = v;
  }
  return out;
}

function evidenceDir(inc: Incident, root: string): string { return resolve(root, inc.files.dir); }

/** The long-context state for one incident (see the file header). */
export function buildState(inc: Incident, root: string): Record<string, unknown> {
  const dir = evidenceDir(inc, root);
  const rw = join(dir, "regwrites.jsonl");
  const regwrites = existsSync(rw) ? readFileSync(rw, "utf8").split("\n").filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return l; } }) : [];
  const coreDir = join(root, "core");
  const coreFiles = existsSync(coreDir) ? readdirSync(coreDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort().map((f) => `core/${f}`) : [];
  return {
    incident: { id: inc.id, kind: inc.kind, align: inc.align, counter: inc.counter, window: inc.window, pixels: inc.pixels, source: inc.source, signature: inc.signature },
    screen: "160x144 DMG LCD; bbox is [x0, y0, x1, y1] of differing pixels; images are core, oracle (hardware reference) and diff",
    regwrites_note: "every IO register write in the window: addr (decimal, 0xFF40 = 65344 LCDC), value, ly, dot, cycles",
    regwrites,
    ...(inc.narration ? { narration: inc.narration } : {}),
    ...(inc.spot ? { gemini_spot: inc.spot } : {}),
    core: { files: coreFiles, handlers: HANDLERS },
  };
}

/** core.png, oracle.png and diff.png from the evidence dir, within the docs' size caps; missing files are skipped. */
export function evidenceImages(inc: Incident, root: string): SubqImage[] {
  const out: SubqImage[] = [];
  let total = 0;
  for (const f of ["core.png", "oracle.png", "diff.png"]) {
    const p = join(evidenceDir(inc, root), f);
    if (!existsSync(p) || out.length >= MAX_IMAGES) continue;
    const n = statSync(p).size;
    if (n > MAX_IMAGE_BYTES || total + n > MAX_IMAGES_BYTES) continue;
    total += n;
    out.push({ mediaType: "image/png", base64: readFileSync(p).toString("base64") });
  }
  return out;
}

/** The key: SUBQ_API_KEY in the environment, else `subquadratic_key` from .env (this checkout's, then the main checkout's). */
export function subqKey(env = process.env): string | undefined {
  if (env.SUBQ_API_KEY) return env.SUBQ_API_KEY;
  const cands = [resolve(import.meta.dirname, "..", ".env")];
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: import.meta.dirname, encoding: "utf8" }).trim();
    cands.push(join(dirname(resolve(import.meta.dirname, common)), ".env"));
  } catch { /* not a git checkout */ }
  for (const f of cands) { const d = readDotEnv(f); const k = d.SUBQ_API_KEY ?? d.subquadratic_key; if (k) return k; }
  return undefined;
}

/** The real client: one POST with a bearer key. The key travels only in the Authorization header. */
export function httpClient(o: { endpoint?: string; key?: string } = {}): SubqClient {
  return async (req) => {
    const key = o.key ?? subqKey();
    const t0 = Date.now();
    if (!key) return { status: 0, body: null, error: "no key: SUBQ_API_KEY unset and .env holds no subquadratic_key", wall_ms: 0 };
    try {
      const r = await fetch(o.endpoint ?? SUBQ_ENDPOINT, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(req) });
      const text = await r.text();
      const wall_ms = Date.now() - t0;
      if (!r.ok) return { status: r.status, body: null, error: `HTTP ${r.status}: ${text.slice(0, 300)}`, wall_ms };
      return { status: r.status, body: JSON.parse(text) as SubqResponse, wall_ms };
    } catch (e) {
      return { status: 0, body: null, error: (e as Error).message, wall_ms: Date.now() - t0 };
    }
  };
}

const round = (p: number) => Number(p.toFixed(PROB_DECIMALS));

/** One answer as Record<answer, probability>: noul → {yes}, choice and score → their probabilities (score adds `score`). */
export function answerProbs(a: SubqAnswer): Record<string, number> {
  if (a.type === "noul") return { yes: round(a.noul) };
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(a.probabilities ?? {})) out[k] = round(v);
  if (a.type === "score") out.score = round(a.score);
  return out;
}

export interface RouteMeter { questions: number; calls: number; images: number; tokens_in: number; usd: number; ms: number; state_bytes: number; dropped: number; failed: number }
export interface RouteOutcome { incident: string; route: Record<string, Record<string, number>>; meter: RouteMeter; errors: string[] }
export interface RouteOpts {
  client?: SubqClient; ledger?: string; root?: string; skillsDir?: string;
  /** Observations to ask same_shape_as about; default: the last RECENT_OBSERVATIONS of ledger/observations.jsonl. */
  observations?: Pick<Observation, "id" | "text" | "anchor">[];
  skills?: RouteSkill[];
}

/** Drops the lowest-probability same_shape_as:, then applies: entries until the status record fits LINE_LIMIT. */
function fitRoute(id: string, route: Record<string, Record<string, number>>): number {
  let dropped = 0;
  const size = () => Buffer.byteLength(JSON.stringify({ t: "status", id, field: "route", value: route, at: new Date().toISOString(), run: runId() }) + "\n");
  for (const prefix of ["same_shape_as:", "applies:"]) {
    while (size() >= LINE_LIMIT - FIT_SLACK_BYTES) {
      const ks = Object.keys(route).filter((k) => k.startsWith(prefix)).sort((a, b) => (route[a].yes ?? 0) - (route[b].yes ?? 0));
      if (!ks.length) break;
      delete route[ks[0]];
      dropped++;
    }
  }
  return dropped;
}

/** Routes one incident (see the file header). */
export async function route(inc: Incident, o: RouteOpts = {}): Promise<RouteOutcome> {
  const root = o.root ?? resolve(import.meta.dirname, "..");
  const dir = o.ledger ?? ledgerDir();
  const client = o.client ?? httpClient();
  const skills = o.skills ?? routableSkills(o.skillsDir ?? join(root, "skills"));
  const obs = (o.observations ?? all<Observation>("observations.jsonl", dir)).filter((x) => x.anchor?.incident !== inc.id).slice(-RECENT_OBSERVATIONS);
  const questions = buildQuestions(skills, obs);
  const state = buildState(inc, root);
  const images = evidenceImages(inc, root);
  const stateBytes = Buffer.byteLength(JSON.stringify(state));
  const routeRec: Record<string, Record<string, number>> = {};
  const meter: RouteMeter = { questions: Object.keys(questions).length, calls: 0, images: images.length, tokens_in: 0, usd: 0, ms: 0, state_bytes: stateBytes, dropped: 0, failed: 0 };
  const errors: string[] = [];
  for (const chunk of chunkQuestions(questions)) {
    const req: SubqRequest = { model: SUBQ_MODEL, state, questions: chunk, ...(images.length ? { images } : {}) };
    tlog("llm", "request", { role: "router", model_requested: SUBQ_MODEL, endpoint: SUBQ_ENDPOINT, incident: inc.id, questions: chunk, state, n_images: images.length, image_bytes: images.map((i) => i.base64.length) });
    const r = await client(req);
    meter.calls++;
    meter.ms += r.wall_ms;
    const nIn = r.body?.usage?.input_tokens ?? 0;
    const usd = nIn * SUBQ_USD_PER_INPUT_TOKEN;
    meter.tokens_in += nIn;
    meter.usd += usd;
    // usage keys avoid "token" in their names: src/telemetry.ts redact() blanks any field matching /token/
    tlog("llm", "response", { role: "router", model_requested: SUBQ_MODEL, model_echoed: r.body?.model ?? "", incident: inc.id, outcome: r.error ? "failed" : "ok", error: r.error ?? null,
      http_status: r.status, n_questions: Object.keys(chunk).length, n_input: nIn, usd, wall_ms: r.wall_ms, answers: r.body?.answers ?? null });
    const rec: SpendRecord = { at: new Date().toISOString(), run: runId(), role: "router", model: r.body?.model || `${SUBQ_MODEL} (not echoed)`, tokens_in: nIn, tokens_out: 0, usd };
    append("spend.jsonl", rec, dir);
    if (r.error || !r.body) { meter.failed++; errors.push(r.error ?? "empty body"); continue; }
    for (const [k, a] of Object.entries(r.body.answers ?? {})) routeRec[k] = answerProbs(a);
  }
  routeRec[ROUTE_META_KEY] = { questions: meter.questions, calls: meter.calls, images: meter.images, n_input: meter.tokens_in, usd: Number(meter.usd.toPrecision(4)), ms: meter.ms, state_bytes: meter.state_bytes, dropped: 0 };
  meter.dropped = fitRoute(inc.id, routeRec);
  routeRec[ROUTE_META_KEY].dropped = meter.dropped;
  if (meter.failed < meter.calls) status("incidents.jsonl", inc.id, "route", routeRec, dir);
  return { incident: inc.id, route: routeRec, meter, errors };
}

/** Pure: the k skill ids with the highest applies:<id> probability; unrouted skills last; ties by id. */
export function routeSkills(inc: Pick<Incident, "route">, skills: string[], k: number): string[] {
  const p = (id: string) => inc.route?.[`applies:${id}`]?.yes ?? -1;
  return [...skills].sort((a, b) => p(b) - p(a) || a.localeCompare(b)).slice(0, Math.max(0, k));
}

export interface CalibrationScore { n: number; brier: number | null; accuracy: number | null }
export interface RouteCalibration { routed: number; subsystem: CalibrationScore; applies: CalibrationScore }

function score(rows: { brier: number; hit: boolean }[]): CalibrationScore {
  if (!rows.length) return { n: 0, brier: null, accuracy: null };
  return { n: rows.length, brier: rows.reduce((s, r) => s + r.brier, 0) / rows.length, accuracy: rows.filter((r) => r.hit).length / rows.length };
}

/**
 * Calibration from the ledger only (D-0004: never trusted blind).
 * subsystem: truth is the set of subsystems of the core files a GRADUATED repair of the incident touched, read from
 *   ledger/provenance.json entries naming that attempt, mapped through HANDLERS and HANDLER_SUBSYSTEM. A file holds
 *   several handlers (core/ppu.ts), so truth is a set: a hit is the top choice in the set, and the Brier target
 *   spreads mass 1 evenly over the set.
 * applies: truth is whether the skill fired (ledger/fires.jsonl) in an attempt on that incident started after the
 *   route record and showing that skill.
 * n counts scored rows; with none, n = 0 and brier and accuracy are null, never 0.
 */
export function routeCalibration(dir = ledgerDir()): RouteCalibration {
  const incidents = all<Incident>("incidents.jsonl", dir).filter((i) => i.route);
  const routeAt = new Map<string, string>();
  for (const r of read("incidents.jsonl", dir) as unknown as StatusRecord[]) if (r.t === "status" && r.field === "route") routeAt.set(r.id, r.at);
  const attempts = all<Attempt>("attempts.jsonl", dir);
  const verdicts = all<Verdict>("verdicts.jsonl", dir);
  const fires = all<Fire>("fires.jsonl", dir);
  const provPath = join(dir, "provenance.json");
  let prov: ProvenanceEntry[] = [];
  try { prov = existsSync(provPath) ? JSON.parse(readFileSync(provPath, "utf8")) : []; } catch { prov = []; }
  const fileSubsystems = new Map<string, Set<string>>();
  for (const [h, f] of Object.entries(HANDLERS)) {
    const s = fileSubsystems.get(f) ?? new Set<string>();
    s.add(HANDLER_SUBSYSTEM[h] ?? "other");
    fileSubsystems.set(f, s);
  }
  const graduated = new Set(verdicts.filter((v) => v.decision === "GRADUATE" && v.subject?.kind === "attempt").map((v) => v.subject.id));
  const subRows: { brier: number; hit: boolean }[] = [];
  const appRows: { brier: number; hit: boolean }[] = [];
  for (const inc of incidents) {
    const sub = inc.route?.subsystem;
    if (sub) {
      const truth = new Set<string>();
      for (const a of attempts) {
        if (a.task?.incident !== inc.id || !graduated.has(a.id)) continue;
        for (const e of prov) if (e.attempt === a.id) for (const s of fileSubsystems.get(e.file) ?? []) truth.add(s);
      }
      if (truth.size) {
        const opts = Object.keys(sub);
        const top = opts.reduce((b, k) => (sub[k] > sub[b] ? k : b), opts[0]);
        const brier = opts.reduce((s, k) => s + (sub[k] - (truth.has(k) ? 1 / truth.size : 0)) ** 2, 0);
        subRows.push({ brier, hit: truth.has(top) });
      }
    }
    const at = routeAt.get(inc.id) ?? "";
    const later = attempts.filter((a) => a.task?.incident === inc.id && (a.at ?? "") > at);
    for (const [k, v] of Object.entries(inc.route ?? {})) {
      if (!k.startsWith("applies:") || typeof v.yes !== "number") continue;
      const skill = k.slice("applies:".length);
      const shown = later.filter((a) => a.task.skills?.includes(skill));
      if (!shown.length) continue;
      const ids = new Set(shown.map((a) => a.id));
      const y = fires.some((f) => f.skill === skill && ids.has(f.attempt)) ? 1 : 0;
      appRows.push({ brier: (v.yes - y) ** 2, hit: (v.yes >= 0.5 ? 1 : 0) === y });
    }
  }
  const out: RouteCalibration = { routed: incidents.length, subsystem: score(subRows), applies: score(appRows) };
  tlog("loop", "router-calibration", out);
  return out;
}

async function main(args: string[]): Promise<void> {
  const dir = ledgerDir();
  if (args[0] === "--calibration") { console.log(JSON.stringify(routeCalibration(dir), null, 2)); return; }
  const incs = all<Incident>("incidents.jsonl", dir);
  const picked = args[0] === "--all" ? incs.filter((i) => !i.route) : incs.filter((i) => args.includes(i.id));
  if (!picked.length) { console.error("usage: pnpm route INC-NNNN [INC-NNNN …] | --all | --calibration (no matching incident)"); process.exit(1); }
  for (const inc of picked) {
    const r = await route(inc, { ledger: dir, root: process.env.RATCHET_ROOT ? resolve(process.env.RATCHET_ROOT) : undefined });
    const m = r.meter;
    console.log(`${inc.id}: ${m.questions} questions in ${m.calls} call(s), ${m.images} images, ${m.tokens_in} input tokens, $${m.usd.toFixed(6)}, ${m.ms} ms${r.errors.length ? `, errors: ${r.errors.join("; ")}` : ""}`);
    console.log(`  subsystem ${JSON.stringify(r.route.subsystem ?? null)} mid_line ${JSON.stringify(r.route.mid_line ?? null)} severity ${JSON.stringify(r.route.severity ?? null)}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
