// The UI server (SPEC §5 S6), port 8787. Offers:
//   GET  /events            SSE stream of UiEvents (§6.18): a snapshot of the ledger, then every tailed append.
//   GET  /api/state         the folded ledger view (incidents, attempts, verdicts, fires, provenance, curve, vread).
//   POST /api/trace/reset   {rom_sha} starts the live trace for a loaded ROM.
//   POST /api/input         {counter, mask} appends one TraceInput to the live trace.
//   GET  /api/trace         the live trace (§6.5 Trace).
//   POST /api/event         a UiEvent from another producer (lockstep, player); frames are capped per source.
//   POST /api/play-session  {op: "start"} or {op: "stop", duration_ms} from the Play tab (ui/play/session.ts); writes
//                           one `ui` telemetry record "play-session", touches no trace, bus or ledger, refuses any other field.
//   GET  /evidence/**, /game/**   files under the evidence dir and the game dir.
//   POST /fire              a hook fire {skill, attempt, path, owed}; server/fire.ts appends it to ledger/fires.jsonl.
// The live trace is a working trace at $RATCHET_CACHE/traces/live.json; /fire is the one ledger write, through loop/ledger.ts.
// With `record`, every bus event, input and trace reset is written to telemetry (server/recorder.ts, src/telemetry.ts).
// With `replay: {run}` (server/replay-run.ts) the server plays runs/<run>/telemetry/ and ledger/ back instead of live
// sources: /events re-emits the recorded timeline (server/replay.ts), /api/state is the same folded ledger view, every
// POST route answers 409, and these routes are added:
//   GET  /api/replay              the player status (run, recorded date, clock, speed, markers, regen bundle).
//   POST /api/replay/control      {op: "play"|"pause"|"speed"|"seek", value?} drives the player.
//   GET  /api/replay/records      ?at=<epoch ms>&stream=<s> telemetry records around a time, for the inspector.
//   GET  /api/replay/muse         ?attempt=<ATT-id> the attempt's recorded MSP stream.
//   GET  /dist/core-<commit>.js   a core bundle the UI regenerates frames with.
// Run selection (S24, server/runs.ts): GET /api/runs lists every run with its name, description and overview figures;
// `?run=RUN-NNNN&mode=live|replay` (or the ratchet_run / ratchet_mode cookies) selects the run /events, /api/state,
// /api/history, /evidence/** and the /api/replay* routes read; with none, the server's own run is served as above.
// In both modes GET /api/telemetry-verify serves the latest telemetry coverage report (server/verify.ts).

import { createServer as httpServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, resolve, extname, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { EventBus, sseMessage } from "./events.ts";
import { recordFire } from "./fire.ts";
import type { Paths } from "./events.ts";
import type { Trace, TraceInput, UiEvent } from "../src/schema.ts";
import { attachRecorder } from "./recorder.ts";
import type { Tlog } from "./recorder.ts";
import { tlog } from "../src/telemetry.ts";
import { loadTimeline, ReplayPlayer, recordsAround, museStream } from "./replay.ts";
import { DEFAULT_RUN, listRuns, runOverview, runPaths, selectedMode, selectedRun } from "./runs.ts";

/** Port the server listens on (SPEC §7.5). */
export const PORT = Number(process.env.RATCHET_SERVER_PORT ?? 8787);
/** UiEvent kinds POST /api/event accepts; incidents, verdicts and fires reach the screen only through the ledger. */
export const PRODUCER_EVENTS: ReadonlySet<UiEvent["t"]> = new Set(["frame", "meta", "player", "attempt", "core"]);
/** Largest request body accepted, in bytes; a frame event is a 23,040-byte shade array in base64 plus its envelope. */
export const MAX_BODY_BYTES = 1 << 20;

const MIME: Record<string, string> = {
  ".png": "image/png", ".json": "application/json", ".jsonl": "application/x-ndjson",
  ".gb": "application/octet-stream", ".js": "text/javascript", ".txt": "text/plain",
};

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function expandHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

export interface ServerOptions extends Paths {
  game: string; cache: string;
  /** Write every bus event, input and trace reset to telemetry through `log` (default src/telemetry.ts tlog). */
  record?: boolean; log?: Tlog;
  /** Play a recorded run back instead of live sources. */
  replay?: { run: string; speed?: number; autoplay?: boolean };
  /** Where /dist/core-<commit>.js bundles are read from (default <repo>/dist). */
  dist?: string;
  /** The latest telemetry coverage report, served at /api/telemetry-verify. */
  verifyReport?: () => unknown;
}

/** Paths from the environment: RATCHET_LEDGER, RATCHET_RUNS, RATCHET_EVIDENCE, RATCHET_GAME, RATCHET_CACHE. */
export function pathsFromEnv(env = process.env): ServerOptions {
  return {
    ledger: resolve(ROOT, env.RATCHET_LEDGER ?? "ledger"),
    runs: resolve(ROOT, env.RATCHET_RUNS ?? "runs"),
    evidence: resolve(ROOT, env.RATCHET_EVIDENCE ?? "evidence"),
    game: resolve(ROOT, env.RATCHET_GAME ?? "game"),
    cache: resolve(expandHome(env.RATCHET_CACHE ?? "~/.cache/ratchet")),
  };
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > MAX_BODY_BYTES) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
}

