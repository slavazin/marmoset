// The streaming chat call every long model call goes through (SPEC §5 S9 Bed, D-0001 Streaming API, D-0011, F4).
// `chat(req, opts)` POSTs one streaming request to `CHAT_ENDPOINT` over node:https with no socket, header or idle
// timeout, folds the SSE chunks into text, reasoning text, the echoed model string, finish_reason and usage, and
// returns an `LlmCall`. A reply with no content is `ok: false` with error "no usable output": a recorded failed call,
// never retried here (F4). Every call is logged to the telemetry `llm` stream (src/telemetry.ts) with the full
// request messages and the full streamed text; the key travels only in the Authorization header and is never logged.
// `recordSpend` appends the call to ledger/spend.jsonl priced by `PRICES`. Tests: loop/llm.test.ts.

import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { append, runId } from "./ledger.ts";
import { readDotEnv } from "./repair.ts";
import { tlog } from "../src/telemetry.ts";
import type { SpendRecord } from "../src/schema.ts";

/** The Meta chat completions endpoint (D-0001). */
export const CHAT_ENDPOINT = "https://api.meta.ai/v1/chat/completions";
/** The consolidator model (D-0003). */
export const CONSOLIDATOR_MODEL = "muse-wonder-1.0";
/**
 * Default max_tokens for a consolidator call. max_tokens counts reasoning tokens (D-0001: a cap of 20 returned empty
 * content); Wonder reasons silently for minutes (F4), so the cap leaves room for reasoning and the JSON reply.
 */
export const CONSOLIDATE_MAX_TOKENS = 32_000;

/**
 * USD per token, per model. Source: SPEC §7.3 (2026-11-06) "one Wonder system-core call is about 64k output tokens
 * (about $1.30)", which gives 1.30 / 64,000 per output token. Input-token prices and the Spark price are held by
 * review: no published rate was read; they are set equal to the output rate so spend reads high, not low.
 */
export const PRICES: Record<string, { in: number; out: number }> = {
  "muse-wonder-1.0": { in: 1.3 / 64_000, out: 1.3 / 64_000 },
  "muse-spark-1.3": { in: 1.3 / 64_000, out: 1.3 / 64_000 },
};

/** USD for a call's tokens under PRICES; a model with no price reads the muse-wonder-1.0 rate (held by review). */
export function priceUsd(model: string, tokensIn: number, tokensOut: number): number {
  const p = PRICES[model] ?? PRICES[CONSOLIDATOR_MODEL];
  return tokensIn * p.in + tokensOut * p.out;
}

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
export interface ChatRequest { model: string; messages: ChatMessage[]; max_tokens: number; role: SpendRecord["role"] }
export interface LlmCall {
  ok: boolean; text: string; reasoning: string; model_echoed: string; finish_reason: string | null;
  usage: { prompt: number; completion: number; reasoning: number }; wall_ms: number; http_status: number; error?: string;
}
/** The seam every consolidator call passes through; tests pass a fake. */
export type Llm = (req: ChatRequest) => Promise<LlmCall>;

/** The key: META_API_KEY in the environment, else `muse_code_key` from .env (this checkout's, then the main checkout's). */
export function apiKey(env = process.env): string | undefined {
  if (env.META_API_KEY) return env.META_API_KEY;
  const here = resolve(import.meta.dirname, "..", ".env");
  const cands = [here];
  try {
    const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: import.meta.dirname, encoding: "utf8" }).trim();
    cands.push(join(dirname(resolve(import.meta.dirname, common)), ".env"));
  } catch { /* not a git checkout */ }
  for (const f of cands) if (existsSync(f)) { const k = readDotEnv(f).muse_code_key; if (k) return k; }
  return undefined;
}

