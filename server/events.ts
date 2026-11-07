// UI events (SPEC §6.18): read the ledger, fold status records, tail the JSONL files, and fan events out over SSE.
// Offers the server (`server/index.ts`) a read-only view of `ledger/` and `runs/`; nothing here writes a ledger file,
// since `loop/ledger.ts` is the one appender (AGENTS.md rule 2).

import { readFileSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { join } from "node:path";
import type { UiEvent, Incident, Attempt, Verdict, Fire, ProvenanceEntry, VRead, StatusRecord } from "../src/schema.ts";

/** Frame events per second per source the bus forwards; SPEC §5 S6 Wiggle sets the ceiling at 30. */
export const MAX_FRAMES_PER_S = 30;
/** Milliseconds between polls of a tailed ledger file; fs.watch alone misses appends on some filesystems. */
export const TAIL_POLL_MS = 500;

/** Ledger file → the UiEvent kind its records become. Files outside this map are not streamed. */
export const STREAMED_FILES = {
  "incidents.jsonl": "incident",
  "attempts.jsonl": "attempt",
  "verdicts.jsonl": "verdict",
  "fires.jsonl": "fire",
} as const;
export type StreamedFile = keyof typeof STREAMED_FILES;

type Rec = Record<string, unknown> & { id: string };

/** Parses JSON lines; a trailing partial line (a reader racing an append, D-0008 residue) is returned as `rest`. */
export function parseJsonl(text: string): { records: unknown[]; rest: string } {
  const lines = text.split("\n");
  const rest = lines.pop() ?? "";
  const records: unknown[] = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    try { records.push(JSON.parse(s)); } catch { /* a malformed line enters no view */ }
  }
  return { records, rest };
}

function isStatus(r: unknown): r is StatusRecord {
  return typeof r === "object" && r !== null && (r as StatusRecord).t === "status";
}

/**
 * Folds a ledger file's records into current objects by id: each status record `{t:"status",id,field,value}`
 * sets `field` on its id, the last one written wins (SPEC §6). Order of first appearance is kept.
 */
export class Fold {
  private byId = new Map<string, Rec>();
  /** Applies one record; returns the id it changed, or null when the record names no known id. */
  apply(r: unknown): string | null {
    if (isStatus(r)) {
      const cur = this.byId.get(r.id);
      if (!cur) return null;
      cur[r.field] = r.value;
      return r.id;
    }
    if (typeof r === "object" && r !== null && typeof (r as Rec).id === "string") {
      const rec = r as Rec;
      const prev = this.byId.get(rec.id);
      this.byId.set(rec.id, prev ? { ...prev, ...rec } : { ...rec });
      return rec.id;
    }
    return null;
  }
  get(id: string): Rec | undefined { return this.byId.get(id); }
  all(): Rec[] { return [...this.byId.values()]; }
}

/** Maps one folded record of `file` to its UiEvent. */
export function toEvent(file: StreamedFile, rec: Rec): UiEvent {
  switch (STREAMED_FILES[file]) {
    case "incident": return { t: "incident", incident: rec as unknown as Incident };
    case "attempt": return { t: "attempt", attempt: rec as unknown as Attempt, phase: rec.result ? "end" : "start" };
    case "verdict": return { t: "verdict", verdict: rec as unknown as Verdict };
    case "fire": return { t: "fire", fire: rec as unknown as Fire };
  }
}

/**
 * The generation curve: skill verdicts carrying trial arms, grouped by the verdict's `generation`, so a generation's
 * trials share its point; a verdict without one takes the generation after the last seen (the ledger order, as
 * before Verdict.generation). Sorted by generation, ledger order within one.
 */
export function curveEvents(verdicts: Rec[]): UiEvent[] {
  const out: { t: "curve"; generation: number; arms: NonNullable<Verdict["arms"]> }[] = [];
  let last = 0;
  for (const v of verdicts as unknown as Verdict[]) {
    if (v.subject?.kind !== "skill" || !v.arms) continue;
    const generation = typeof v.generation === "number" && Number.isFinite(v.generation) ? v.generation : last + 1;
    last = Math.max(last, generation);
    out.push({ t: "curve", generation, arms: v.arms });
  }
  return out.sort((a, b) => a.generation - b.generation);
}

export interface Paths { ledger: string; runs: string; evidence: string }

/** Reads `runs/RUN-*\/vread.json` when one exists; V stays hidden (SPEC §5 S6) until this returns a result. */
export function readVRead(runsDir: string): VRead | null {
  if (!existsSync(runsDir)) return null;
  const runs = readdirSync(runsDir).filter((d) => d.startsWith("RUN-")).sort();
  for (const r of runs.reverse()) {
    const p = join(runsDir, r, "vread.json");
    if (existsSync(p)) {
      try { return JSON.parse(readFileSync(p, "utf8")) as VRead; } catch { return null; }
    }
  }
  return null;
}

