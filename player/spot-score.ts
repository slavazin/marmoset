// Scores each visual-sensor answer against the oracle's truth for its counter (S13): the deterministic check on
// an LLM's eye. truthOf diffs our core's frame against the oracle's (lockstep/diff.ts frameDiff); scoreAnswer
// names the outcome: tp (flagged, real diff, bbox IoU >= SPOT_IOU_MIN), fp (flagged, no diff), fn (real diff
// not flagged, or flagged with the box elsewhere: `mislocated`), tn. recordSpot appends one SPT record to
// ledger/spots.jsonl through loop/ledger.ts; a tp on an incident appends a `spot` status record on it; a flag
// on a clean frame is kind "sensor-only" and opens nothing (the oracle decides, D-0004). spotSummary reads
// ledger/spots.jsonl only (G9), folding in subsystem agreement where a verdict carries one.
import { all, appendNew, ledgerDir, runId, status, type LedgerFile } from "../loop/ledger.ts";
import { frameDiff } from "../lockstep/diff.ts";
import type { Incident, Verdict } from "../src/schema.ts";
import { tlog } from "../src/telemetry.ts";
import type { Subsystem } from "./vision.ts";

/**
 * A flag counts as a hit only if its box overlaps the true diff box by at least this IoU. Set loose, 0.1: a
 * model box drawn on a 4×-scaled image around an 8-line band is coarse; not yet tuned against a reading.
 */
export const SPOT_IOU_MIN = 0.1;
/** The ledger file and id prefix of sensor records; neither is in src/schema.ts yet (a finding). */
export const SPOTS_FILE = "spots.jsonl" as LedgerFile;
export const SPOT_PREFIX = "SPT";
/** Characters of the model's `why` kept in the record, so a line stays under loop/ledger.ts LINE_LIMIT. */
export const SPOT_WHY_MAX = 400;

export type Box = [number, number, number, number];
/** The sensor's answer with its box in frame pixels, [x0, y0, x1, y1], x1 and y1 exclusive. */
export interface SpotAnswer { glitch: boolean; confidence: number; bbox: Box | null; subsystem: Subsystem; why: string }
export interface SpotTruth { diff: boolean; pixels: number; box: Box | null }
export type Outcome = "tp" | "fp" | "fn" | "tn";
export interface SpotScore { outcome: Outcome | "failed"; iou: number | null; mislocated?: boolean }
export type SampledBy = "opening" | "control" | "every";

/** Proposed shape for src/schema.ts (a finding): one ledger/spots.jsonl record. */
export interface Spot {
  id: string; at: string; run: string | null;
  kind: "scored" | "sensor-only" | "failed";
  counter: number; rom_sha: string; trace_sha: string;
  sampled_by: SampledBy[];
  answer: SpotAnswer | null; truth: SpotTruth; score: SpotScore;
  incident?: string;
  model: string; calls: number; tokens_in: number; tokens_out: number; ms: number;
  failure?: string;
}

export function truthOf(core: Uint8Array, oracle: Uint8Array): SpotTruth {
  const d = frameDiff(core, oracle);
  return { diff: d.pixels > 0, pixels: d.pixels, box: d.pixels ? d.box : null };
}

export function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const area = (r: Box) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
  const union = area(a) + area(b) - inter;
  return union > 0 ? inter / union : 0;
}

export function scoreAnswer(answer: SpotAnswer | null, truth: SpotTruth): SpotScore {
  if (!answer) return { outcome: "failed", iou: null };
  if (!truth.diff) return { outcome: answer.glitch ? "fp" : "tn", iou: null };
  if (!answer.glitch) return { outcome: "fn", iou: null };
  const o = answer.bbox && truth.box ? iou(answer.bbox, truth.box) : 0;
  return o >= SPOT_IOU_MIN ? { outcome: "tp", iou: o } : { outcome: "fn", iou: o, mislocated: true };
}

