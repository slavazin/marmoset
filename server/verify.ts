// The telemetry coverage verifier: answers "will everything the UI or demo shows be in the logs?" for one run.
// `pnpm telemetry:verify [RUN-id|prerun] [--since 5m]` prints one JSON report and exits 1 on any gap. Three checks:
//   static   every displayable (src/displayables.ts) names a source and each producer file contains its pattern;
//   dynamic  over runs/<run>/telemetry/ and ledger/: each displayable whose trigger has happened has ≥1 well-formed
//            record per source (else `gap`; an untriggered one is `not-yet`, never `pass`); no unparseable line; seq
//            rises per pid within each stream file; no secret-looking value left unredacted (key names, token shapes,
//            and every .env value of VERIFY_SECRET_MIN_LEN or more characters); core frames at ≥ FRAME_COVER_MIN of
//            TELEMETRY_FRAME_HZ across the play span (first to last input record);
//   replay   replay-mode GET /api/state equals live GET /api/state over the same ledger (server/index.ts, both in-process).
// The live server runs it every VERIFY_EVERY_S and appends each report to runs/<run|prerun>/telemetry-verify.jsonl.

import { existsSync, readFileSync, readdirSync, appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { DISPLAYABLES } from "../src/displayables.ts";
import type { Displayable, DisplaySource, Trigger } from "../src/displayables.ts";
import { TELEMETRY_FRAME_HZ, currentRun } from "../src/telemetry.ts";
import type { TelemetryRecord } from "../src/telemetry.ts";
import { parseJsonl } from "./events.ts";
import type { Paths } from "./events.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Seconds between verifier runs in the live server; the owner's directive (2026-11-07) set 300. */
export const VERIFY_EVERY_S = 300;
/** Fraction of TELEMETRY_FRAME_HZ × play-span seconds the core frame count must reach; 0.8 leaves room for the first-second boundary and tab stalls. */
export const FRAME_COVER_MIN = 0.8;
/** Shortest .env value searched for in telemetry text; shorter values (ports, flags) match by chance. */
export const VERIFY_SECRET_MIN_LEN = 12;
/** Field names whose value must read "[redacted]" (mirrors src/telemetry.ts SECRET_KEY). */
const SECRET_KEY = /authorization|api[-_]?key|(^|[-_])token$|secret|password|muse_code_key/i;
/** Value shapes of known credential formats: OpenAI/Anthropic-style sk-, Google AIza, GitHub ghp_, bearer headers. */
const SECRET_VALUE = /\b(sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{30,}|Bearer\s+[A-Za-z0-9._~+/-]{16,})/;

export type Status = "pass" | "gap" | "not-yet";
export interface Row { id: string; shows: string; status: Status; why: string }
export interface Gap { id: string; check: "static" | "dynamic" | "replay"; why: string }
export interface Report { at: string; run: string; since_s: number | null; covered: number; total: number; gaps: Gap[]; rows: Row[]; replay: Status }

export interface VerifyInput { paths: Paths; run: string; root?: string; manifest?: readonly Displayable[]; sinceMs?: number | null; now?: number; dotEnv?: string; replay?: boolean }

interface Loaded { tel: TelemetryRecord[]; bad: Gap[]; ledger: Map<string, Record<string, unknown>[]> }

function getPath(o: unknown, path: string): unknown {
  let x = o as Record<string, unknown> | undefined;
  for (const k of path.split(".")) { if (x == null || typeof x !== "object") return undefined; x = x[k] as Record<string, unknown>; }
  return x;
}

/** Static check of one displayable: a source is named and every producer file contains its pattern. Null when it holds. */
export function staticGap(d: Displayable, root = ROOT): string | null {
  if (!d.sources.length) return "no source named";
  if (!d.producers.length) return "no producer named";
  for (const p of d.producers) {
    const f = join(root, p.file);
    if (!existsSync(f)) return `producer ${p.file} does not exist`;
    if (!new RegExp(p.pattern).test(readFileSync(f, "utf8"))) return `producer ${p.file} has no match for /${p.pattern}/`;
  }
  return null;
}

function scanSecrets(file: string, line: string, rec: unknown, envValues: string[]): string | null {
  const walk = (v: unknown, path: string): string | null => {
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const r = walk(v[i], `${path}[${i}]`); if (r) return r; } return null; }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (SECRET_KEY.test(k) && x !== "[redacted]") return `${path}.${k} is not redacted`;
        const r = walk(x, `${path}.${k}`); if (r) return r;
      }
    }
    return null;
  };
  const keyHit = walk(rec, file);
  if (keyHit) return keyHit;
  if (SECRET_VALUE.test(line)) return `${file}: a credential-shaped value`;
  for (const v of envValues) if (line.includes(v)) return `${file}: a .env value appears unredacted`;
  return null;
}

