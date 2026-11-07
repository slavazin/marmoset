// The spend meter (SPEC §5 S10, §7.3). `spendMeter(o)` sums Attempt.spent.usd in ledger/attempts.jsonl and usd in
// ledger/spend.jsonl (the priced figure, by loop/llm.ts PRICES, which are list-rate placeholders held by review), and
// reads two owner-set corrections:
//   runs/<run>/spend-override.json   {"usd": <Meta console total>, "at": "<ISO time read>", "pre_run_usd": <spend
//                                    before the run opened, run null>}, filled by the owner from the Meta console;
//   RATCHET_SPEND_OFFSET_USD         a signed dollar offset on the priced figure, read only when no override exists.
// The owner-read figure is the run's spend: console total minus pre_run_usd, plus ratio × the priced dollars of
// records that carry this run and were written after `at` (or after the file's write time when `at` is later, with a
// warning; readOverride). ratio is ownerRatio: the console total over every priced dollar up to `at`, pre-run
// included, clamped to (0, 1], so list rates are scaled by the owner's reading until the next one
// (campaign.test.ts "scaled by the owner's ratio"). The guard acts on owner-read
// when the override file exists, else on priced + offset. Owner reading 2026-11-07 ~12:50: about $5 in total against
// over $90 by PRICES (ATT-0001 alone $66.35), so PRICES read roughly 18x high; both figures stay on the meter.

import { existsSync, readFileSync, statSync } from "node:fs";
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
  /** ownerRatio at the reading: the factor on priced dollars after it; null with no override file. */
  ratio: number | null;
  override: SpendOverride | null;
  /** The figure the guard acts on. */
  usd: number;
  source: "owner-read" | "priced" | "priced+offset";
  ask_usd: number; stop_usd: number;
  /** Set when the override's `at` is later than the file's write time (readOverride). */
  warning?: string;
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

/**
 * The override file, or null. `written_ms` is the file's mtime: a console reading cannot postdate the file holding it,
 * so spendMeter reads min(at, written_ms) and warns when `at` is later (a future `at` drops the run's priced records
 * written between the file's write and `at`; campaign.test.ts "later than the file was written").
 */
export function readOverride(runsDir: string, run: string | null): (SpendOverride & { written_ms: number }) | null {
  if (!run) return null;
  const p = join(runsDir, run, SPEND_OVERRIDE_FILE);
  if (!existsSync(p)) return null;
  try {
    const o = JSON.parse(readFileSync(p, "utf8")) as Partial<SpendOverride>;
    if (typeof o.usd !== "number" || !Number.isFinite(o.usd) || typeof o.at !== "string" || !Number.isFinite(Date.parse(o.at))) return null;
    return { ...o, usd: o.usd, at: o.at, pre_run_usd: typeof o.pre_run_usd === "number" && Number.isFinite(o.pre_run_usd) ? o.pre_run_usd : 0, written_ms: statSync(p).mtimeMs };
  } catch { return null; }
}

/**
 * The reserve per in-flight attempt before the run has a finished one, in console dollars: the owner's console total
 * of about $5 on 2026-11-07 ~12:50 covered all pre-run work including ATT-0001 (runs/RUN-0001/spend-override.json
 * note), so one attempt costs at most that; held by review.
 */
export const ATTEMPT_RESERVE_USD = 5;

/**
 * The guard's reserve per in-flight attempt: the median spent.usd × ratio (ratio null reads 1) of attempts that carry
 * `run` and hold a result, else ATTEMPT_RESERVE_USD (campaign.test.ts "reserve is the median").
 */
export function attemptReserve(o: { ledger: string; run: string | null; ratio: number | null }): number {
  const done = attempts(o.ledger).filter((a) => a.run === o.run && (a as { result?: unknown }).result != null && typeof a.spent?.usd === "number")
    .map((a) => a.spent.usd * (o.ratio ?? 1)).sort((x, y) => x - y);
  if (!done.length) return ATTEMPT_RESERVE_USD;
  const k = done.length >> 1;
  return done.length % 2 ? done[k] : (done[k - 1] + done[k]) / 2;
}

