// The visual sensor's model seam (S13, owner directive 2026-11-07): one image-and-text request in, one text
// reply out. geminiClient sends it to Gemini through the Interactions API (@google/genai, the package S7 pins);
// tests pass a fake VisionClient and read the captured VisionRequest. framePng renders a core frame's shades;
// checkAnswer validates the JSON the model returns. Every Gemini call is logged with tlog("llm", …) and its
// spend appended to ledger/spend.jsonl through loop/ledger.ts. The key comes from GEMINI_API_KEY or
// gemini_api_key in the environment and is never printed.
import { createHash } from "node:crypto";
import { GoogleGenAI } from "@google/genai";
import { PNG } from "pngjs";
import { append, ledgerDir, runId } from "../loop/ledger.ts";
import type { SpendRecord } from "../src/schema.ts";
import { tlog } from "../src/telemetry.ts";

/** The model the sensor asks (owner brief, S13). */
export const SPOT_MODEL = "gemini-3.8-flash";
/** Thinking level for each call (owner brief, S13). */
export const SPOT_THINKING = "low";
/** Each frame pixel becomes SPOT_SCALE × SPOT_SCALE image pixels; 160×144 at 4 is 640×576. Not tuned. */
export const SPOT_SCALE = 4;
/** The model reports boxes on this grid in both axes (the 0..1000 convention Gemini is trained on); spot.ts maps them to frame pixels. */
export const BOX_GRID = 1000;
/**
 * USD per million tokens for the spend record. No price page was read for this model string; the values are
 * the ones S7 (player/gemini.ts) carries and stand until the orchestrator reads the real ones.
 */
export const USD_PER_MTOK = { in: 0.3, out: 2.5 };

/** SPEC §6.13 router subsystem categories. */
export const SUBSYSTEMS = ["ppu_fetcher", "stat_irq", "oam_dma", "window", "timer", "other"] as const;
export type Subsystem = (typeof SUBSYSTEMS)[number];

/** What the model returns; bbox is on the BOX_GRID, [x0, y0, x1, y1], or null with no glitch. */
export interface ModelAnswer { glitch: boolean; confidence: number; bbox: [number, number, number, number] | null; subsystem: Subsystem; why: string }

export interface VisionRequest { model: string; thinking: string; prompt: string; image: { mime_type: "image/png"; data: string /* base64 */ } }
export interface VisionReply { text: string; model: string; tokens_in: number; tokens_out: number; ms: number }
export type VisionClient = (req: VisionRequest) => Promise<VisionReply>;

/** JSON schema for the reply (response_format). */
export const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    glitch: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    bbox: { type: ["array", "null"], items: { type: "number" }, minItems: 4, maxItems: 4 },
    subsystem: { type: "string", enum: [...SUBSYSTEMS] },
    why: { type: "string" },
  },
  required: ["glitch", "confidence", "bbox", "subsystem", "why"],
};

const RGB = [0xffffff, 0xaaaaaa, 0x555555, 0x000000]; // shade 0..3, as lockstep/evidence.ts renders them

/** A 160×144 frame of shades 0..3 as a PNG, each pixel scaled to SPOT_SCALE × SPOT_SCALE. */
export function framePng(shades: Uint8Array, scale = SPOT_SCALE, width = 160, height = 144): Buffer {
  const p = new PNG({ width: width * scale, height: height * scale });
  for (let y = 0; y < height * scale; y++)
    for (let x = 0; x < width * scale; x++) {
      const c = RGB[shades[Math.floor(y / scale) * width + Math.floor(x / scale)] & 3];
      const i = (y * width * scale + x) * 4;
      p.data[i] = c >> 16; p.data[i + 1] = (c >> 8) & 255; p.data[i + 2] = c & 255; p.data[i + 3] = 255;
    }
  return PNG.sync.write(p);
}

/** Extracts the first JSON object from a reply, tolerating code fences and prose around it. */
export function parseJsonObject(text: string): unknown {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e <= s) throw new Error("no JSON object in reply");
  return JSON.parse(text.slice(s, e + 1));
}

