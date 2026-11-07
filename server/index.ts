// The UI server (SPEC §5 S6), port 8787. Offers:
//   GET  /events            SSE stream of UiEvents (§6.18): a snapshot of the ledger, then every tailed append.
//   GET  /api/state         the folded ledger view (incidents, attempts, verdicts, fires, provenance, curve, vread).
//   POST /api/trace/reset   {rom_sha} starts the live trace for a loaded ROM.
//   POST /api/input         {counter, mask} appends one TraceInput to the live trace.
//   GET  /api/trace         the live trace (§6.5 Trace).
//   POST /api/event         a UiEvent from another producer (lockstep, player); frames are capped per source.
//   GET  /evidence/**, /game/**   files under the evidence dir and the game dir.
//   POST /fire              a hook fire {skill, attempt, path, owed}; server/fire.ts appends it to ledger/fires.jsonl.
// The live trace is a working trace at $RATCHET_CACHE/traces/live.json; /fire is the one ledger write, through loop/ledger.ts.

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

export interface ServerOptions extends Paths { game: string; cache: string }

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

export function createServer(opts: ServerOptions): { server: Server; bus: EventBus; trace: LiveTrace } {
  const bus = new EventBus(opts);
  const trace = new LiveTrace(join(opts.cache, "traces", "live.json"));

  const server = httpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
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
      if (req.method === "GET" && path === "/api/history") return send(res, 200, await (await import("./history.ts")).historyFor(opts));
      if (req.method === "POST" && path === "/api/trace/reset") {
        const b = (await readBody(req)) as { rom_sha?: unknown };
        if (typeof b?.rom_sha !== "string") return send(res, 400, { error: "rom_sha" });
        trace.reset(b.rom_sha);
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && path === "/api/input") {
        const b = (await readBody(req)) as { counter?: unknown; mask?: unknown };
        if (!isInt(b?.counter) || !isInt(b?.mask) || b.mask > 0xff) return send(res, 400, { error: "counter, mask" });
        trace.add({ from_counter: b.counter, mask: b.mask });
        bus.publish({ t: "player", intent: "keyboard", mask: b.mask });
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
  server.on("close", () => bus.stop());
  bus.start();
  return { server, bus, trace };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = pathsFromEnv();
  const { server } = createServer(opts);
  server.listen(PORT, () => {
    console.log(`ratchet server :${PORT} ledger=${opts.ledger} evidence=${opts.evidence}`);
  });
}
