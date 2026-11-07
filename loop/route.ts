// The SubQ router (SPEC §2.1 "router", §4 N7, §6.13). It nominates, never decides (D-0004). Offers:
//   buildQuestions(skills, observations)  the typed questions for one incident: subsystem, mid_line, severity, one
//                                          applies:<SKL> per graduated or shadow skill, one same_shape_as:<OBS> per
//                                          recent fast observation;
//   controlsFor(seed, skills)             the two planted questions every call carries: one applies: question whose
//                                          criterion comes from DECOY_POOL (a subsystem no frame divergence reaches),
//                                          and TWIN_KEY, the subsystem question reworded; neither is used for routing;
//   buildState(incident, root)            the long-context state: the full regwrites.jsonl of the window, the signature,
//                                          narration and Gemini spot if present, the core file list and HANDLERS;
//   route(incident, o)                    asks every question at once (split into calls of MAX_QUESTIONS, the two
//                                          planted questions in each), sends core.png, oracle.png and diff.png, appends
//                                          one `route` status record to ledger/incidents.jsonl carrying the sensor
//                                          reading under ROUTE_SENSOR_KEY (top-p, p(other), abstain, decoy and twin),
//                                          one spend record per call (role "router"), logs each call to the telemetry
//                                          `llm` stream with its latency and the reading to the `loop` stream;
//   routeSensor(subsystem, controls)      pure: the sensor reading; abstain is 1 when top-p < ROUTE_ABSTAIN_P or
//                                          `other` wins, and loop/policies.ts subsystemOf then narrows nothing;
//   routeFamily(family, skills, o)        the same router on a family repair task (S15-R3): subsystem and applies:
//                                          per skill plus the planted pair, no ledger status record;
//   routeSkills(incident, skills, k)      pure: the k skill ids with the highest applies: probability;
//   routeCalibration(ledgerDir)           Brier, accuracy, AUROC, reliability bins, abstention, planted-question and
//                                          forecast scores from the ledger only, each with n.
// Every call takes its client from loop/subq.ts subqClient() (record/replay cache) unless one is passed.
// CLI: `pnpm route INC-NNNN | --all | --calibration`. Tests: loop/route.test.ts, loop/sensors.test.ts (fake clients).

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { all, append, ledgerDir, read, runId, status, LINE_LIMIT } from "./ledger.ts";
import { listSkills } from "./shown.ts";
import { routedSubsystem } from "./policies.ts";
import { FORECAST_FIELDS, ROUTE_SENSOR_KEY, SUBQ_ENDPOINT, SUBQ_MODEL, subqClient, type SubqAnswer, type SubqClient, type SubqImage, type SubqQuestion, type SubqReply, type SubqRequest } from "./subq.ts";
import { auroc, brier, reliability, type ReliabilityBin } from "./sensor-stats.ts";
import { tlog } from "../src/telemetry.ts";
import { HANDLERS } from "../core/index.ts";
import type { Attempt, Fire, Incident, Observation, ProvenanceEntry, SpendRecord, StatusRecord, Verdict } from "../src/schema.ts";

// The wire lives in loop/subq.ts; these re-exports keep S17's import sites.
export { SUBQ_ENDPOINT, SUBQ_MODEL, ROUTE_SENSOR_KEY, httpClient, subqKey } from "./subq.ts";
export { routedSubsystem } from "./policies.ts";
export type { ScoreQuestion, SubqQuestion, SubqImage, SubqRequest, SubqAnswer, SubqResponse, SubqReply, SubqClient } from "./subq.ts";

/** Questions per request: the docs' cap of 1–128. The questions past one call's share go into a second call. */
export const MAX_QUESTIONS = 128;
/** The planted questions every call carries (one decoy applies:, one subsystem twin); they count against MAX_QUESTIONS. */
export const PLANTED_PER_CALL = 2;
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
 * Top subsystem probability below which the route abstains: it nominates the fallback (no focus narrowing,
 * loop/policies.ts subsystemOf) and writes abstain 1 in its sensor reading. 0.35 is set by the S17b brief before
 * any run and is never tuned during one.
 */
export const ROUTE_ABSTAIN_P = 0.35;
/** A decoy applies: probability below this reads as rejected (the S17b brief). */
export const DECOY_REJECT_P = 0.5;
/**
 * The pseudo-question under which the route record carries its call meter (questions, calls, input tokens, usd,
 * latency). Incident.route is Record<question, Record<answer, number>>; SPEC §6.5 names no field for the meter
 * (a finding for the orchestrator), so the meter rides inside route under this key.
 */
