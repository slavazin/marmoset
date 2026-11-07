// Run replay. `loadTimeline(paths, run)` merges a run's recorded files into one timeline ordered by wall time:
//   - ledger events, re-derived from ledger/*.jsonl (STREAMED_FILES) by folding each record in file order at its `at`,
//     so every figure a replayed card shows is read from the ledger exactly as live (G9);
//   - producer events (frames, meta, player, core, producer attempts) from runs/<run>/telemetry/ui.jsonl, frames inflated
//     back to UiEvents (server/compact.ts);
//   - every other telemetry record (input, llm, muse, loop, spot, process) as an SSE `telemetry` event for the inspector.
// `ReplayPlayer` re-emits the timeline on its recorded clock through the server's SSE (server/index.ts in replay mode):
// UiEvents as plain `data:` messages (the live contract), and `replay` / `telemetry` as named SSE events the live UI ignores.
// Records with `run` equal to the replayed run (null for "prerun") enter the timeline; others do not.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Fold, STREAMED_FILES, parseJsonl, toEvent, curveEvents, sseMessage } from "./events.ts";
import type { Paths, StreamedFile } from "./events.ts";
import { unpackFrame } from "./compact.ts";
import type { StoredFrame } from "./compact.ts";
import type { TelemetryRecord } from "../src/telemetry.ts";
import type { UiEvent, Verdict, VRead } from "../src/schema.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Milliseconds between replay clock ticks. */
export const REPLAY_TICK_MS = 50;
/** Milliseconds between `replay` status messages while playing (the scrubber's refresh). */
export const REPLAY_STATUS_MS = 250;
/** Milliseconds of telemetry the inspector lists on each side of the scrubber time. */
export const INSPECT_WINDOW_MS = 30_000;

export type Item =
  | { at: number; kind: "ui"; event: UiEvent; origin: "ledger" | "producer" }
  | { at: number; kind: "telemetry"; rec: TelemetryRecord & { i: number } };

/**
 * A timeline marker. `decision` and `check` (the first failing check of a REFUSE) colour verdict markers; "attempt" marks
 * an attempt's first ledger record; "pause", "resume", "stop" and "open" come from runs/<run>/campaign.jsonl; "freeze"
 * is the `start` record of runs/<run>/vread-progress.jsonl and "vread" the V read (server/replay.test.ts "markers").
 */
export interface Marker {
  at: number; kind: "incident" | "verdict" | "fire" | "graduation" | "attempt" | "pause" | "resume" | "stop" | "open" | "freeze" | "vread";
  id: string; label: string; decision?: "GRADUATE" | "REFUSE"; check?: string;
}
export interface Timeline {
  run: string; t0: number; t1: number; items: Item[]; markers: Marker[]; records: (TelemetryRecord & { i: number })[];
  commit: string | null; regen: { commit: string; bundle_url: string } | null;
}

/** Telemetry records of every stream under `dir`, unparseable lines skipped, ordered by (at, seq). */
export function readTelemetry(dir: string): TelemetryRecord[] {
  if (!existsSync(dir)) return [];
  const out: TelemetryRecord[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
    const { records } = parseJsonl(readFileSync(join(dir, f), "utf8") + "\n");
    for (const r of records as TelemetryRecord[]) if (r && typeof r.at === "string") out.push(r);
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (a.pid - b.pid) || a.seq - b.seq);
}

export function telemetryDir(runsDir: string, run: string): string { return join(runsDir, run, "telemetry"); }

function inRun(r: Record<string, unknown>, run: string): boolean {
  const want = run === "prerun" ? null : run;
  return (r.run ?? null) === want;
}

/** Ledger events of `run`, each the folded record at its `at` (the event the live bus emitted on that append). */
export function ledgerItems(ledgerDir: string, run: string): Item[] {
  const out: Item[] = [];
  for (const f of Object.keys(STREAMED_FILES) as StreamedFile[]) {
    const p = join(ledgerDir, f);
    if (!existsSync(p)) continue;
    const fold = new Fold();
    let lastAt = 0;
    for (const r of parseJsonl(readFileSync(p, "utf8") + "\n").records as Record<string, unknown>[]) {
      const id = fold.apply(r);
      if (!id || !inRun(r, run)) continue;
      const at = typeof r.at === "string" && !Number.isNaN(Date.parse(r.at)) ? Date.parse(r.at) : lastAt;
      lastAt = at;
      // a copy: later status records mutate the folded object, and this event shows the record as of `at` (as live did)
      out.push({ at, kind: "ui", origin: "ledger", event: toEvent(f, structuredClone(fold.get(id)!)) });
      if (f === "verdicts.jsonl") {
        const v = fold.get(id) as unknown as Verdict;
        const curve = curveEvents(fold.all());
        if (v.subject?.kind === "skill" && v.arms && curve.length) out.push({ at, kind: "ui", origin: "ledger", event: curve.at(-1)! });
      }
    }
  }
  return out;
}

