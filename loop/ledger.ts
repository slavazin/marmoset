// The one appender of ledger/*.jsonl (AGENTS.md rule 2, D-0008). Offers:
//   append(file, record)            one JSON line under the exclusive lock ledger/.lock (O_EXCL), any process;
//   appendNew(file, prefix, build)  mints PREFIX-NNNN under the same lock and appends the record it builds;
//   status(file, id, field, value)  appends a status record {t:"status", id, field, value, at, run} (SPEC §6);
//   read(file) / current(file, id)  the records, and one id folded with its status records (last one written wins).
// A line of LINE_LIMIT bytes or more is refused with a throw; nothing is written for it.

import { openSync, closeSync, writeSync, unlinkSync, existsSync, readFileSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { IdPrefix, StatusRecord } from "../src/schema.ts";

/** Bytes a ledger line must stay under, newline included (SPEC §5 S8). */
export const LINE_LIMIT = 4096;
/** Milliseconds a waiter spins for ledger/.lock before it throws. */
export const LOCK_WAIT_MS = 10_000;
/** A lock file older than this many milliseconds is a crashed writer's and is broken. */
export const LOCK_STALE_MS = 30_000;

/** Prefix for steer ids; SPEC §6.0 names no steer prefix (a finding for the orchestrator). */
export const STEER_PREFIX = "STR";

export type LedgerFile = "incidents.jsonl" | "attempts.jsonl" | "verdicts.jsonl" | "observations.jsonl" | "fires.jsonl" | "steers.jsonl" | "spend.jsonl";

/** The ledger directory: $RATCHET_LEDGER, else the repository's ledger/. */
export function ledgerDir(env = process.env): string {
  return resolve(import.meta.dirname, "..", env.RATCHET_LEDGER ?? "ledger");
}

/** The run id records carry: $RATCHET_RUN, else null (records with run null enter no figure, SPEC §6). */
export function runId(env = process.env): string | null {
  return env.RATCHET_RUN || null;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Runs `fn` holding `<dir>/.lock`, created with O_EXCL; waits up to LOCK_WAIT_MS. */
export function withLock<T>(dir: string, fn: () => T): T {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, ".lock");
  const t0 = Date.now();
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lock, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock); } catch { /* raced */ }
      if (Date.now() - t0 > LOCK_WAIT_MS) throw new Error(`ledger lock ${lock} held over ${LOCK_WAIT_MS} ms`);
      sleepMs(5);
    }
  }
  try {
    writeSync(fd, String(process.pid));
    return fn();
  } finally {
    closeSync(fd);
    unlinkSync(lock);
  }
}

function line(rec: unknown): string {
  const s = JSON.stringify(rec) + "\n";
  const n = Buffer.byteLength(s);
  if (n >= LINE_LIMIT) throw new Error(`ledger line of ${n} bytes is over LINE_LIMIT ${LINE_LIMIT}`);
  return s;
}

function appendRaw(dir: string, file: string, s: string): void {
  const fd = openSync(join(dir, file), "a");
  try { writeSync(fd, s); } finally { closeSync(fd); }
}

/** Appends one record to `file` under the lock. */
export function append(file: LedgerFile, rec: unknown, dir = ledgerDir()): void {
  const s = line(rec);
  withLock(dir, () => appendRaw(dir, file, s));
}

/** Every parsed record of `file`, in write order; a malformed or partial line is skipped. */
export function read(file: LedgerFile, dir = ledgerDir()): Record<string, unknown>[] {
  const p = join(dir, file);
  if (!existsSync(p)) return [];
  const out: Record<string, unknown>[] = [];
  for (const l of readFileSync(p, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try { out.push(JSON.parse(l)); } catch { /* partial line from a racing append (D-0008 residue) */ }
  }
  return out;
}

/** The next id for `prefix` given existing records: one past the highest PREFIX-NNNN seen, 4 digits minimum. */
export function nextId(prefix: IdPrefix | typeof STEER_PREFIX, ids: Iterable<string>): string {
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const id of ids) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}

/** Mints an id under the lock from `file`'s records and appends `build(id)`; returns the record. */
export function appendNew<T>(file: LedgerFile, prefix: IdPrefix | typeof STEER_PREFIX, build: (id: string) => T, dir = ledgerDir()): T {
  return withLock(dir, () => {
    const ids = read(file, dir).map((r) => String(r.id ?? ""));
    const rec = build(nextId(prefix, ids));
    appendRaw(dir, file, line(rec));
    return rec;
  });
}

/** Appends a status record setting `field` of `id` (SPEC §6). */
export function status(file: LedgerFile, id: string, field: string, value: unknown, dir = ledgerDir()): StatusRecord {
  const rec: StatusRecord = { t: "status", id, field, value, at: new Date().toISOString(), run: runId() };
  append(file, rec, dir);
  return rec;
}

/** The record `id` of `file` with every later status record folded in; undefined when no record has that id. */
export function current<T = Record<string, unknown>>(file: LedgerFile, id: string, dir = ledgerDir()): T | undefined {
  let cur: Record<string, unknown> | undefined;
  for (const r of read(file, dir)) {
    if (r.t === "status") { if (cur && r.id === id) cur[String(r.field)] = r.value; continue; }
    if (r.id === id) cur = { ...(cur ?? {}), ...r };
  }
  return cur as T | undefined;
}

/** Every record of `file` folded by id, in order of first appearance. */
export function all<T = Record<string, unknown>>(file: LedgerFile, dir = ledgerDir()): T[] {
  const by = new Map<string, Record<string, unknown>>();
  for (const r of read(file, dir)) {
    if (r.t === "status") { const c = by.get(String(r.id)); if (c) c[String(r.field)] = r.value; continue; }
    if (typeof r.id === "string") by.set(r.id, { ...(by.get(r.id) ?? {}), ...r });
  }
  return [...by.values()] as T[];
}