export const ROUTE_META_KEY = "_call";
/** Bytes fitRoute leaves under LINE_LIMIT for the meter's `dropped` count, written after the fit. */
export const FIT_SLACK_BYTES = 16;

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

// ---- planted questions ----

/**
 * The key of the reworded subsystem question; its options are BASE_QUESTIONS.subsystem's and each criterion restates
 * that option's subsystem criterion at a matched length, adding no mechanism the original lacks, so a disagreement
 * reads instability and not a richer question (loop/sensors.test.ts "twin criteria").
 */
export const TWIN_KEY = "emulator_part";
export const TWIN_QUESTION: SubqQuestion = { type: "choice", instructions: "Which part of the emulator most likely caused the pixels that differ from the hardware reference?",
  criteria: { ppu_fetcher: "pixels misplaced or wrong inside one line while it is drawn", stat_irq: "a mid-frame split happens on the wrong line",
    oam_dma: "objects absent or out of date", window: "window placed wrong or its line count off", timer: "state that depends on timing is off", other: null } };

export interface RouteSkill { id: string; firesWhen: string; notThis: string; paths: string[] }

/**
 * Skill-shaped criteria from subsystems no frame divergence reaches (audio, serial link, joypad, cartridge RAM), the
 * source of the decoy applies: question. Each not-this names a neighbouring mechanism of the same subsystem, the form
 * a skill's not-this takes ("CPU timing", loop/fixtures/harness.ts), never the picture: a not-this reading "any
 * picture difference" answers the question for every frame incident. A route that gives one of them >=
 * DECOY_REJECT_P fails to reject it.
 */
export const DECOY_POOL: readonly Omit<RouteSkill, "id">[] = [
  { firesWhen: "a write to NR10 (0xFF10) changes the channel 1 frequency sweep and the sweep steps at the wrong rate", notThis: "channel 1 volume envelope", paths: ["core/index.ts"] },
  { firesWhen: "a serial transfer started through SC (0xFF02) completes after the wrong number of cycles and link bytes arrive late", notThis: "serial interrupt enable", paths: ["core/index.ts"] },
  { firesWhen: "P1 (0xFF00) returns the wrong button group for its select bits, so a held button is never seen by the game", notThis: "joypad interrupt timing", paths: ["core/index.ts"] },
  { firesWhen: "cartridge RAM enabled by a 0x0A write to 0x0000-0x1FFF loses its saved bytes across a power cycle", notThis: "ROM bank switching", paths: ["core/mbc1.ts"] },
  { firesWhen: "wave RAM (0xFF30-0xFF3F) read while channel 3 plays returns the wrong sample byte", notThis: "channel 3 output level", paths: ["core/index.ts"] },
  { firesWhen: "the channel 4 noise generator in 7-bit mode repeats with the wrong period, so the hiss sounds tonal", notThis: "channel 4 length counter", paths: ["core/index.ts"] },
];

const hash32 = (s: string, salt: string) => createHash("sha256").update(`${salt}:${s}`).digest().readUInt32BE(0);

/** The applies: question for one skill (buildQuestions' form; the decoy uses it too, so the two read alike). */
function appliesQuestion(s: RouteSkill): SubqQuestion {
  return { type: "noul", instructions: `Does skill ${s.id} apply to this incident: would a repairer fixing it touch what the skill covers?`,
    criteria: { true: `fires when: ${s.firesWhen}; paths: ${s.paths.join(", ")}`.slice(0, CRITERION_CHARS), false: `not this: ${s.notThis}`.slice(0, CRITERION_CHARS) } };
}

export interface Planted { decoyKey: string; decoy: SubqQuestion; twinKey: string; twin: SubqQuestion; seed: string }

/**
 * The planted pair for `seed` (an incident or family id), chosen deterministically from it: the DECOY_POOL entry, and
 * an SKL-shaped label one to three past the highest routed skill id, so it collides with none.
 */