export interface RecordInput {
  counter: number; rom_sha: string; trace_sha: string; sampled_by: SampledBy[];
  answer: SpotAnswer | null; truth: SpotTruth; incident?: string;
  model: string; calls: number; tokens_in: number; tokens_out: number; ms: number; failure?: string;
  /** Whether a tp may append its `spot` status on `incident` (once per incident per run, the caller decides). */
  attach: boolean;
}

/** Scores one answer, appends its SPT record and, on a tp with an incident, the incident's `spot` status record. */
export function recordSpot(r: RecordInput, dir = ledgerDir()): Spot {
  const score = scoreAnswer(r.answer, r.truth);
  const answer = r.answer ? { ...r.answer, why: r.answer.why.slice(0, SPOT_WHY_MAX) } : null;
  const kind: Spot["kind"] = score.outcome === "failed" ? "failed" : score.outcome === "fp" ? "sensor-only" : "scored";
  const rec = appendNew(SPOTS_FILE, SPOT_PREFIX as never, (id): Spot => ({
    id, at: new Date().toISOString(), run: runId(), kind, counter: r.counter, rom_sha: r.rom_sha, trace_sha: r.trace_sha,
    sampled_by: r.sampled_by, answer, truth: r.truth, score,
    ...(r.incident && score.outcome !== "fp" ? { incident: r.incident } : {}),
    model: r.model, calls: r.calls, tokens_in: r.tokens_in, tokens_out: r.tokens_out, ms: Math.round(r.ms),
    ...(r.failure ? { failure: r.failure.slice(0, SPOT_WHY_MAX) } : {}),
  }), dir);
  if (score.outcome === "tp" && r.incident && r.attach && answer)
    status("incidents.jsonl", r.incident, "spot", { spot: rec.id, subsystem: answer.subsystem, bbox: answer.bbox, confidence: answer.confidence }, dir);
  tlog("spot", "scored", rec);
  return rec;
}

export interface SpotSummary {
  n: number; tp: number; fp: number; fn: number; tn: number; failed: number;
  precision: number | null; recall: number | null;
  /** Of tp records whose incident has a verdict naming a subsystem: how many the sensor named the same. */
  subsystem: { agree: number; disagree: number; unknown: number };
}

/**
 * The UI-readable figure (G9): counts read from ledger/spots.jsonl only. Subsystem agreement reads a
 * GRADUATE verdict's `subsystem` field for the attempt on the spot's incident; src/schema.ts Verdict has no
 * such field yet (a finding), so until it does every tp counts `unknown`.
 */
export function spotSummary(dir = ledgerDir()): SpotSummary {
  const spots = all<Spot>(SPOTS_FILE, dir);
  const c = { tp: 0, fp: 0, fn: 0, tn: 0, failed: 0 };
  for (const s of spots) c[s.score.outcome]++;
  const n = c.tp + c.fp + c.fn + c.tn;
  const subsystem = { agree: 0, disagree: 0, unknown: 0 };
  const tps = spots.filter((s) => s.score.outcome === "tp" && s.incident);
  if (tps.length) {
    const incidents = new Map(all<Incident>("incidents.jsonl", dir).map((i) => [i.id, i]));
    const attempts = all<{ id: string; task?: { incident?: string } }>("attempts.jsonl", dir);
    const verdicts = all<Verdict & { subsystem?: string }>("verdicts.jsonl", dir);
    for (const s of tps) {
      const inc = incidents.get(s.incident!);
      const atts = new Set(attempts.filter((a) => a.task?.incident === s.incident).map((a) => a.id));
      const v = verdicts.find((x) => x.decision === "GRADUATE" && atts.has(x.subject.id) && typeof x.subsystem === "string");
      if (inc?.status !== "repaired" || !v) subsystem.unknown++;
      else if (v.subsystem === s.answer?.subsystem) subsystem.agree++;
      else subsystem.disagree++;
    }
  }
  return {
    n, ...c,
    precision: c.tp + c.fp ? c.tp / (c.tp + c.fp) : null,
    recall: c.tp + c.fn ? c.tp / (c.tp + c.fn) : null,
    subsystem,
  };
}