/** Serves a file under `base`; refuses any path that resolves outside it. */
function serveFile(res: ServerResponse, base: string, rel: string): void {
  const p = resolve(base, "." + sep + decodeURIComponent(rel));
  if (p !== base && !p.startsWith(base + sep)) return send(res, 403, { error: "outside" });
  if (!existsSync(p) || !statSync(p).isFile()) return send(res, 404, { error: "not found" });
  res.writeHead(200, { "content-type": MIME[extname(p)] ?? "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(p));
}

/** The live trace the browser records into and the lockstep follows. */
export class LiveTrace {
  trace: Trace;
  readonly file: string;
  constructor(file: string) {
    this.file = file;
    this.trace = { id: "live", rom_sha: "", align: "counter", inputs: [], counter_end: 0, source: "keyboard" };
  }
  reset(rom_sha: string): void {
    this.trace = { id: "live", rom_sha, align: "counter", inputs: [], counter_end: 0, source: "keyboard" };
    this.write();
  }
  /** Appends an input when its mask differs from the last one held; a mask holds until the next entry (§6.5). */
  add(inp: TraceInput): void {
    const last = this.trace.inputs.at(-1);
    this.trace.counter_end = Math.max(this.trace.counter_end, inp.from_counter);
    if (last && last.mask === inp.mask) return this.write();
    if (last && inp.from_counter < last.from_counter) return; // out-of-order post enters no trace
    if (last && last.from_counter === inp.from_counter) last.mask = inp.mask;
    else this.trace.inputs.push({ from_counter: inp.from_counter, mask: inp.mask });
    this.write();
  }
  private write(): void {
    mkdirSync(join(this.file, ".."), { recursive: true });
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.trace));
    renameSync(tmp, this.file);
  }
}

function isInt(x: unknown): x is number { return typeof x === "number" && Number.isInteger(x) && x >= 0; }