export function controlsFor(seed: string, skills: Pick<RouteSkill, "id">[]): Planted {
  const top = Math.max(0, ...skills.map((s) => Number(/^SKL-(\d+)$/.exec(s.id)?.[1] ?? 0)));
  const id = `SKL-${String(top + 1 + (hash32(seed, "label") % 3)).padStart(4, "0")}`;
  const d = DECOY_POOL[hash32(seed, "pool") % DECOY_POOL.length];
  return { decoyKey: `applies:${id}`, decoy: appliesQuestion({ id, ...d }), twinKey: TWIN_KEY, twin: TWIN_QUESTION, seed };
}

/**
 * One call's questions with the planted pair inserted at positions seeded by `p.seed` and the call index: the twin
 * among the first questions; the decoy inside the call's run of applies: questions, or where that run stands when
 * the call has none (after the base questions and the twin, before every same_shape_as), so its position is one a
 * real applies: question takes (loop/sensors.test.ts "decoy position").
 */
export function withPlanted(chunk: Record<string, SubqQuestion>, p: Planted, index: number): Record<string, SubqQuestion> {
  const entries = Object.entries(chunk);
  const n = entries.length;
  entries.splice(1 + (hash32(`${p.seed}:${index}`, "twin") % Math.max(1, Math.min(n, 3))), 0, [p.twinKey, p.twin]);
  const ks = entries.map(([k]) => k);
  const first = ks.findIndex((k) => k.startsWith("applies:"));
  const after = (pred: (k: string) => boolean, from: number) => ks.reduce((at, k, i) => (pred(k) ? i + 1 : at), from);
  const lo = first >= 0 ? first : after((k) => k in BASE_QUESTIONS || k === p.twinKey, 0);
  const hi = first >= 0 ? after((k) => k.startsWith("applies:"), lo) : lo;
  entries.splice(lo + (hash32(`${p.seed}:${index}`, "decoy") % (hi - lo + 1)), 0, [p.decoyKey, p.decoy]);
  return Object.fromEntries(entries);
}

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
  for (const s of skills) q[`applies:${s.id}`] = appliesQuestion(s);
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

const round = (p: number) => Number(p.toFixed(PROB_DECIMALS));

/** One answer as Record<answer, probability>: noul → {yes}, choice and score → their probabilities (score adds `score`). */
export function answerProbs(a: SubqAnswer): Record<string, number> {
  if (a.type === "noul") return { yes: round(a.noul) };
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(a.probabilities ?? {})) out[k] = round(v);
  if (a.type === "score") out.score = round(a.score);
  return out;
}

/** The client a route uses when none is passed: loop/subq.ts subqClient(), else one that answers "no client". */
const NO_CLIENT: SubqClient = async () => ({ status: 0, body: null, error: "no SubQ client: no key, or a test process without setSubqClient", wall_ms: 0 });
export const defaultClient = (): SubqClient => subqClient() ?? NO_CLIENT;

export interface Asked { reply: SubqReply; n_input: number; usd: number }

/**
 * One SubQ call with its records: an `llm` request and response record (latency, and whether the cache served it)
 * and, for a live call, one ledger/spend.jsonl record, role "router". `subject` names what the call is about.
 */
export async function askSubq(client: SubqClient, req: SubqRequest, o: { ledger: string; subject: Record<string, string>; purpose: string }): Promise<Asked> {
  tlog("llm", "request", { role: "router", purpose: o.purpose, model_requested: req.model, endpoint: SUBQ_ENDPOINT, ...o.subject, questions: req.questions, state: req.state,
    n_images: req.images?.length ?? 0, image_bytes: (req.images ?? []).map((i) => i.base64.length) });
  const r = await client(req);
  const nIn = r.body?.usage?.input_tokens ?? 0;
  // a cached answer spends nothing: the live call that recorded it was priced once
  const usd = r.cached ? 0 : nIn * SUBQ_USD_PER_INPUT_TOKEN;
  // usage keys avoid "token" in their names: src/telemetry.ts redact() blanks any field matching /token/
  tlog("llm", "response", { role: "router", purpose: o.purpose, model_requested: req.model, model_echoed: r.body?.model ?? "", ...o.subject, outcome: r.error ? "failed" : "ok", error: r.error ?? null,
    http_status: r.status, cached: !!r.cached, n_questions: Object.keys(req.questions).length, n_input: nIn, usd, wall_ms: r.wall_ms, answers: r.body?.answers ?? null });
  if (!r.cached) {
    const rec: SpendRecord = { at: new Date().toISOString(), run: runId(), role: "router", model: r.body?.model || `${req.model} (not echoed)`, tokens_in: nIn, tokens_out: 0, usd };
    append("spend.jsonl", rec, o.ledger);
  }
  return { reply: r, n_input: nIn, usd };
}