/** Validates a parsed reply as a ModelAnswer; throws naming the first bad field. */
export function checkAnswer(v: unknown): ModelAnswer {
  const o = v as Record<string, unknown>;
  if (!o || typeof o !== "object") throw new Error("reply is not an object");
  if (typeof o.glitch !== "boolean") throw new Error("glitch is not a boolean");
  if (typeof o.confidence !== "number" || !(o.confidence >= 0 && o.confidence <= 1)) throw new Error("confidence is not in 0..1");
  if (!SUBSYSTEMS.includes(o.subsystem as Subsystem)) throw new Error(`subsystem ${String(o.subsystem)} is not one of ${SUBSYSTEMS.join(", ")}`);
  if (typeof o.why !== "string") throw new Error("why is not a string");
  let bbox: ModelAnswer["bbox"] = null;
  if (o.bbox !== null && o.bbox !== undefined) {
    const b = o.bbox as unknown[];
    if (!Array.isArray(b) || b.length !== 4 || !b.every((x) => typeof x === "number" && Number.isFinite(x))) throw new Error("bbox is not four numbers or null");
    bbox = b as [number, number, number, number];
  }
  return { glitch: o.glitch, confidence: o.confidence, bbox, subsystem: o.subsystem as Subsystem, why: o.why };
}

let ai: GoogleGenAI | null = null;
function genai(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.gemini_api_key;
  if (!apiKey) throw new Error("no GEMINI_API_KEY or gemini_api_key in the environment");
  // v1beta: on v1 the Interactions API refuses text input parts and response_format (S7 reading 2026-11-07).
  ai ??= new GoogleGenAI({ apiKey, apiVersion: "v1beta" });
  return ai;
}

/** The Gemini VisionClient: one Interactions call per request, logged to the llm stream, spend appended to `ledger`. */
export function geminiClient(ledger = ledgerDir()): VisionClient {
  return async (req) => {
    const t0 = performance.now();
    const logged = { model: req.model, thinking: req.thinking, prompt: req.prompt, image_sha256: createHash("sha256").update(req.image.data).digest("hex"), image_b64_bytes: req.image.data.length };
    let r: { model?: string; output_text?: string; usage?: { total_input_tokens?: number; total_output_tokens?: number; total_thought_tokens?: number } };
    try {
      r = (await genai().interactions.create({
        model: req.model,
        input: [{ type: "text", text: req.prompt }, { type: "image", data: req.image.data, mime_type: req.image.mime_type }],
        generation_config: { thinking_level: req.thinking },
        response_format: { type: "text", mime_type: "application/json", schema: ANSWER_SCHEMA },
      } as never)) as unknown as typeof r;
    } catch (e) {
      const ms = performance.now() - t0;
      tlog("llm", "call", { role: "spotter", request: logged, outcome: "error", error: String((e as Error).message ?? e), ms });
      throw e;
    }
    const ms = performance.now() - t0;
    const model = r.model ?? req.model;
    const tokens_in = r.usage?.total_input_tokens ?? 0;
    const tokens_out = (r.usage?.total_output_tokens ?? 0) + (r.usage?.total_thought_tokens ?? 0);
    const text = r.output_text ?? "";
    tlog("llm", "call", { role: "spotter", model_requested: req.model, model_echoed: model, request: logged, response: text, tokens_in, tokens_out, ms, outcome: "ok" });
    // SpendRecord.role has no "spotter" (finding); the sensor is the player lane's.
    const spend: SpendRecord = { at: new Date().toISOString(), run: runId(), role: "player", model, tokens_in, tokens_out, usd: (tokens_in * USD_PER_MTOK.in + tokens_out * USD_PER_MTOK.out) / 1e6 };
    try { append("spend.jsonl", spend, ledger); } catch (e) { process.stderr.write(`spot: spend append failed (${(e as Error).message})\n`); }
    return { text, model, tokens_in, tokens_out, ms };
  };
}