export function createServer(opts: ServerOptions): { server: Server; bus: EventBus; trace: LiveTrace; player: ReplayPlayer | null } {
  const bus = new EventBus(opts);
  const trace = new LiveTrace(join(opts.cache, "traces", "live.json"));
  const log: Tlog = opts.record ? (opts.log ?? tlog) : () => {};
  if (opts.record) attachRecorder(bus, log);
  const dist = opts.dist ?? join(ROOT, "dist");
  const player = opts.replay ? new ReplayPlayer(loadTimeline(opts, opts.replay.run, dist), opts.replay.speed ?? 1) : null;
  if (player && opts.replay?.autoplay) player.play();

  // Run selection (S24, server/runs.ts): a request names a run by `?run=` or the `ratchet_run` cookie, and a mode by
  // `?mode=` or `ratchet_mode`. The server's own run (DEFAULT_RUN, or opts.replay.run) is served by `bus`/`player`;
  // any other run gets a read-only EventBus over its own ledger, and replay mode a ReplayPlayer over its telemetry,
  // each made on first request. Every POST except replay control is refused for a run other than the server's own.
  const ownRun = opts.replay?.run ?? DEFAULT_RUN;
  const buses = new Map<string, EventBus>();
  const players = new Map<string, ReplayPlayer>();
  const base = { ledger: opts.ledger, evidence: opts.evidence, runs: opts.runs };
  const pathsOf = (run: string) => (run === ownRun ? { run, ledger: opts.ledger, evidence: opts.evidence, runs: opts.runs } : runPaths(base, run));
  const busOf = (run: string): EventBus => {
    if (run === ownRun) return bus;
    let b = buses.get(run);
    if (!b) { b = new EventBus(pathsOf(run)); b.start(); buses.set(run, b); }
    return b;
  };
  const playerOf = (run: string): ReplayPlayer => {
    if (run === ownRun && player) return player;
    let p = players.get(run);
    if (!p) { p = new ReplayPlayer(loadTimeline(pathsOf(run), run, dist), 1); players.set(run, p); }
    return p;
  };
  const overviews = () => Promise.all(listRuns(base).map(async (e) => ({ ...(await runOverview(e)), game: e.game, tier: e.tier, repairer: e.repairer, repairer_model: e.repairer_model, core: e.core })));
  const historyWithRuns = async (p: Parameters<typeof import("./history.ts")["historyFor"]>[0]) =>
    ({ ...(await (await import("./history.ts")).historyFor(p)), runs: await overviews(), selected: (p as { run?: string }).run ?? ownRun });

  const server = httpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/api/telemetry-verify") return send(res, 200, opts.verifyReport?.() ?? null);
      if (req.method === "GET" && path === "/api/runs") {
        return send(res, 200, { default: ownRun, runs: await overviews() });
      }
      const run = selectedRun(url, req.headers.cookie, ownRun);
      const mode = player && run === ownRun ? "replay" : selectedMode(url, req.headers.cookie);
      if (run !== ownRun || mode === "replay") {
        if (!existsSync(join(opts.runs, run)) && run !== ownRun) return send(res, 404, { error: `no run directory runs/${run}` });
        if (mode === "replay") {
          const pl = playerOf(run);
          if (req.method === "GET" && path === "/events") {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
            res.write(": ratchet replay\n\n");
            req.on("close", pl.addClient(res));
            return;
          }
          if (req.method === "GET" && path === "/api/replay") return send(res, 200, pl.status());
          if (req.method === "POST" && path === "/api/replay/control") {
            const b = (await readBody(req)) as { op?: string; value?: number };
            if (b?.op === "play") pl.play();
            else if (b?.op === "pause") pl.pause();
            else if (b?.op === "speed" && typeof b.value === "number") pl.setSpeed(b.value);
            else if (b?.op === "seek" && typeof b.value === "number") pl.seek(b.value);
            else return send(res, 400, { error: "op" });
            return send(res, 200, pl.status());
          }
          if (req.method === "GET" && path === "/api/replay/records") {
            const at = Number(url.searchParams.get("at") ?? pl.pos);
            return send(res, 200, recordsAround(pl.tl, at, url.searchParams.get("stream") || undefined));
          }
          if (req.method === "GET" && path === "/api/replay/muse") return send(res, 200, museStream(pl.tl, url.searchParams.get("attempt") ?? ""));
          if (req.method === "GET" && /^\/dist\/core-[0-9a-f]+\.js$/.test(path)) return serveFile(res, dist, path.slice("/dist/".length));
          if (req.method === "GET" && path === "/api/state") return send(res, 200, busOf(run).state());
        } else {
          const b = busOf(run);
          if (req.method === "GET" && path === "/events") {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
            res.write(": ratchet\n\n");
            b.poll();
            for (const e of b.snapshot()) res.write(sseMessage(e));
            const off = b.subscribe((e) => res.write(sseMessage(e)));
            req.on("close", off);
            return;
          }
          if (req.method === "GET" && path === "/api/state") { b.poll(); return send(res, 200, b.state()); }
        }
        if (req.method === "GET" && path === "/api/history") return send(res, 200, await historyWithRuns(pathsOf(run)));
        if (req.method === "GET" && path.startsWith("/evidence/")) return serveFile(res, pathsOf(run).evidence, path.slice("/evidence/".length));
        if (req.method === "POST" && path !== "/api/play-session") return send(res, 409, { error: `${run} ${mode}: a selected run other than the server's own is read-only` });
      }
      if (player) {
        if (req.method === "GET" && path === "/events") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
          res.write(": ratchet replay\n\n");
          req.on("close", player.addClient(res));
          return;
        }
        if (req.method === "GET" && path === "/api/replay") return send(res, 200, player.status());
        if (req.method === "POST" && path === "/api/replay/control") {
          const b = (await readBody(req)) as { op?: string; value?: number };
          if (b?.op === "play") player.play();
          else if (b?.op === "pause") player.pause();
          else if (b?.op === "speed" && typeof b.value === "number") player.setSpeed(b.value);
          else if (b?.op === "seek" && typeof b.value === "number") player.seek(b.value);
          else return send(res, 400, { error: "op" });
          return send(res, 200, player.status());
        }
        if (req.method === "GET" && path === "/api/replay/records") {
          const at = Number(url.searchParams.get("at") ?? player.pos);
          return send(res, 200, recordsAround(player.tl, at, url.searchParams.get("stream") || undefined));
        }
        if (req.method === "GET" && path === "/api/replay/muse") return send(res, 200, museStream(player.tl, url.searchParams.get("attempt") ?? ""));
        if (req.method === "GET" && /^\/dist\/core-[0-9a-f]+\.js$/.test(path)) return serveFile(res, dist, path.slice("/dist/".length));
        if (req.method === "POST") return send(res, 409, { error: "replay mode: the recorded run is read-only" });
      }
      if (req.method === "GET" && path === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": ratchet\n\n");
        bus.poll();
        for (const e of bus.snapshot()) res.write(sseMessage(e));
        const off = bus.subscribe((e) => res.write(sseMessage(e)));
        req.on("close", off);
        return;
      }
      if (req.method === "GET" && path === "/api/state") { bus.poll(); return send(res, 200, bus.state()); }
      if (req.method === "GET" && path === "/api/trace") return send(res, 200, trace.trace);
      if (req.method === "GET" && path === "/api/history") return send(res, 200, await historyWithRuns(opts));
      if (req.method === "POST" && path === "/api/trace/reset") {
        const b = (await readBody(req)) as { rom_sha?: unknown };
        if (typeof b?.rom_sha !== "string") return send(res, 400, { error: "rom_sha" });
        trace.reset(b.rom_sha);
        log("input", "reset", { rom_sha: b.rom_sha });
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && path === "/api/input") {
        const b = (await readBody(req)) as { counter?: unknown; mask?: unknown };
        if (!isInt(b?.counter) || !isInt(b?.mask) || b.mask > 0xff) return send(res, 400, { error: "counter, mask" });
        trace.add({ from_counter: b.counter, mask: b.mask });
        log("input", "mask", { counter: b.counter, mask: b.mask, source: "keyboard" });
        bus.publish({ t: "player", intent: "keyboard", mask: b.mask });
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && path === "/api/play-session") {
        const b = (await readBody(req)) as Record<string, unknown> | null;
        const keys = b && typeof b === "object" ? Object.keys(b).sort().join(",") : "";
        const ok = (b?.op === "start" && keys === "op") || (b?.op === "stop" && keys === "duration_ms,op" && isInt(b.duration_ms));
        if (!ok) return send(res, 400, { error: "op start, or op stop with duration_ms" });
        log("ui", "play-session", b);
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && path === "/fire") return send(res, 200, { ok: true, fire: recordFire(await readBody(req), opts.ledger) });
      if (req.method === "POST" && path === "/api/event") {
        const e = (await readBody(req)) as UiEvent;
        if (!e || !PRODUCER_EVENTS.has(e.t)) return send(res, 400, { error: "event kind" });
        return send(res, 200, { ok: true, forwarded: bus.publish(e) });
      }
      if (req.method === "GET" && path.startsWith("/evidence/")) return serveFile(res, opts.evidence, path.slice("/evidence/".length));
      if (req.method === "GET" && path.startsWith("/game/")) return serveFile(res, opts.game, path.slice("/game/".length));
      return send(res, 404, { error: "no route" });
    } catch (err) {
      return send(res, 400, { error: String((err as Error).message) });
    }
  });
  server.on("close", () => { bus.stop(); player?.stop(); for (const b of buses.values()) b.stop(); for (const p of players.values()) p.stop(); });
  bus.start();
  return { server, bus, trace, player };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { processStart } = await import("../src/telemetry-process.ts");
  const { verify, appendReport, VERIFY_EVERY_S } = await import("./verify.ts");
  const { currentRun } = await import("../src/telemetry.ts");
  processStart("server");
  const opts = pathsFromEnv();
  let latest: unknown = null;
  const { server } = createServer({ ...opts, record: true, verifyReport: () => latest });
  const runVerify = async () => {
    try {
      const r = await verify({ paths: opts, run: currentRun() ?? "prerun", sinceMs: null });
      latest = r;
      appendReport(opts.runs, r);
    } catch (e) { console.error(`telemetry verify: ${(e as Error).message}`); }
  };
  setTimeout(runVerify, 5000).unref();
  setInterval(runVerify, VERIFY_EVERY_S * 1000).unref();
  server.listen(PORT, () => {
    console.log(`ratchet server :${PORT} ledger=${opts.ledger} evidence=${opts.evidence}`);
  });
}