export interface RouteMeter { questions: number; calls: number; images: number; tokens_in: number; usd: number; ms: number; state_bytes: number; dropped: number; failed: number; cached: number }
export interface RouteOutcome { incident: string; route: Record<string, Record<string, number>>; meter: RouteMeter; errors: string[]; sensor: Record<string, number> | null }
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

export interface PlantedAnswers { decoy?: number; twin?: Record<string, number> }

const argmax = (r: Record<string, number>) => Object.keys(r).reduce((b, k) => (r[k] > r[b] ? k : b), Object.keys(r)[0]);

/**
 * Pure: the sensor reading of one route. top_p and p_other read the subsystem answer; abstain is 1 when top_p <
 * ROUTE_ABSTAIN_P or `other` is the top option. decoy_yes and decoy_rejected (decoy_yes < DECOY_REJECT_P) read the
 * planted applies: answer; twin_agree (same top option) and twin_dp (|Δp| on the subsystem's top option) the twin.
 * Null without a subsystem answer.
 */
export function routeSensor(sub: Record<string, number> | undefined, planted: PlantedAnswers): Record<string, number> | null {
  if (!sub || !Object.keys(sub).length) return null;
  const top = argmax(sub);
  const out: Record<string, number> = { top_p: sub[top], p_other: sub.other ?? 0, abstain: sub[top] < ROUTE_ABSTAIN_P || top === "other" ? 1 : 0 };
  if (typeof planted.decoy === "number") { out.decoy_yes = planted.decoy; out.decoy_rejected = planted.decoy < DECOY_REJECT_P ? 1 : 0; }
  const tw = planted.twin;
  if (tw && Object.keys(tw).length) {
    out.twin_agree = argmax(tw) === top ? 1 : 0;
    out.twin_dp = round(Math.abs(sub[top] - (tw[top] ?? 0)));
  }
  return out;
}

interface Asking { questions: Record<string, SubqQuestion>; planted: Planted; state: unknown; images: SubqImage[]; subject: Record<string, string>; purpose: string }
interface AskedAll { route: Record<string, Record<string, number>>; planted: PlantedAnswers; meter: RouteMeter; errors: string[] }

/** Asks `questions` in calls of MAX_QUESTIONS, the planted pair in each; returns the answers with the pair set apart. */
async function askAll(client: SubqClient, ledger: string, a: Asking): Promise<AskedAll> {
  const route: Record<string, Record<string, number>> = {};
  const planted: PlantedAnswers = {};
  const meter: RouteMeter = { questions: Object.keys(a.questions).length, calls: 0, images: a.images.length, tokens_in: 0, usd: 0, ms: 0, state_bytes: Buffer.byteLength(JSON.stringify(a.state)), dropped: 0, failed: 0, cached: 0 };
  const errors: string[] = [];
  for (const [i, chunk] of chunkQuestions(a.questions, MAX_QUESTIONS - PLANTED_PER_CALL).entries()) {
    const req: SubqRequest = { model: SUBQ_MODEL, state: a.state, questions: withPlanted(chunk, a.planted, i), ...(a.images.length ? { images: a.images } : {}) };
    const { reply: r, n_input, usd } = await askSubq(client, req, { ledger, subject: a.subject, purpose: a.purpose });
    meter.calls++; meter.ms += r.wall_ms; meter.tokens_in += n_input; meter.usd += usd; if (r.cached) meter.cached++;
    if (r.error || !r.body) { meter.failed++; errors.push(r.error ?? "empty body"); continue; }
    for (const [k, ans] of Object.entries(r.body.answers ?? {})) {
      const p = answerProbs(ans);
      // the planted pair is never routed on: the first call's answers make the reading; later calls' stay in telemetry
      if (k === a.planted.decoyKey) { planted.decoy ??= p.yes; continue; }
      if (k === a.planted.twinKey) { planted.twin ??= p; continue; }
      route[k] = p;
    }
  }
  return { route, planted, meter, errors };
}