function markerOf(e: UiEvent, at: number): Marker[] {
  if (e.t === "incident") return [{ at, kind: "incident", id: e.incident.id, label: `${e.incident.id} ${e.incident.kind}` }];
  if (e.t === "fire") return [{ at, kind: "fire", id: e.fire.id, label: `${e.fire.id} ${e.fire.skill}` }];
  if (e.t === "attempt") return [{ at, kind: "attempt", id: e.attempt.id, label: `${e.attempt.id} start` }];
  if (e.t === "vread") return [{ at, kind: "vread", id: "vread", label: "V read" }];
  if (e.t === "verdict") {
    const check = e.verdict.decision === "REFUSE" ? (e.verdict.checks ?? []).find((c) => !c.pass)?.name : undefined;
    const m: Marker = { at, kind: "verdict", id: e.verdict.id, label: `${e.verdict.id} ${e.verdict.decision}${check ? ` (${check})` : ""} ${e.verdict.subject.id}`, decision: e.verdict.decision, ...(check ? { check } : {}) };
    return e.verdict.decision === "GRADUATE" ? [m, { ...m, kind: "graduation" }] : [m];
  }
  return [];
}

/** Campaign control markers (runs/<run>/campaign.jsonl open/pause/resume/stop) and the freeze (vread-progress.jsonl start). */
export function campaignMarkers(runsDir: string, run: string): Marker[] {
  const out: Marker[] = [];
  const rows = (f: string) => existsSync(f) ? parseJsonl(readFileSync(f, "utf8") + "\n").records as Record<string, unknown>[] : [];
  let n = 0;
  for (const r of rows(join(runsDir, run, "campaign.jsonl"))) {
    const t = String(r.t ?? ""), at = Date.parse(String(r.at ?? ""));
    if (!["open", "pause", "resume", "stop"].includes(t) || Number.isNaN(at)) continue;
    out.push({ at, kind: t as Marker["kind"], id: `${t}-${n++}`, label: `${t}${r.reason ? `: ${String(r.reason)}` : r.steer ? ` (${String(r.steer)})` : ""}` });
  }
  const start = rows(join(runsDir, run, "vread-progress.jsonl")).find((r) => r.t === "start");
  const fat = start ? Date.parse(String(start.at ?? "")) : NaN;
  if (!Number.isNaN(fat)) out.push({ at: fat, kind: "freeze", id: "freeze", label: `freeze; V read starts on core ${String(start!.core_commit ?? "").slice(0, 7)}` });
  return out;
}

/** Builds the replay timeline of `run` from `paths.ledger` and `paths.runs/<run>/telemetry` (see the file header). */
export function loadTimeline(paths: Paths, run: string, distDir = join(ROOT, "dist")): Timeline {
  const recs = readTelemetry(telemetryDir(paths.runs, run)).map((r, i) => ({ ...r, i }));
  const items: Item[] = ledgerItems(paths.ledger, run);
  for (const rec of recs) {
    const at = Date.parse(rec.at);
    if (rec.stream === "ui") {
      const d = rec.data as { origin?: string; event?: UiEvent } & Partial<StoredFrame>;
      if (d.origin !== "producer") continue; // ledger-origin events are re-derived from ledger/ above
      if (rec.kind === "frame" && d.gz_b64) items.push({ at, kind: "ui", origin: "producer", event: unpackFrame(d as StoredFrame) });
      else if (d.event) items.push({ at, kind: "ui", origin: "producer", event: d.event });
      continue;
    }
    items.push({ at, kind: "telemetry", rec });
  }
  items.sort((a, b) => a.at - b.at); // Array.prototype.sort is stable: equal times keep ledger-then-telemetry order
  const vp = join(paths.runs, run, "vread.json");
  if (existsSync(vp)) {
    try {
      const v = JSON.parse(readFileSync(vp, "utf8")) as VRead & { at?: string };
      items.push({ at: v.at ? Date.parse(v.at) : (items.at(-1)?.at ?? 0), kind: "ui", origin: "ledger", event: { t: "vread", result: v } });
      items.sort((a, b) => a.at - b.at);
    } catch { /* an unreadable vread.json enters no timeline */ }
  }
  const t0 = items[0]?.at ?? 0;
  const t1 = items.at(-1)?.at ?? t0;
  const seen = new Set<string>(); // one marker per id, at its first record; status flips re-emit the id without a marker
  const markers = items.flatMap((x) => (x.kind === "ui" && x.origin === "ledger" ? markerOf(x.event, x.at) : []))
    .filter((m) => !seen.has(`${m.kind}:${m.id}`) && seen.add(`${m.kind}:${m.id}`))
    .concat(campaignMarkers(paths.runs, run))
    .sort((a, b) => a.at - b.at);
  const coreEv = items.find((x) => x.kind === "ui" && x.event.t === "core");
  const start = recs.find((r) => r.stream === "process" && r.kind === "start" && typeof (r.data as { head?: unknown }).head === "string");
  const commit = coreEv && coreEv.kind === "ui" && coreEv.event.t === "core" ? coreEv.event.commit : start ? (start.data as { head: string }).head : null;
  const regen = commit && existsSync(join(distDir, `core-${commit}.js`)) ? { commit, bundle_url: `/dist/core-${commit}.js` } : null;
  return { run, t0, t1, items, markers, records: recs, commit, regen };
}