/** Folds SSE `data:` lines of an OpenAI-shaped stream into an LlmCall's content fields. */
export function foldSse(raw: string): Pick<LlmCall, "text" | "reasoning" | "model_echoed" | "finish_reason" | "usage"> & { error?: string } {
  let text = "", reasoning = "", model = "", finish: string | null = null, error: string | undefined;
  const usage = { prompt: 0, completion: 0, reasoning: 0 };
  for (const l of raw.split("\n")) {
    const m = /^data:\s?(.*)$/.exec(l.trim());
    if (!m || m[1] === "[DONE]" || !m[1]) continue;
    let c: Record<string, any>;
    try { c = JSON.parse(m[1]); } catch { continue; }
    if (c.error) error = typeof c.error === "string" ? c.error : String(c.error.message ?? JSON.stringify(c.error)).slice(0, 300);
    if (typeof c.model === "string") model = c.model;
    for (const ch of c.choices ?? []) {
      const d = ch.delta ?? ch.message ?? {};
      if (typeof d.content === "string") text += d.content;
      if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content;
      if (typeof d.reasoning === "string") reasoning += d.reasoning;
      if (ch.finish_reason) finish = ch.finish_reason;
    }
    if (c.usage) {
      usage.prompt = Number(c.usage.prompt_tokens ?? usage.prompt) || 0;
      usage.completion = Number(c.usage.completion_tokens ?? usage.completion) || 0;
      usage.reasoning = Number(c.usage.completion_tokens_details?.reasoning_tokens ?? c.usage.reasoning_tokens ?? usage.reasoning) || 0;
    }
  }
  return { text, reasoning, model_echoed: model, finish_reason: finish, usage, error };
}

/** One streaming call (see the file header). `endpoint` and `key` override for tests. */
export async function chat(req: ChatRequest, o: { endpoint?: string; key?: string } = {}): Promise<LlmCall> {
  const key = o.key ?? apiKey();
  const url = new URL(o.endpoint ?? CHAT_ENDPOINT);
  const body = JSON.stringify({ model: req.model, messages: req.messages, max_tokens: req.max_tokens, stream: true, stream_options: { include_usage: true } });
  const t0 = Date.now();
  tlog("llm", "request", { role: req.role, model_requested: req.model, max_tokens: req.max_tokens, messages: req.messages, endpoint: url.origin + url.pathname });
  const out = await new Promise<{ status: number; raw: string; err?: string }>((res) => {
    if (!key) return res({ status: 0, raw: "", err: "no key: META_API_KEY unset and .env holds no muse_code_key" });
    const request = url.protocol === "http:" ? httpRequest : httpsRequest; // http: only for a test endpoint
    const r = request(url, { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream", authorization: `Bearer ${key}`, "content-length": Buffer.byteLength(body) } }, (resp) => {
      let raw = "";
      resp.setEncoding("utf8");
      resp.on("data", (d: string) => { raw += d; });
      resp.on("end", () => res({ status: resp.statusCode ?? 0, raw }));
      resp.on("error", (e) => res({ status: resp.statusCode ?? 0, raw, err: e.message }));
    });
    r.setTimeout(0); // no idle timeout (D-0011, F4)
    r.on("error", (e) => res({ status: 0, raw: "", err: e.message }));
    r.end(body);
  });
  const f = foldSse(out.raw);
  const wall_ms = Date.now() - t0;
  let error = out.err ?? f.error;
  if (!error && (out.status < 200 || out.status >= 300)) error = `HTTP ${out.status}: ${out.raw.slice(0, 300)}`;
  if (!error && !f.text.trim()) error = "no usable output";
  const call: LlmCall = { ok: !error, ...f, wall_ms, http_status: out.status, error };
  // usage keys avoid "token" in their names: src/telemetry.ts redact() blanks any field matching /token/
  tlog("llm", "response", { role: req.role, model_requested: req.model, model_echoed: call.model_echoed, outcome: call.ok ? "ok" : "failed", error: call.error ?? null,
    finish_reason: call.finish_reason, n_prompt: call.usage.prompt, n_completion: call.usage.completion, n_reasoning: call.usage.reasoning, wall_ms, text: call.text, reasoning: call.reasoning });
  return call;
}

/** Appends a call's spend to ledger/spend.jsonl (SPEC §6.7) and returns the record. */
export function recordSpend(role: SpendRecord["role"], call: LlmCall, requested: string, ledger?: string): SpendRecord {
  const model = call.model_echoed || `${requested} (not echoed)`;
  const rec: SpendRecord = { at: new Date().toISOString(), run: runId(), role, model, tokens_in: call.usage.prompt, tokens_out: call.usage.completion, usd: priceUsd(call.model_echoed || requested, call.usage.prompt, call.usage.completion) };
  append("spend.jsonl", rec, ledger);
  return rec;
}
