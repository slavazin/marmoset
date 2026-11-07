// The SubQ wire (SPEC §2.1 "router", §6.13): request and response shapes, the key, the HTTP client, the record/replay
// cache and the one seam every SubQ caller takes its client from. It imports only ledger.ts and repair.ts (readDotEnv)
// of the loop, so loop/route.ts, loop/policies.ts and loop/sensors.ts all read it without an import cycle. Offers:
//   subqKey(env)              SUBQ_API_KEY, else `subquadratic_key` from .env (this checkout's, then the main checkout's);
//   httpClient(o)             one POST with a bearer key; the key travels only in the Authorization header;
//   cacheDir(env)             runs/<run|prerun>/subq-cache under the repository root ($RATCHET_SUBQ_CACHE overrides);
//   requestKey(req)           sha256 of the state (with the images) and sha256 of the question list;
//   cachedClient(inner, dir)  serves a request from <dir>/<echoed model>/<state16>-<questions16>.json, else asks
//                             `inner` and stores its answer; with $RATCHET_SUBQ_REPLAY=1 or a null `inner` a miss
//                             throws SubqReplayMiss and no live call is made;
//   subqClient()              the seam: a client set by setSubqClient, else the cache-only client in replay mode,
//                             else null in a test process or without a key, else the cached live client;
//   ROUTE_SENSOR_KEY, FORECAST_FIELDS  the record keys loop/route.ts and loop/sensors.ts write and loop/policies.ts
//                             reads.
// Tests: loop/sensors.test.ts (cache hit, miss, replay-only refusal).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { readDotEnv } from "./repair.ts";
import { runId } from "./ledger.ts";
import type { RouterQuestion } from "../src/schema.ts";

/** The SubQ Decisions endpoint and model (docs.subq.ai, read 2026-11-07). */
export const SUBQ_ENDPOINT = "https://api.subq.ai/v1/systemone";
export const SUBQ_MODEL = "subq-snap-1.1";

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
/** `cached`: served from the record/replay cache; `wall_ms` is then the recorded live call's. */
export interface SubqReply { status: number; body: SubqResponse | null; error?: string; wall_ms: number; cached?: boolean }
/** The seam every SubQ call passes through; tests pass a fake. */
export type SubqClient = (req: SubqRequest) => Promise<SubqReply>;

/** The pseudo-question under which a route record carries its sensor reading (loop/route.ts routeSensor). */
export const ROUTE_SENSOR_KEY = "_sensor";
/** Attempt fields loop/sensors.ts writes as status records (src/schema.ts Attempt.forecast_pass / forecast_mechanism). */
export const FORECAST_FIELDS = { pass: "forecast_pass", mechanism: "forecast_mechanism" } as const;

const ROOT = resolve(import.meta.dirname, "..");

/** The key: SUBQ_API_KEY in the environment, else `subquadratic_key` from .env (this checkout's, then the main checkout's). */
export function subqKey(env = process.env): string | undefined {
  if (env.SUBQ_API_KEY) return env.SUBQ_API_KEY;
  const cands = [join(ROOT, ".env")];
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

// ---- record / replay ----

/** Hex characters of each sha256 a cache file name carries. */
export const CACHE_KEY_CHARS = 16;

/** True when $RATCHET_SUBQ_REPLAY is "1": every SubQ answer comes from the cache and a miss throws. */
export const replayMode = (env = process.env): boolean => env.RATCHET_SUBQ_REPLAY === "1";

/** runs/<run|prerun>/subq-cache under the repository root; $RATCHET_SUBQ_CACHE overrides. */
export function cacheDir(env = process.env): string {
  return env.RATCHET_SUBQ_CACHE ? resolve(env.RATCHET_SUBQ_CACHE) : join(ROOT, "runs", runId(env) ?? "prerun", "subq-cache");
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** sha256 of the state with its images (the images are state the model reads) and sha256 of the question list. */
export function requestKey(req: SubqRequest): { state: string; questions: string } {
  return { state: sha(JSON.stringify({ state: req.state, images: (req.images ?? []).map((i) => sha(i.base64)) })), questions: sha(JSON.stringify(req.questions)) };
}

export class SubqReplayMiss extends Error {}

export interface CacheEntry {
  model_requested: string; model_echoed: string; state_sha: string; questions_sha: string; at: string; status: number; wall_ms: number;
  questions: Record<string, SubqQuestion>; n_images: number; response: SubqResponse;
}

const fileName = (k: { state: string; questions: string }) => `${k.state.slice(0, CACHE_KEY_CHARS)}-${k.questions.slice(0, CACHE_KEY_CHARS)}.json`;
const modelDir = (m: string) => m.replace(/[^\w.-]/g, "_") || "_";

/** The cache entry for `req` under `dir` (any echoed-model subdirectory, matching the requested model and both shas). */
export function lookup(req: SubqRequest, dir: string): CacheEntry | null {
  if (!existsSync(dir)) return null;
  const k = requestKey(req);
  for (const m of readdirSync(dir).sort()) {
    const p = join(dir, m, fileName(k));
    if (!existsSync(p)) continue;
    try {
      const e = JSON.parse(readFileSync(p, "utf8")) as CacheEntry;
      if (e.model_requested === req.model && e.state_sha === k.state && e.questions_sha === k.questions) return e;
    } catch { /* a torn file reads as a miss */ }
  }
  return null;
}

/** See the file header. */
export function cachedClient(inner: SubqClient | null, dir = cacheDir()): SubqClient {
  return async (req) => {
    const hit = lookup(req, dir);
    if (hit) return { status: hit.status, body: hit.response, wall_ms: hit.wall_ms, cached: true };
    const k = requestKey(req);
    if (!inner || replayMode()) throw new SubqReplayMiss(`SubQ replay: no cached answer for state ${k.state.slice(0, CACHE_KEY_CHARS)} questions ${k.questions.slice(0, CACHE_KEY_CHARS)} under ${dir}; no live call made`);
    const r = await inner(req);
    if (!r.error && r.body) {
      const echoed = r.body.model ?? "";
      const entry: CacheEntry = { model_requested: req.model, model_echoed: echoed, state_sha: k.state, questions_sha: k.questions, at: new Date().toISOString(), status: r.status, wall_ms: r.wall_ms,
        questions: req.questions, n_images: req.images?.length ?? 0, response: r.body };
      const d = join(dir, modelDir(echoed));
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, fileName(k)), JSON.stringify(entry, null, 2) + "\n");
    }
    return r;
  };
}

// ---- the seam ----

let override: SubqClient | null | undefined;
/** Sets the client subqClient() returns (null: none); undefined restores the default. Returns the previous setting. */
export function setSubqClient(c: SubqClient | null | undefined): SubqClient | null | undefined { const prev = override; override = c; return prev; }

/** A `node --test` process: it never reaches the live service unless a test sets a client through setSubqClient. */
export const inTestProcess = (env = process.env): boolean => env.NODE_TEST_CONTEXT !== undefined || process.execArgv.some((a) => a.startsWith("--test"));

/** See the file header. Null means no SubQ call is made and nothing is spent. */
export function subqClient(env = process.env): SubqClient | null {
  if (override !== undefined) return override;
  if (replayMode(env)) return cachedClient(null, cacheDir(env));
  if (inTestProcess(env) || !subqKey(env)) return null;
  return cachedClient(httpClient(), cacheDir(env));
}