/** Console dollars per priced dollar at the reading, clamped to (0, 1]; 1 when nothing was priced before it. */
export function ownerRatio(consoleUsd: number, pricedBeforeUsd: number): number {
  if (!(pricedBeforeUsd > 0) || !(consoleUsd > 0)) return 1;
  return Math.min(1, consoleUsd / pricedBeforeUsd);
}

export interface MeterOptions {
  ledger: string; runsDir: string; run: string | null; env?: NodeJS.ProcessEnv;
  /**
   * Further ledgers whose priced records up to the override's `at` join ownerRatio's denominator, so a run on its own
   * ledger prices at the console ratio of the ledger the owner's reading stands against (combinedMeter).
   */
  ratioLedgers?: string[];
  /** jsonl files of `{at, run, spent: {usd}}` records priced like spend.jsonl calls of `run` (runs/<run>/muse-native.jsonl). */
  extraFiles?: string[];
}

/** The meter (see the file header). */
export function spendMeter(o: MeterOptions): SpendMeter {
  const env = o.env ?? process.env;
  const atts = attempts(o.ledger);
  const extra = (o.extraFiles ?? []).flatMap((f) => lines(f)).map((r) => ({ at: String(r.at ?? ""), run: (r.run ?? null) as string | null, usd: Number((r.spent as { usd?: unknown } | undefined)?.usd) }))
    .filter((r) => Number.isFinite(r.usd) && Number.isFinite(Date.parse(r.at)));
  const calls = [...lines(join(o.ledger, "spend.jsonl")).filter((r) => typeof r.usd === "number") as unknown as SpendRecord[], ...extra as unknown as SpendRecord[]];
  const attempts_usd = atts.reduce((s, a) => s + (a.spent?.usd ?? 0), 0);
  const calls_usd = calls.reduce((s, r) => s + r.usd, 0);
  const priced_usd = attempts_usd + calls_usd;
  const off = Number(env.RATCHET_SPEND_OFFSET_USD ?? 0);
  const offset_usd = Number.isFinite(off) ? off : 0;
  const override = readOverride(o.runsDir, o.run);
  let owner_read_usd: number | null = null;
  let warning: string | undefined;
  let ratio: number | null = null;
  if (override) {
    let t = Date.parse(override.at);
    if (t > override.written_ms) {
      t = override.written_ms;
      warning = `${SPEND_OVERRIDE_FILE} at ${override.at} is later than the file was written (${new Date(t).toISOString()}); read at the write time`;
    }
    const after = atts.filter((a) => a.run === o.run && Date.parse(a.spent_at ?? a.at) > t).reduce((s, a) => s + (a.spent?.usd ?? 0), 0)
      + calls.filter((r) => r.run === o.run && Date.parse(r.at) > t).reduce((s, r) => s + r.usd, 0);
    // every priced dollar up to the reading, any run or none: the owner's console total stands against it
    const otherAtts = (o.ratioLedgers ?? []).flatMap((l) => attempts(l));
    const otherCalls = (o.ratioLedgers ?? []).flatMap((l) => lines(join(l, "spend.jsonl")).filter((r) => typeof r.usd === "number") as unknown as SpendRecord[]);
    const before = [...atts, ...otherAtts].filter((a) => Date.parse(a.spent_at ?? a.at) <= t).reduce((s, a) => s + (a.spent?.usd ?? 0), 0)
      + [...calls, ...otherCalls].filter((r) => Date.parse(r.at) <= t).reduce((s, r) => s + r.usd, 0);
    ratio = ownerRatio(override.usd, before);
    owner_read_usd = override.usd - override.pre_run_usd + ratio * after;
  }
  const usd = owner_read_usd ?? priced_usd + offset_usd;
  return {
    priced_usd, attempts_usd, attempts_n: atts.length, calls_usd, calls_n: calls.length, offset_usd, owner_read_usd, ratio, override, usd,
    source: owner_read_usd !== null ? "owner-read" : offset_usd ? "priced+offset" : "priced", ask_usd: SPEND_ASK_USD, stop_usd: SPEND_STOP_USD,
    ...(warning ? { warning } : {}),
  };
}