/** Telemetry records within `windowMs` of `at` (epoch ms), optionally of one stream; inspector rows carry their index `i`. */
export function recordsAround(tl: Timeline, at: number, stream?: string, windowMs = INSPECT_WINDOW_MS): (TelemetryRecord & { i: number })[] {
  return tl.records.filter((r) => (!stream || r.stream === stream) && Math.abs(Date.parse(r.at) - at) <= windowMs);
}

/** Every muse record of one attempt (the MSP stream loop/repair.ts taps), in recorded order. */
export function museStream(tl: Timeline, attempt: string): TelemetryRecord[] {
  return tl.records.filter((r) => r.stream === "muse" && (r.data as { attempt?: string })?.attempt === attempt);
}

export interface ReplayStatus { run: string; recorded: string; t0: number; t1: number; pos: number; playing: boolean; speed: number; markers: Marker[]; regen: Timeline["regen"]; commit: string | null; done: boolean }

type Client = { write(s: string): void };

function named(name: string, data: unknown): string { return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`; }
function itemMessage(x: Item): string { return x.kind === "ui" ? sseMessage(x.event) : named("telemetry", x.rec); }

/**
 * Plays a Timeline: `pos` is epoch ms on the recorded clock. `play`, `pause`, `setSpeed` and `seek` drive it;
 * a seek, and a client joining, sends `replay` with reset:true, then every non-frame item up to `pos` and the last
 * frame per source, so the UI rebuilds its state from zero.
 */
export class ReplayPlayer {
  readonly tl: Timeline;
  pos: number;
  playing = false;
  speed: number;
  private next = 0;
  private clients = new Set<Client>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastWall = 0;
  private lastStatus = 0;
  constructor(tl: Timeline, speed = 1) { this.tl = tl; this.pos = tl.t0 - 1; this.speed = speed; }

  status(): ReplayStatus {
    const { run, t0, t1, markers, regen, commit } = this.tl;
    return { run, recorded: new Date(t0).toISOString(), t0, t1, pos: Math.max(this.pos, t0), playing: this.playing, speed: this.speed, markers, regen, commit, done: this.next >= this.tl.items.length };
  }

  /** The messages that rebuild a screen at `pos`: reset status, non-frame items ≤ pos, then the last frame per source. */
  private catchUp(): string[] {
    const out = [named("replay", { ...this.status(), reset: true })];
    const frames = new Map<string, Item>();
    for (let i = 0; i < this.next; i++) {
      const x = this.tl.items[i];
      if (x.kind === "ui" && x.event.t === "frame") frames.set(x.event.source, x);
      else out.push(itemMessage(x));
    }
    for (const f of frames.values()) out.push(itemMessage(f));
    return out;
  }

  addClient(c: Client): () => void {
    this.clients.add(c);
    for (const m of this.catchUp()) c.write(m);
    return () => { this.clients.delete(c); };
  }

  private broadcast(m: string): void { for (const c of this.clients) c.write(m); }

  /** Emits every item with at ≤ pos not yet emitted. */
  private flush(): void {
    while (this.next < this.tl.items.length && this.tl.items[this.next].at <= this.pos) this.broadcast(itemMessage(this.tl.items[this.next++]));
  }

  seek(pos: number): void {
    this.pos = Math.min(Math.max(pos, this.tl.t0 - 1), this.tl.t1);
    this.next = 0;
    while (this.next < this.tl.items.length && this.tl.items[this.next].at <= this.pos) this.next++;
    const msgs = this.catchUp();
    for (const c of this.clients) for (const m of msgs) c.write(m);
  }

  setSpeed(s: number): void { if (s > 0 && Number.isFinite(s)) this.speed = s; this.broadcast(named("replay", this.status())); }

  play(): void {
    if (this.playing) return;
    if (this.next >= this.tl.items.length) this.seek(this.tl.t0 - 1);
    this.playing = true;
    this.lastWall = Date.now();
    this.timer = setInterval(() => this.tick(), REPLAY_TICK_MS);
    this.broadcast(named("replay", this.status()));
  }

  pause(): void {
    this.playing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.broadcast(named("replay", this.status()));
  }

  /** Advances the recorded clock by wall time × speed and emits what it passes; pauses at the end. */
  tick(wall = Date.now()): void {
    this.pos += (wall - this.lastWall) * this.speed;
    this.lastWall = wall;
    this.flush();
    const done = this.next >= this.tl.items.length;
    if (done) { this.pos = this.tl.t1; this.pause(); return; }
    if (wall - this.lastStatus >= REPLAY_STATUS_MS) { this.lastStatus = wall; this.broadcast(named("replay", this.status())); }
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; this.playing = false; }
}