/** Routes one incident (see the file header). */
export async function route(inc: Incident, o: RouteOpts = {}): Promise<RouteOutcome> {
  const root = o.root ?? resolve(import.meta.dirname, "..");
  const dir = o.ledger ?? ledgerDir();
  const skills = o.skills ?? routableSkills(o.skillsDir ?? join(root, "skills"));
  const obs = (o.observations ?? all<Observation>("observations.jsonl", dir)).filter((x) => x.anchor?.incident !== inc.id).slice(-RECENT_OBSERVATIONS);
  const { route: routeRec, planted, meter, errors } = await askAll(o.client ?? defaultClient(), dir, { questions: buildQuestions(skills, obs), planted: controlsFor(inc.id, skills),
    state: buildState(inc, root), images: evidenceImages(inc, root), subject: { incident: inc.id }, purpose: "route" });
  // failed: calls that returned an error, so a record missing answers reads as a partial failure, not as SubQ's answer
  routeRec[ROUTE_META_KEY] = { questions: meter.questions, calls: meter.calls, failed: meter.failed, images: meter.images, n_input: meter.tokens_in, usd: Number(meter.usd.toPrecision(4)), ms: meter.ms, state_bytes: meter.state_bytes, dropped: 0 };
  const sensor = routeSensor(routeRec.subsystem, planted);
  if (sensor) routeRec[ROUTE_SENSOR_KEY] = sensor;
  meter.dropped = fitRoute(inc.id, routeRec);
  routeRec[ROUTE_META_KEY].dropped = meter.dropped;
  if (meter.failed < meter.calls) {
    status("incidents.jsonl", inc.id, "route", routeRec, dir);
    tlog("loop", "route.sensor", { incident: inc.id, subsystem: routeRec.subsystem ?? null, routed: routedSubsystem(routeRec), fallback: !!sensor?.abstain, ...(sensor ?? {}), ms: meter.ms, usd: meter.usd, cached: meter.cached });
  }
  return { incident: inc.id, route: routeRec, meter, errors, sensor };
}

// ---- family repair tasks (S15-R3) ----

export interface FamilyRouteOpts { client?: SubqClient; ledger?: string; root?: string; roms?: string[] }

