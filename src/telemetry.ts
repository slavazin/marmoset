// The one telemetry seam (owner directive 2026-11-07: log everything, replayable for judges).
// Every process appends what it sees here; the UI's replay mode (ui/replay) plays a run back from these files.
// Telemetry is not a ledger: it lives under runs/<run>/telemetry/ (or runs/prerun/telemetry/ before a run opens),
// enters no figure on its own (G9 figures read ledger/ and runs/ records), and is append-only by construction.
//
// Streams (one JSONL file each, <stream>.jsonl):
//   ui      every UiEvent the server publishes (§6.18), frames sampled per TELEMETRY_FRAME_HZ
//   input   every button-mask change from keyboard, explorer or Gemini, with its counter
//   llm     every model call: role, model requested and echoed, request (keys redacted), response text, tokens, wall ms, outcome
//   muse    every Muse Code MSP record of every attempt, keyed by attempt id
//   loop    every loop step: incident opened, attempt start/end, gate check start/reading, verdict, skill moves
//   spot    every Gemini visual-sensor answer and its oracle scoring
//   process process start/stop, argv, git commit, env NAMES (never values)
import { appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export type TelemetryStream = "ui" | "input" | "llm" | "muse" | "loop" | "spot" | "process";
export interface TelemetryRecord { at: string; seq: number; pid: number; run: string | null; stream: TelemetryStream; kind: string; data: unknown }

/** Frames per second per source kept in the ui stream; the rest are reproducible from the input stream and the core commit (D-0007). */
export const TELEMETRY_FRAME_HZ = 1; // 23,040-byte frames at 1 Hz per source keep a 75-minute run near 140 MB before compression

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let seq = 0;

/** The open run's id: RATCHET_RUN if set, else the highest runs/RUN-NNNN with a manifest, else null. */
export function currentRun(): string | null {
  if (process.env.RATCHET_RUN) return process.env.RATCHET_RUN;
  try {
    const runs = readdirSync(join(ROOT, "runs")).filter((d) => /^RUN-\d{4}$/.test(d)).sort();
    return runs.at(-1) ?? null;
  } catch { return null; }
}

const SECRET_KEY = /authorization|api[-_]?key|token|secret|password|muse_code_key/i;
/** Replaces the value of any field whose name looks like a secret with "[redacted]", recursively. */
export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(x);
    return out;
  }
  return v;
}

/** Appends one record to runs/<run|prerun>/telemetry/<stream>.jsonl. Never throws into the caller's path. */
export function tlog(stream: TelemetryStream, kind: string, data: unknown): void {
  const run = currentRun();
  const dir = process.env.RATCHET_TELEMETRY_DIR ?? join(ROOT, "runs", run ?? "prerun", "telemetry");
  const rec: TelemetryRecord = { at: new Date().toISOString(), seq: seq++, pid: process.pid, run, stream, kind, data: redact(data) };
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, `${stream}.jsonl`), JSON.stringify(rec) + "\n");
  } catch (e) {
    process.stderr.write(`telemetry: append failed (${(e as Error).message})\n`);
  }
}
