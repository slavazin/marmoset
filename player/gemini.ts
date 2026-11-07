// askJson: one Gemini Interactions API call (@google/genai, SPEC §5 S7 bed) that sends text and PNG parts,
// asks for JSON under a schema, parses the reply and retries on a parse failure (S7 Wiggle: JSON in text with
// parse-and-retry). Every call appends its spend to ledger/spend.jsonl through player/ledger-append.ts and
// returns the model string the service echoed. The key comes from GEMINI_API_KEY or gemini_api_key in the
// environment and is never printed.
import { GoogleGenAI } from "@google/genai";
import type { SpendRecord } from "../src/schema.ts";
import { appendSpend } from "./ledger-append.ts";

export const PLAYER_MODEL = "gemini-3.8-flash";
export const NARRATOR_MODEL = "gemini-4-argon";
/**
 * USD per million tokens, by model, for the spend record's `usd`. No price page was read for these model
 * strings; the values are Gemini 2.5 Flash's list prices and stand until the orchestrator reads the real ones.
 */
export const USD_PER_MTOK: Record<string, { in: number; out: number }> = {
  "gemini-3.8-flash": { in: 0.3, out: 2.5 },
  "gemini-4-argon": { in: 1.25, out: 10 },
};
/** Attempts per call before askJson throws: one ask plus retries on an unparseable reply. */
export const PARSE_ATTEMPTS = 3;

export type Part = { type: "text"; text: string } | { type: "image"; data: string; mime_type: "image/png" };

export interface AskResult<T> { value: T; model: string; ms: number; tokens_in: number; tokens_out: number }

let client: GoogleGenAI | null = null;
function ai(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.gemini_api_key;
  if (!apiKey) throw new Error("no GEMINI_API_KEY or gemini_api_key in the environment");
  // v1beta: on v1 the Interactions API refuses text input parts and response_format (reading 2026-11-07).
  client ??= new GoogleGenAI({ apiKey, apiVersion: "v1beta" });
  return client;
}

/** Extracts the first JSON object from a reply, tolerating code fences and prose around it. */
export function parseJsonObject(text: string): unknown {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e <= s) throw new Error("no JSON object in reply");
  return JSON.parse(text.slice(s, e + 1));
}

export async function askJson<T>(o: {
  model: string; thinking: "low" | "medium"; role: SpendRecord["role"]; parts: Part[];
  schema: Record<string, unknown>; check: (v: unknown) => T; run?: string | null;
}): Promise<AskResult<T>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < PARSE_ATTEMPTS; attempt++) {
    const t0 = performance.now();
    const parts = attempt === 0 ? o.parts : [...o.parts, { type: "text" as const, text: "Your last reply did not parse. Reply with one JSON object only." }];
    const r = (await ai().interactions.create({
      model: o.model, input: parts, generation_config: { thinking_level: o.thinking },
      response_format: { type: "text", mime_type: "application/json", schema: o.schema },
    } as never)) as unknown as { model?: string; output_text?: string; usage?: { total_input_tokens?: number; total_output_tokens?: number; total_thought_tokens?: number } };
    const ms = performance.now() - t0;
    const model = r.model ?? o.model;
    const tokens_in = r.usage?.total_input_tokens ?? 0;
    const tokens_out = (r.usage?.total_output_tokens ?? 0) + (r.usage?.total_thought_tokens ?? 0);
    const price = USD_PER_MTOK[model] ?? USD_PER_MTOK[o.model] ?? { in: 0, out: 0 };
    appendSpend({ at: new Date().toISOString(), run: o.run ?? null, role: o.role, model, tokens_in, tokens_out, usd: (tokens_in * price.in + tokens_out * price.out) / 1e6 });
    try {
      return { value: o.check(parseJsonObject(r.output_text ?? "")), model, ms, tokens_in, tokens_out };
    } catch (e) { lastErr = e; }
  }
  throw new Error(`${o.model}: no parseable reply in ${PARSE_ATTEMPTS} attempts: ${String(lastErr)}`);
}