/** The state of a family repair task: the family, its ROM names, the core file list and HANDLERS; no split reading. */
export function familyState(family: string, roms: string[], root: string): Record<string, unknown> {
  const coreDir = join(root, "core");
  const files = existsSync(coreDir) ? readdirSync(coreDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort().map((f) => `core/${f}`) : [];
  return {
    task: { kind: "family", family, note: "a repairer edits the emulator core until this family's hardware test ROMs pass; there is no incident frame" },
    roms: roms.map((r) => r.split("/").slice(-2).join("/")),
    core: { files, handlers: HANDLERS },
  };
}

/** The subsystem question asked of a family's failures instead of a frame divergence; the options are §6.13's. */
const FAMILY_SUBSYSTEM: SubqQuestion = { ...BASE_QUESTIONS.subsystem, instructions: "Which emulator subsystem do this test family's failures most likely come from?" };

/**
 * Routes a family repair task: subsystem and one applies: per skill, with the planted pair; returns the route record
 * with its sensor reading under ROUTE_SENSOR_KEY, or null when every call failed or no client is available (no call
 * is made then). Writes spend and telemetry only.
 */
export async function routeFamily(family: string, skills: RouteSkill[], o: FamilyRouteOpts = {}): Promise<Record<string, Record<string, number>> | null> {
  const root = o.root ?? resolve(import.meta.dirname, "..");
  const dir = o.ledger ?? ledgerDir();
  const client = o.client ?? subqClient();
  if (!client) return null;
  const questions = { subsystem: FAMILY_SUBSYSTEM, ...Object.fromEntries(Object.entries(buildQuestions(skills, [])).filter(([k]) => k.startsWith("applies:"))) };
  const { route: rec, planted, meter } = await askAll(client, dir, { questions, planted: controlsFor(family, skills),
    state: familyState(family, o.roms ?? [], root), images: [], subject: { family }, purpose: "route.family" });
  if (meter.failed >= meter.calls) return null;
  const sensor = routeSensor(rec.subsystem, planted);
  if (sensor) rec[ROUTE_SENSOR_KEY] = sensor;
  tlog("loop", "route.family", { family, route: rec, ms: meter.ms, usd: meter.usd, cached: meter.cached });
  return rec;
}

/** Pure: the k skill ids with the highest applies:<id> probability; unrouted skills last; ties by id. */
export function routeSkills(inc: Pick<Incident, "route">, skills: string[], k: number): string[] {
  const p = (id: string) => inc.route?.[`applies:${id}`]?.yes ?? -1;
  return [...skills].sort((a, b) => p(b) - p(a) || a.localeCompare(b)).slice(0, Math.max(0, k));
}

// ---- calibration ----

export interface CalibrationScore { n: number; brier: number | null; accuracy: number | null }
/**
 * wrong: scored rows whose top option is outside the truth set. steered: routes left unscored because the only
 * GRADUATE repair touching core ran under a policy (circular). chance: the mean share of a row's options inside its
 * truth set, the accuracy a uniform pick would reach; a file holds several subsystems' handlers, so chance sits well
 * above 1 / options and accuracy reads only against it.
 */
export interface SubsystemScore extends CalibrationScore { wrong: number; steered: number; chance: number | null; auroc_uncertainty: number | null; auroc_other: number | null }
export interface AppliesScore extends CalibrationScore { reliability: ReliabilityBin[] }
/** `hits` of `n` rows, and their rate (null on n = 0). */
export interface RateScore { n: number; hits: number; rate: number | null }
export interface RouteCalibration {
  routed: number;
  subsystem: SubsystemScore;
  applies: AppliesScore;
  /** hits: routes that abstained, over routes carrying a sensor reading. */
  abstention: RateScore;
  /** hits: decoys rejected; twin hits: same top option, mean_dp the mean |Δp|. */
  decoy: RateScore;
  twin: RateScore & { mean_dp: number | null };
  /** Pass forecasts against GRADUATE; mechanism forecasts (yes >= 0.5) agreeing with the H-no-regress check. */
  forecast_pass: { n: number; brier: number | null; auroc: number | null };
  forecast_mechanism: RateScore;
}

function score(rows: { brier: number; hit: boolean }[]): CalibrationScore {
  if (!rows.length) return { n: 0, brier: null, accuracy: null };
  return { n: rows.length, brier: rows.reduce((s, r) => s + r.brier, 0) / rows.length, accuracy: rows.filter((r) => r.hit).length / rows.length };
}
const rate = (flags: boolean[]): RateScore => ({ n: flags.length, hits: flags.filter(Boolean).length, rate: flags.length ? flags.filter(Boolean).length / flags.length : null });

/**
 * Calibration from the ledger only (D-0004: never trusted blind); writes nothing (routeCalibration logs it).
 * subsystem: truth is the set of subsystems of the core files a GRADUATED repair of the incident touched, read from
 *   ledger/provenance.json entries naming that attempt, mapped through HANDLERS and HANDLER_SUBSYSTEM. A file holds
 *   several handlers (core/ppu.ts), so truth is a set: a hit is the top choice in the set, and the Brier target
 *   spreads mass 1 evenly over the set. A miss is a wrong route: auroc_uncertainty scores 1 − top-p, auroc_other
 *   scores p(other), each at ranking wrong routes above right ones. A GRADUATE attempt that named a policy is not
 *   truth (a focus or routing policy points the repair at the routed subsystem); `steered` counts the routes so
 *   dropped, and `chance` is the accuracy a uniform pick reaches against the same truth sets.
 * applies: truth is whether the skill fired (ledger/fires.jsonl) in an attempt on that incident started after the
 *   route record and showing that skill; reliability bins those rows (loop/sensor-stats.ts).
 * abstention, decoy, twin: every route record's sensor reading; no truth is needed.
 * forecast_pass: Attempt.forecast_pass.yes against the attempt's verdict being GRADUATE (Brier, AUROC).
 * forecast_mechanism: Attempt.forecast_mechanism.yes >= 0.5 agreeing with the verdict's H-no-regress pass.
 * n counts scored rows; with none, n = 0 and every figure is null, never 0.
 */
export function routeCalibrationOf(dir = ledgerDir()): RouteCalibration {
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
  const attemptVerdict = new Map(verdicts.filter((v) => v.subject?.kind === "attempt").map((v) => [v.subject.id, v]));
  const graduated = new Set([...attemptVerdict.values()].filter((v) => v.decision === "GRADUATE").map((v) => v.subject.id));
  const subRows: { brier: number; hit: boolean; top_p: number; p_other: number; chance: number }[] = [];
  let steeredRows = 0;
  const appRows: { brier: number; hit: boolean; p: number; y: 0 | 1 }[] = [];
  const sensors = incidents.map((i) => i.route?.[ROUTE_SENSOR_KEY]).filter((s): s is Record<string, number> => !!s);
  for (const inc of incidents) {
    const sub = inc.route?.subsystem;
    if (sub) {
      const truth = new Set<string>();
      let steered = false;
      for (const a of attempts) {
        if (a.task?.incident !== inc.id || !graduated.has(a.id)) continue;
        const touched = prov.filter((e) => e.attempt === a.id);
        // a repair made under a policy may have been pointed at the routed subsystem's region, so its files would
        // confirm the route that chose them: that row is circular and is not scored
        if (touched.length && a.task.policies?.length) { steered = true; continue; }
        for (const e of touched) for (const s of fileSubsystems.get(e.file) ?? []) truth.add(s);
      }
      if (steered && !truth.size) steeredRows++;
      if (truth.size) {
        const top = argmax(sub);
        const b = Object.keys(sub).reduce((s, k) => s + (sub[k] - (truth.has(k) ? 1 / truth.size : 0)) ** 2, 0);
        const options = Object.keys(sub);
        subRows.push({ brier: b, hit: truth.has(top), top_p: sub[top], p_other: sub.other ?? 0, chance: options.filter((k) => truth.has(k)).length / options.length });
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
      appRows.push({ brier: (v.yes - y) ** 2, hit: (v.yes >= 0.5 ? 1 : 0) === y, p: v.yes, y });
    }
  }
  const passRows: { p: number; y: 0 | 1 }[] = [];
  const mechFlags: boolean[] = [];
  for (const a of attempts) {
    const v = attemptVerdict.get(a.id);
    if (!v) continue;
    const fp = a[FORECAST_FIELDS.pass]?.yes;
    if (typeof fp === "number") passRows.push({ p: fp, y: v.decision === "GRADUATE" ? 1 : 0 });
    const fm = a[FORECAST_FIELDS.mechanism]?.yes;
    const h = v.checks?.find((c) => c.name === "H-no-regress");
    if (typeof fm === "number" && h) mechFlags.push((fm >= 0.5) === h.pass);
  }
  const twins = sensors.filter((s) => typeof s.twin_agree === "number");
  return {
    routed: incidents.length,
    subsystem: { ...score(subRows), wrong: subRows.filter((r) => !r.hit).length, steered: steeredRows,
      chance: subRows.length ? subRows.reduce((s, r) => s + r.chance, 0) / subRows.length : null,
      auroc_uncertainty: auroc(subRows.map((r) => ({ score: 1 - r.top_p, label: r.hit ? 0 : 1 }))),
      auroc_other: auroc(subRows.map((r) => ({ score: r.p_other, label: r.hit ? 0 : 1 }))) },
    applies: { ...score(appRows), reliability: reliability(appRows) },
    abstention: rate(sensors.map((s) => s.abstain === 1)),
    decoy: rate(sensors.filter((s) => typeof s.decoy_yes === "number").map((s) => s.decoy_rejected === 1)),
    twin: { ...rate(twins.map((s) => s.twin_agree === 1)), mean_dp: twins.length ? twins.reduce((x, s) => x + s.twin_dp, 0) / twins.length : null },
    forecast_pass: { n: passRows.length, brier: brier(passRows), auroc: auroc(passRows.map((r) => ({ score: r.p, label: r.y }))) },
    forecast_mechanism: rate(mechFlags),
  };
}

/** routeCalibrationOf, logged to the `loop` stream as router-calibration. */
export function routeCalibration(dir = ledgerDir()): RouteCalibration {
  const out = routeCalibrationOf(dir);
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
    console.log(`${inc.id}: ${m.questions} questions + ${PLANTED_PER_CALL} planted in ${m.calls} call(s) (${m.cached} served from cache), ${m.images} images, ${m.tokens_in} input tokens, $${m.usd.toFixed(6)}, ${m.ms} ms${r.errors.length ? `, errors: ${r.errors.join("; ")}` : ""}`);
    console.log(`  subsystem ${JSON.stringify(r.route.subsystem ?? null)} mid_line ${JSON.stringify(r.route.mid_line ?? null)} severity ${JSON.stringify(r.route.severity ?? null)}`);
    console.log(`  sensor ${JSON.stringify(r.sensor)} nominates ${JSON.stringify(routedSubsystem(r.route) ?? "fallback (no focus narrowing)")}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main(process.argv.slice(2));
