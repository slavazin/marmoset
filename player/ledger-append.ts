// The player lane's two ledger writes, made through loop/ledger.ts, the ledger's one appender (AGENTS.md
// rule 2, D-0008): a Gemini call's spend line and an incident's narration status record. `dir` is the ledger
// directory (default loop/ledger.ts ledgerDir()). Truth-maker: player/player.test.ts.
import type { SpendRecord, StatusRecord } from "../src/schema.ts";
import { append, ledgerDir, status } from "../loop/ledger.ts";

/** Appends one Gemini call's spend to <dir>/spend.jsonl (SPEC §6.7 spend shape). */
export function appendSpend(r: SpendRecord, dir = ledgerDir()): void { append("spend.jsonl", r, dir); }

/** Appends an incident's narration as a status record (SPEC §6) to <dir>/incidents.jsonl. */
export function appendNarration(id: string, text: string, dir = ledgerDir()): StatusRecord {
  return status("incidents.jsonl", id, "narration", text, dir);
}
