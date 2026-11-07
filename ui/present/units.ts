// Unit formatting for the History tab (S14). Decimal places are named here so the templates under ui/present/
// carry no numeric literal (ui/present/present.test.ts); the value printed is always the record's.

/** Places a dollar amount prints to: cents, the unit `Attempt.spent.usd` and ledger/spend.jsonl are priced in. */
export const USD_PLACES = 2;
/** Places a 0..1 ratio (precision, recall) prints to. */
export const RATIO_PLACES = 2;

export const fmtUsd = (usd: number): string => `$${usd.toFixed(USD_PLACES)}`;
export const fmtRatio = (x: number | null | undefined): string => (typeof x === "number" ? x.toFixed(RATIO_PLACES) : "—");
/** An ISO timestamp as "YYYY-MM-DD HH:MM:SS" in UTC, as written in the record. */
export const fmtAt = (at: string | undefined): string => (at ? at.replace("T", " ").replace(/(\.\d+)?Z$/, "").replace(/[+-]\d\d:\d\d$/, "") : "—");
