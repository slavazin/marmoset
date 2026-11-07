// The incident sink lockstep and suiteIncident write through: it mints INC-NNNN ids and appends
// Incident records (SPEC §6.5). Seam: loop/ledger.ts (S8) is the ledger's one writer; it replaces
// JsonlIncidentSink and keeps this interface. Truth-maker: lockstep/incidents.test.ts.
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Incident, StatusRecord } from "../src/schema.ts";

export interface IncidentSink {
  /** Incidents whose current status is "open". */
  open(): Incident[];
  /** Mints the next INC id, builds the record with it and appends it; returns the record. */
  record(make: (id: string) => Incident): Incident;
}

/** One ledger line's byte ceiling (D-0008: one line per append; the brief sets < 4 KB). */
export const MAX_LINE_BYTES = 4096;
/** How long an append waits for ledger/.lock before throwing, in milliseconds. */
export const LOCK_WAIT_MS = 5000;

export const mintId = (n: number) => `INC-${String(n).padStart(4, "0")}`;
const idNumber = (id: string) => Number(/^INC-(\d+)$/.exec(id)?.[1] ?? 0);

function currentOpen(records: Array<Incident | StatusRecord>): Incident[] {
  const byId = new Map<string, Incident>();
  const status = new Map<string, unknown>();
  for (const r of records) {
    if ((r as StatusRecord).t === "status") {
      if ((r as StatusRecord).field === "status") status.set(r.id, (r as StatusRecord).value);
    } else byId.set(r.id, r as Incident);
  }
  return [...byId.values()].filter((i) => (status.get(i.id) ?? i.status) === "open");
}

export class MemoryIncidentSink implements IncidentSink {
  readonly records: Array<Incident | StatusRecord> = [];
  open(): Incident[] { return currentOpen(this.records); }
  record(make: (id: string) => Incident): Incident {
    const n = Math.max(0, ...this.records.filter((r) => (r as StatusRecord).t !== "status").map((r) => idNumber(r.id))) + 1;
    const inc = make(mintId(n));
    this.records.push(inc);
    return inc;
  }
}

/**
 * Appends to a JSONL file (default ledger/incidents.jsonl) under an exclusive lock file created with
 * O_EXCL (default ledger/.lock, D-0008). The id is minted inside the lock from the file's highest INC id.
 */
export class JsonlIncidentSink implements IncidentSink {
  readonly path: string;
  readonly lockPath: string;
  readonly waitMs: number;
  constructor(path: string, lockPath: string = join(dirname(path), ".lock"), waitMs = LOCK_WAIT_MS) {
    this.path = path; this.lockPath = lockPath; this.waitMs = waitMs;
  }

  private read(): Array<Incident | StatusRecord> {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  }

  open(): Incident[] { return currentOpen(this.read()); }

  record(make: (id: string) => Incident): Incident {
    const fd = this.lock();
    try {
      const records = this.read();
      const n = Math.max(0, ...records.filter((r) => (r as StatusRecord).t !== "status").map((r) => idNumber(r.id))) + 1;
      const inc = make(mintId(n));
      const line = JSON.stringify(inc) + "\n";
      if (Buffer.byteLength(line) >= MAX_LINE_BYTES) throw new Error(`incident ${inc.id} line is ${Buffer.byteLength(line)} bytes, ceiling ${MAX_LINE_BYTES}`);
      appendFileSync(this.path, line);
      return inc;
    } finally {
      closeSync(fd);
      unlinkSync(this.lockPath);
    }
  }

  private lock(): number {
    const deadline = Date.now() + this.waitMs;
    for (;;) {
      try {
        return openSync(this.lockPath, "wx");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (Date.now() > deadline) throw new Error(`${this.lockPath} held for over ${this.waitMs} ms`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
  }
}