function load(i: VerifyInput, envValues: string[]): Loaded {
  const dir = join(i.paths.runs, i.run, "telemetry");
  const tel: TelemetryRecord[] = [];
  const bad: Gap[] = [];
  const since = i.sinceMs ?? null;
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
      const lastSeq = new Map<number, number>();
      const lines = readFileSync(join(dir, f), "utf8").split("\n");
      let unparsed = 0, secretWhy: string | null = null, seqWhy: string | null = null;
      lines.forEach((line, n) => {
        if (!line.trim()) return;
        let r: TelemetryRecord;
        try { r = JSON.parse(line); } catch { if (n < lines.length - 1) unparsed++; return; } // a trailing partial line is an append in flight
        if (typeof r?.at !== "string" || typeof r.seq !== "number" || typeof r.pid !== "number" || typeof r.stream !== "string") { unparsed++; return; }
        const prev = lastSeq.get(r.pid);
        if (prev !== undefined && r.seq <= prev && !seqWhy) seqWhy = `${f}: pid ${r.pid} seq ${r.seq} after ${prev}`;
        lastSeq.set(r.pid, r.seq);
        if (!secretWhy) secretWhy = scanSecrets(f, line, r.data, envValues);
        if (since === null || Date.parse(r.at) >= since) tel.push(r);
      });
      if (unparsed) bad.push({ id: f, check: "dynamic", why: `${unparsed} unparseable or malformed line(s)` });
      if (seqWhy) bad.push({ id: f, check: "dynamic", why: seqWhy });
      if (secretWhy) bad.push({ id: f, check: "dynamic", why: secretWhy });
    }
  }
  const ledger = new Map<string, Record<string, unknown>[]>();
  const want = i.run === "prerun" ? null : i.run;
  if (existsSync(i.paths.ledger)) {
    for (const f of readdirSync(i.paths.ledger).filter((f) => f.endsWith(".jsonl"))) {
      const recs = parseJsonl(readFileSync(join(i.paths.ledger, f), "utf8") + "\n").records as Record<string, unknown>[];
      // fold status records into their ids so a status field (narration, status) reads as the record's field
      const byId = new Map<string, Record<string, unknown>>();
      for (const r of recs) {
        if (r.t === "status" && typeof r.id === "string") { const c = byId.get(r.id); if (c) c[r.field as string] = r.value; continue; }
        if ((r.run ?? null) !== want) continue;
        if (since !== null && typeof r.at === "string" && Date.parse(r.at) < since) continue;
        if (typeof r.id === "string") byId.set(r.id, { ...r });
      }
      ledger.set(f, [...byId.values()]);
    }
  }
  return { tel, bad, ledger };
}

function telHas(L: Loaded, s: { stream: string; kind?: string; match?: { field: string; equals: unknown } }): boolean {
  return L.tel.some((r) => r.stream === s.stream && (!s.kind || r.kind === s.kind) && r.data != null && typeof r.data === "object"
    && (!s.match || getPath(r.data, s.match.field) === s.match.equals));
}

function playing(L: Loaded): boolean {
  return telHas(L, { stream: "input", kind: "mask" }) || telHas(L, { stream: "ui", kind: "player" });
}

function triggered(t: Trigger, L: Loaded, i: VerifyInput): boolean {
  if ("always" in t) return true;
  if ("play" in t) return playing(L);
  if ("telemetry" in t) return telHas(L, t.telemetry);
  if ("runs" in t) return existsSync(join(i.paths.runs, i.run, t.runs.file));
  const recs = L.ledger.get(t.ledger.file) ?? [];
  return recs.some((r) => !t.ledger.field || (t.ledger.equals === undefined ? getPath(r, t.ledger.field) !== undefined : getPath(r, t.ledger.field) === t.ledger.equals));
}

function sourceMissing(s: DisplaySource, L: Loaded, i: VerifyInput): string | null {
  if ("telemetry" in s) return telHas(L, s.telemetry) ? null : `no ${s.telemetry.stream}${s.telemetry.kind ? "/" + s.telemetry.kind : ""}${s.telemetry.match ? ` with ${s.telemetry.match.field}=${JSON.stringify(s.telemetry.match.equals)}` : ""} record`;
  if ("runs" in s) return existsSync(join(i.paths.runs, i.run, s.runs.file)) ? null : `no runs/${i.run}/${s.runs.file}`;
  const f = s.ledger.file;
  if (f.endsWith(".json")) return existsSync(join(i.paths.ledger, f)) ? null : `no ledger/${f}`;
  const recs = L.ledger.get(f) ?? [];
  if (!recs.length) return `no record in ledger/${f}`;
  if (s.ledger.field && !recs.some((r) => getPath(r, s.ledger.field!) !== undefined)) return `no ledger/${f} record carries ${s.ledger.field}`;
  return null;
}

