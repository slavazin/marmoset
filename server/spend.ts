// The spend meter (SPEC §5 S10, §7.3). `spendMeter(o)` sums Attempt.spent.usd in ledger/attempts.jsonl and usd in
// ledger/spend.jsonl (the priced figure, by loop/llm.ts PRICES, which are list-rate placeholders held by review), and
// reads two owner-set corrections:
//   runs/<run>/spend-override.json   {"usd": <Meta console total>, "at": "<ISO time read>", "pre_run_usd": <spend
//                                    before the run opened, run null>}, filled by the owner from the Meta console;
//   RATCHET_SPEND_OFFSET_USD         a signed dollar offset on the priced figure, read only when no override exists.
// The owner-read figure is the run's spend: console total minus pre_run_usd, plus the priced dollars of records that
// carry this run and were written after `at` (list rates until the owner's next reading). The guard acts on owner-read
// when the override file exists, else on priced + offset. Owner reading 2026-11-07 ~12:50: about $5 in total against
// over $90 by PRICES (ATT-0001 alone $66.35), so PRICES read roughly 18x high; both figures stay on the meter.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Attempt, SpendRecord } from "../src/schema.ts";

/** Run spend at which the campaign pauses new attempts and asks the owner (SPEC §7.3). */
export const SPEND_ASK_USD = 60;
/** Run spend at which the campaign stops (SPEC §7.3). */
export const SPEND_STOP_USD = 80;
/** The override file's name under runs/<run>/. */
export const SPEND_OVERRIDE_FILE = "spend-override.json";
/** The meter's labels, so every screen names the two figures the same way. */
export const PRICED_LABEL = "priced (list rates, held by review)";
export const OWNER_LABEL = "owner-read (Meta console)";

export interface SpendOverride { usd: number; at: string; pre_run_usd: number; note?: string }
export interface SpendMeter {
  /** Attempt.spent.usd plus ledger/spend.jsonl usd, every record, by PRICES: PRICED_LABEL. */
  priced_usd: number;
  attempts_usd: number; attempts_n: number; calls_usd: number; calls_n: number;
  /** RATCHET_SPEND_OFFSET_USD, 0 when unset. */
  offset_usd: number;
  /** The run's spend by the owner's console reading (see the file header); null with no override file. */
  owner_read_usd: number | null;
  override: SpendOverride | null;
  /** The figure the guard acts on. */
  usd: number;
  source: "owner-read" | "priced" | "priced+offset";
  ask_usd: number; stop_usd: number;
}

type Att = Pick<Attempt, "id" | "at" | "spent" | "run"> & { spent_at?: string };

function lines(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) return [];
  const out: Record<string, unknown>[] = [];
  for (const l of readFileSync(file, "utf8").split("\n")) { if (l.trim()) try { out.push(JSON.parse(l)); } catch { /* partial line */ } }
  return out;
}

/** Attempts folded by id with their status records; the last `spent` written wins and dates the spend. */
function attempts(ledger: string): Att[] {
  const by = new Map<string, Record<string, unknown>>();
  for (const r of lines(join(ledger, "attempts.jsonl"))) {
    if (r.t === "status") { const c = by.get(String(r.id)); if (c) { c[String(r.field)] = r.value; if (r.field === "spent") c.spent_at = r.at; } continue; }
    if (typeof r.id === "string") by.set(r.id, { ...r });
  }
  return [...by.values()] as unknown as Att[];
}

export function readOverride(runsDir: string, run: string | null): SpendOverride | null {
  if (!run) return null;
  const p = join(runsDir, run, SPEND_OVERRIDE_FILE);
  if (!existsSync(p)) return null;
  try {
    const o = JSON.parse(readFileSync(p, "utf8")) as Partial<SpendOverride>;
    if (typeof o.usd !== "number" || !Number.isFinite(o.usd) || typeof o.at !== "string" || !Number.isFinite(Date.parse(o.at))) return null;
    return { ...o, usd: o.usd, at: o.at, pre_run_usd: typeof o.pre_run_usd === "number" && Number.isFinite(o.pre_run_usd) ? o.pre_run_usd : 0 };
  } catch { return null; }
}

export interface MeterOptions { ledger: string; runsDir: string; run: string | null; env?: NodeJS.ProcessEnv }

/** The meter (see the file header). */
export function spendMeter(o: MeterOptions): SpendMeter {
  const env = o.env ?? process.env;
  const atts = attempts(o.ledger);
  const calls = lines(join(o.ledger, "spend.jsonl")).filter((r) => typeof r.usd === "number") as unknown as SpendRecord[];
  const attempts_usd = atts.reduce((s, a) => s + (a.spent?.usd ?? 0), 0);
  const calls_usd = calls.reduce((s, r) => s + r.usd, 0);
  const priced_usd = attempts_usd + calls_usd;
  const off = Number(env.RATCHET_SPEND_OFFSET_USD ?? 0);
  const offset_usd = Number.isFinite(off) ? off : 0;
  const override = readOverride(o.runsDir, o.run);
  let owner_read_usd: number | null = null;
  if (override) {
    const t = Date.parse(override.at);
    const after = atts.filter((a) => a.run === o.run && Date.parse(a.spent_at ?? a.at) > t).reduce((s, a) => s + (a.spent?.usd ?? 0), 0)
      + calls.filter((r) => r.run === o.run && Date.parse(r.at) > t).reduce((s, r) => s + r.usd, 0);
    owner_read_usd = override.usd - override.pre_run_usd + after;
  }
  const usd = owner_read_usd ?? priced_usd + offset_usd;
  return {
    priced_usd, attempts_usd, attempts_n: atts.length, calls_usd, calls_n: calls.length, offset_usd, owner_read_usd, override, usd,
    source: owner_read_usd !== null ? "owner-read" : offset_usd ? "priced+offset" : "priced", ask_usd: SPEND_ASK_USD, stop_usd: SPEND_STOP_USD,
  };
}

export type SpendGate = "go" | "ask" | "stop";
/** What the guard does at `usd`: stop at SPEND_STOP_USD, ask at SPEND_ASK_USD, else go. */
export function spendGate(usd: number): SpendGate {
  return usd >= SPEND_STOP_USD ? "stop" : usd >= SPEND_ASK_USD ? "ask" : "go";
}

/** One meter line naming both figures (the campaign prints it; the History tab shows the same fields). */
export function meterLine(m: SpendMeter): string {
  const owner = m.owner_read_usd === null ? "no runs/<run>/spend-override.json" : `$${m.owner_read_usd.toFixed(2)}`;
  return `spend: ${OWNER_LABEL} ${owner} · ${PRICED_LABEL} $${m.priced_usd.toFixed(2)}${m.offset_usd ? ` (offset ${m.offset_usd})` : ""} · guard reads ${m.source} $${m.usd.toFixed(2)} (ask $${m.ask_usd}, stop $${m.stop_usd})`;
}