/** One run's share of the one Meta account: its ledger, runs dir and id, with spendMeter's extra options. */
export type MeterPart = MeterOptions;
export type CombinedMeter = SpendMeter & { parts: (SpendMeter & { run: string | null })[] };

/**
 * Every run on the one Meta account summed: `usd`, `priced_usd`, `owner_read_usd` and the count fields are the parts'
 * sums; `ratio`, `override`, `offset_usd` and `warning` are the first part's (the guarding run's); `parts` holds each
 * part's meter. A part on a different ledger reads the other parts' ledgers into its ownerRatio (ratioLedgers), so a
 * run on a fresh ledger prices at the console ratio of the ledger the owner's reading stands against
 * (server/spend.test.ts "combined meter").
 */
export function combinedMeter(parts: MeterPart[]): CombinedMeter {
  if (!parts.length) throw new Error("combinedMeter: no parts");
  const ms = parts.map((p, i) => ({
    ...spendMeter({ ...p, ratioLedgers: [...(p.ratioLedgers ?? []), ...parts.filter((q, k) => k !== i && q.ledger !== p.ledger).map((q) => q.ledger)] }),
    run: p.run,
  }));
  const sum = (f: (m: SpendMeter) => number) => ms.reduce((s, m) => s + f(m), 0);
  const first = ms[0];
  return {
    ...first, priced_usd: sum((m) => m.priced_usd), attempts_usd: sum((m) => m.attempts_usd), attempts_n: sum((m) => m.attempts_n),
    calls_usd: sum((m) => m.calls_usd), calls_n: sum((m) => m.calls_n),
    owner_read_usd: ms.some((m) => m.owner_read_usd !== null) ? sum((m) => m.usd) : null, usd: sum((m) => m.usd),
    source: first.source, parts: ms,
  };
}

/** Parses "<ledger>,<runsDir>,<run>[,<extra jsonl>…]" (the campaign's and the watcher's --spend-also) into a MeterPart. */
export function parseMeterPart(s: string): MeterPart {
  const [ledger, runsDir, run, ...extraFiles] = s.split(",").map((x) => x.trim());
  if (!ledger || !runsDir || !run) throw new Error(`--spend-also ${s}: want <ledger>,<runsDir>,<run>[,<extra jsonl>…]`);
  return { ledger, runsDir, run, extraFiles };
}

export type SpendGate = "go" | "ask" | "stop";
/** What the guard does at `usd`: stop at SPEND_STOP_USD, ask at SPEND_ASK_USD, else go. */
export function spendGate(usd: number): SpendGate {
  return usd >= SPEND_STOP_USD ? "stop" : usd >= SPEND_ASK_USD ? "ask" : "go";
}

/** One meter line naming both figures (the campaign prints it; the History tab shows the same fields). */
export function meterLine(m: SpendMeter & { parts?: (SpendMeter & { run: string | null })[] }): string {
  if (m.parts && m.parts.length > 1) return `spend combined over ${m.parts.length} runs: guard reads $${m.usd.toFixed(2)} (ask $${m.ask_usd}, stop $${m.stop_usd}) = ${m.parts.map((p) => `${p.run} ${p.source} $${p.usd.toFixed(2)}`).join(" + ")}`;
  const owner = m.owner_read_usd === null ? "no runs/<run>/spend-override.json" : `$${m.owner_read_usd.toFixed(2)} (list rates × ${(m.ratio ?? 1).toFixed(3)} since reading)`;
  return `spend: ${OWNER_LABEL} ${owner} · ${PRICED_LABEL} $${m.priced_usd.toFixed(2)}${m.offset_usd ? ` (offset ${m.offset_usd})` : ""} · guard reads ${m.source} $${m.usd.toFixed(2)} (ask $${m.ask_usd}, stop $${m.stop_usd})${m.warning ? ` · warning: ${m.warning}` : ""}`;
}
