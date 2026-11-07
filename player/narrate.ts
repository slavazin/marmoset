// narrate: the narrator (SPEC §2.1). Given an incident's oracle frame, core frame and diff (its evidence
// directory's oracle.png, core.png, diff.png), it asks Gemini for one sentence in screen words and appends it as
// the incident's `narration` status record. The sentence nominates; nothing reads it to decide (D-0004).
// Truth-maker for the sentence check: player/player.test.ts.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { askJson, NARRATOR_MODEL, PLAYER_MODEL } from "./gemini.ts";
import { appendNarration } from "./ledger-append.ts";

const REPO = resolve(import.meta.dirname, "..");

export const NARRATION_SCHEMA = { type: "object", properties: { sentence: { type: "string" } }, required: ["sentence"] };

/** Accepts one sentence of at most 240 characters, or throws so askJson retries. */
export function checkSentence(v: unknown): string {
  const s = (v as { sentence?: unknown })?.sentence;
  if (typeof s !== "string") throw new Error("sentence");
  const t = s.trim().replace(/\s+/g, " ");
  if (!t || t.length > 240 || /[.!?]\s+\S/.test(t)) throw new Error("not one sentence");
  return t;
}

export const NARRATE_PROMPT = [
  "Three Game Boy screens follow: the reference emulator's frame, our emulator's frame, and a diff where the pixels that differ are marked.",
  "In one sentence of screen words, say what looks different and where on the screen (which band, which object).",
  "Name only what is visible; do not guess at causes or code. Reply with JSON {\"sentence\": string}.",
].join("\n");

export interface Narration { id: string; sentence: string; model: string; fallback: boolean }

/**
 * Narrates one incident. When NARRATOR_MODEL refuses for quota (HTTP 429), it narrates with PLAYER_MODEL and
 * says so (draft decision ledger/decisions/D-draft-narrator-flash-fallback.md).
 */
export async function narrate(o: { id: string; dir?: string; run?: string | null; ledgerFile?: string }): Promise<Narration> {
  const dir = o.dir ?? join(REPO, "evidence", "incidents", o.id);
  const img = (f: string) => ({ type: "image" as const, mime_type: "image/png" as const, data: readFileSync(join(dir, f)).toString("base64") });
  const parts = [{ type: "text" as const, text: NARRATE_PROMPT }, img("oracle.png"), img("core.png"), img("diff.png")];
  let fallback = false;
  let res;
  try {
    res = await askJson({ model: NARRATOR_MODEL, thinking: "medium", role: "narrator", run: o.run, parts, schema: NARRATION_SCHEMA, check: checkSentence });
  } catch (e) {
    if (!/\b429\b/.test(String(e))) throw e;
    fallback = true;
    res = await askJson({ model: PLAYER_MODEL, thinking: "low", role: "narrator", run: o.run, parts, schema: NARRATION_SCHEMA, check: checkSentence });
  }
  appendNarration(o.id, res.value, o.run ?? null, o.ledgerFile);
  return { id: o.id, sentence: res.value, model: res.model, fallback };
}