export function readProvenance(ledgerDir: string): ProvenanceEntry[] {
  const p = join(ledgerDir, "provenance.json");
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, "utf8")) as ProvenanceEntry[]; } catch { return []; }
}

export interface UiState {
  incidents: Incident[]; attempts: Attempt[]; verdicts: Verdict[]; fires: Fire[];
  provenance: ProvenanceEntry[]; curve: UiEvent[]; vread: VRead | null;
}

type Listener = (e: UiEvent) => void;

/**
 * The event bus: holds one Fold per streamed ledger file, tails each file from its last read offset,
 * and forwards every changed record to subscribers. Frame events published by other producers
 * (lockstep, player) pass through `publish`, which drops frames over MAX_FRAMES_PER_S per source.
 */
export class EventBus {
  private folds = new Map<StreamedFile, Fold>();
  private offsets = new Map<StreamedFile, number>();
  private rests = new Map<StreamedFile, string>();
  private listeners = new Set<Listener>();
  private lastFrameAt = new Map<string, number>();
  private watchers: FSWatcher[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private vreadSeen = false;

  readonly paths: Paths;
  constructor(paths: Paths) {
    this.paths = paths;
    for (const f of Object.keys(STREAMED_FILES) as StreamedFile[]) {
      this.folds.set(f, new Fold());
      this.offsets.set(f, 0);
      this.rests.set(f, "");
    }
    this.poll();
  }

  /** Reads bytes appended to every streamed file since the last read and emits their events. */
  poll(): void {
    for (const f of Object.keys(STREAMED_FILES) as StreamedFile[]) {
      const p = join(this.paths.ledger, f);
      if (!existsSync(p)) continue;
      const size = statSync(p).size;
      let off = this.offsets.get(f)!;
      if (size < off) { off = 0; this.folds.set(f, new Fold()); this.rests.set(f, ""); } // file replaced
      if (size === off) continue;
      const buf = Buffer.alloc(size - off);
      const fd = openSync(p, "r");
      try { readSync(fd, buf, 0, buf.length, off); } finally { closeSync(fd); }
      this.offsets.set(f, size);
      const { records, rest } = parseJsonl(this.rests.get(f)! + buf.toString("utf8"));
      this.rests.set(f, rest);
      const fold = this.folds.get(f)!;
      for (const r of records) {
        const id = fold.apply(r);
        if (!id) continue;
        this.emit(toEvent(f, fold.get(id)!));
        if (f === "verdicts.jsonl") {
          const curve = curveEvents(fold.all());
          const v = fold.get(id) as unknown as Verdict;
          if (v.subject?.kind === "skill" && v.arms) { const last = curve.at(-1); if (last) this.emit(last); }
        }
      }
    }
    if (!this.vreadSeen) {
      const v = readVRead(this.paths.runs);
      if (v) { this.vreadSeen = true; this.emit({ t: "vread", result: v }); }
    }
  }

  /** Starts tailing: fs.watch on the ledger dir plus a TAIL_POLL_MS poll. */
  start(): void {
    try {
      if (existsSync(this.paths.ledger)) this.watchers.push(watch(this.paths.ledger, () => this.poll()));
    } catch { /* polling covers it */ }
    this.timer = setInterval(() => this.poll(), TAIL_POLL_MS);
  }

  stop(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  state(): UiState {
    const all = (f: StreamedFile) => this.folds.get(f)!.all();
    const verdicts = all("verdicts.jsonl");
    return {
      incidents: all("incidents.jsonl") as unknown as Incident[],
      attempts: all("attempts.jsonl") as unknown as Attempt[],
      verdicts: verdicts as unknown as Verdict[],
      fires: all("fires.jsonl") as unknown as Fire[],
      provenance: readProvenance(this.paths.ledger),
      curve: curveEvents(verdicts),
      vread: readVRead(this.paths.runs),
    };
  }

  /** Every event a fresh subscriber needs to rebuild the screen, in ledger order. */
  snapshot(): UiEvent[] {
    const out: UiEvent[] = [];
    for (const f of Object.keys(STREAMED_FILES) as StreamedFile[]) {
      for (const r of this.folds.get(f)!.all()) out.push(toEvent(f, r));
    }
    const s = this.state();
    out.push(...s.curve);
    if (s.vread) out.push({ t: "vread", result: s.vread });
    return out;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Publishes an event from another producer; returns false when a frame is dropped by the per-source rate cap. */
  publish(e: UiEvent, now = Date.now()): boolean {
    if (e.t === "frame") {
      const last = this.lastFrameAt.get(e.source);
      if (last !== undefined && now - last < 1000 / MAX_FRAMES_PER_S) return false;
      this.lastFrameAt.set(e.source, now);
    }
    this.emit(e);
    return true;
  }

  private emit(e: UiEvent): void {
    for (const l of this.listeners) l(e);
  }
}

/** Serialises one event as an SSE message. */
export function sseMessage(e: UiEvent): string {
  return `data: ${JSON.stringify(e)}\n\n`;
}
