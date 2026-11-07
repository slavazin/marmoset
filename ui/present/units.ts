// Unit formatting for the History tab (S14). Decimal places are named here so the templates under ui/present/
// carry no numeric literal (ui/present/present.test.ts); the value printed is always the record's.

/** Places a dollar amount prints to: cents, the unit `Attempt.spent.usd` and ledger/spend.jsonl are priced in. */
export const USD_PLACES = 2;
/** Places a 0..1 ratio (precision, recall) prints to. */
export const RATIO_PLACES = 2;

/** Places the spend meter's owner ratio (server/spend.ts ownerRatio, about 0.055) prints to; meterLine prints the same. */
export const SPEND_RATIO_PLACES = 3;
/** The owner ratio; null (no override file) reads as list rates, 1. */
export const fmtSpendRatio = (r: number | null): string => (r ?? 1).toFixed(SPEND_RATIO_PLACES);

export const fmtUsd =(usd: number): string => `$${usd.toFixed(USD_PLACES)}`;
export const fmtRatio = (x: number | null | undefined): string => (typeof x === "number" ? x.toFixed(RATIO_PLACES) : "—");
/** An ISO timestamp as "YYYY-MM-DD HH:MM:SS" in UTC, as written in the record. */
export const fmtAt = (at: string | undefined): string => (at ? at.replace("T", " ").replace(/(\.\d+)?Z$/, "").replace(/[+-]\d\d:\d\d$/, "") : "—");
