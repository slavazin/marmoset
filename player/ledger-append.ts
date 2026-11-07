// appendLine: the player lane's locked JSONL append (D-0008): one line under 4 KB, written while holding
// ledger/.lock created with O_EXCL. Seam: loop/ledger.ts (S8) is the ledger's one writer and replaces this
// module; callers keep the signature. Truth-maker: player/player.test.ts.
import { appendFileSync, closeSync, openSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { SpendRecord, StatusRecord } from "../src/schema.ts";
import { LOCK_WAIT_MS, MAX_LINE_BYTES } from "../lockstep/incidents.ts";

export const LEDGER_DIR = resolve(import.meta.dirname, "..", "ledger");

export function appendLine(file: string, record: unknown, lockPath = join(dirname(file), ".lock")): void {
  const line = JSON.stringify(record) + "\n";
  if (Buffer.byteLength(line) >= MAX_LINE_BYTES) throw new Error(`${file}: line is ${Buffer.byteLength(line)} bytes, ceiling ${MAX_LINE_BYTES}`);
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number;
  for (;;) {
    try { fd = openSync(lockPath, "wx"); break; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (Date.now() > deadline) throw new Error(`${lockPath} held for over ${LOCK_WAIT_MS} ms`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try { appendFileSync(file, line); } finally { closeSync(fd); unlinkSync(lockPath); }
}

/** Appends one Gemini call's spend to ledger/spend.jsonl (SPEC §6.7 spend shape). */
export function appendSpend(r: SpendRecord, file = join(LEDGER_DIR, "spend.jsonl")): void { appendLine(file, r); }

/** Appends an incident's narration as a status record (SPEC §6 status records) to ledger/incidents.jsonl. */
export function appendNarration(id: string, text: string, run: string | null, file = join(LEDGER_DIR, "incidents.jsonl")): StatusRecord {
  const rec: StatusRecord = { t: "status", id, field: "narration", value: text, at: new Date().toISOString(), run };
  appendLine(file, rec);
  return rec;
}