/** Core frame coverage across the play span (first to last input mask record). Null when it holds or no play. */
export function frameGap(L: Pick<Loaded, "tel">): string | null {
  const inputs = L.tel.filter((r) => r.stream === "input" && r.kind === "mask").map((r) => Date.parse(r.at));
  if (inputs.length < 2) return null;
  const [a, b] = [Math.min(...inputs), Math.max(...inputs)];
  const span = (b - a) / 1000;
  const frames = L.tel.filter((r) => r.stream === "ui" && r.kind === "frame" && (r.data as { source?: string })?.source === "core" && Date.parse(r.at) >= a && Date.parse(r.at) <= b).length;
  const need = Math.floor(span * TELEMETRY_FRAME_HZ * FRAME_COVER_MIN);
  return frames >= need ? null : `${frames} core frames over ${span.toFixed(0)} s of play; ${need} needed at ${TELEMETRY_FRAME_HZ} Hz × ${FRAME_COVER_MIN}`;
}

function envValues(file: string): string[] {
  if (!existsSync(file)) return [];
  const out: string[] = [];
  for (const l of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*?)\s*$/.exec(l);
    const v = m?.[1].replace(/^["']|["']$/g, "");
    if (v && v.length >= VERIFY_SECRET_MIN_LEN) out.push(v);
  }
  return out;
}

/** Replay check: replay-mode /api/state equals live /api/state over `paths` (both servers in-process on port 0). */
export async function replayStateEqual(paths: Paths, run: string): Promise<boolean> {
  const { createServer } = await import("./index.ts");
  const base = { ...paths, game: join(ROOT, "game"), cache: join(tmpdir(), "ratchet-verify-cache") };
  const made = [createServer(base), createServer({ ...base, replay: { run } })];
  try {
    const states: string[] = [];
    for (const m of made) {
      await new Promise<void>((r) => m.server.listen(0, "127.0.0.1", r));
      states.push(JSON.stringify(await (await fetch(`http://127.0.0.1:${(m.server.address() as AddressInfo).port}/api/state`)).json()));
    }
    return states[0] === states[1];
  } finally { for (const m of made) { m.server.closeAllConnections(); m.server.close(); } }
}

/** Runs the three checks (see the file header) and returns the report. */
export async function verify(i: VerifyInput): Promise<Report> {
  const root = i.root ?? ROOT;
  const manifest = i.manifest ?? DISPLAYABLES;
  const L = load(i, envValues(i.dotEnv ?? join(root, ".env")));
  const gaps: Gap[] = [...L.bad];
  const rows: Row[] = manifest.map((d) => {
    const sg = staticGap(d, root);
    if (sg) { gaps.push({ id: d.id, check: "static", why: sg }); return { id: d.id, shows: d.shows, status: "gap", why: sg }; }
    if (!triggered(d.trigger, L, i)) return { id: d.id, shows: d.shows, status: "not-yet", why: `trigger ${JSON.stringify(d.trigger)} has not happened` };
    const miss = d.sources.map((s) => sourceMissing(s, L, i)).find((x) => x);
    if (miss) { gaps.push({ id: d.id, check: "dynamic", why: miss }); return { id: d.id, shows: d.shows, status: "gap", why: miss }; }
    return { id: d.id, shows: d.shows, status: "pass", why: "every source has a record" };
  });
  const fg = frameGap(L);
  if (fg) gaps.push({ id: "frames", check: "dynamic", why: fg });
  let replay: Status = "not-yet";
  if (i.replay !== false) {
    replay = (await replayStateEqual(i.paths, i.run)) ? "pass" : "gap";
    if (replay === "gap") gaps.push({ id: "replay-state", check: "replay", why: "replay-mode /api/state differs from live /api/state" });
  }
  return { at: new Date(i.now ?? Date.now()).toISOString(), run: i.run, since_s: i.sinceMs != null ? Math.round(((i.now ?? Date.now()) - i.sinceMs) / 1000) : null, covered: rows.filter((r) => r.status === "pass").length, total: rows.length, gaps, rows, replay };
}

/** Appends one report to runs/<run>/telemetry-verify.jsonl. */
export function appendReport(runsDir: string, r: Report): void {
  mkdirSync(join(runsDir, r.run), { recursive: true });
  appendFileSync(join(runsDir, r.run, "telemetry-verify.jsonl"), JSON.stringify(r) + "\n");
}

/** Parses "5m", "90s", "2h" to milliseconds. */
export function parseSince(s: string): number {
  const m = /^(\d+(?:\.\d+)?)([smh])$/.exec(s);
  if (!m) throw new Error(`--since ${s}: want <n>s|m|h`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { pathsFromEnv } = await import("./index.ts");
  const args = process.argv.slice(2);
  const sinceIdx = args.indexOf("--since");
  const since = sinceIdx >= 0 ? parseSince(args[sinceIdx + 1]) : null;
  const run = args.find((a, k) => !a.startsWith("--") && args[k - 1] !== "--since") ?? currentRun() ?? "prerun";
  const r = await verify({ paths: pathsFromEnv(), run, sinceMs: since === null ? null : Date.now() - since });
  console.log(JSON.stringify(r, null, 2));
  console.error(`telemetry: ${r.covered}/${r.total} covered, ${r.gaps.length} gaps, ${r.rows.filter((x) => x.status === "not-yet").length} not-yet, replay ${r.replay}`);
  process.exitCode = r.gaps.length ? 1 : 0;
}
