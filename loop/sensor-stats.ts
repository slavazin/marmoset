// Pure scoring math for the SubQ sensors (loop/route.ts routeCalibration). Offers:
//   auroc(rows)        the area under the ROC curve of `score` at ranking label-1 rows above label-0 rows, ties
//                      counted half (the Mann–Whitney form); null unless both labels occur;
//   brier(rows)        mean squared gap between probability and outcome; null on no rows;
//   reliability(rows)  RELIABILITY_BINS equal-width bins over [0, 1]: per bin n, mean predicted probability and
//                      observed rate (null on an empty bin); probability 1 falls in the last bin.
// Every figure carries its n. Tests: loop/sensors.test.ts ("AUROC, Brier and reliability on a fixture").

/** Bins of the reliability diagram: 10 equal-width bins over [0, 1] (the brief for S17b). */
export const RELIABILITY_BINS = 10;

export interface ScoredRow { score: number; label: 0 | 1 }
export interface ProbRow { p: number; y: 0 | 1 }
export interface ReliabilityBin { lo: number; hi: number; n: number; mean_p: number | null; rate: number | null }

/** See the file header. */
export function auroc(rows: ScoredRow[]): number | null {
  const pos = rows.filter((r) => r.label === 1), neg = rows.filter((r) => r.label === 0);
  if (!pos.length || !neg.length) return null;
  let s = 0;
  for (const a of pos) for (const b of neg) s += a.score > b.score ? 1 : a.score === b.score ? 0.5 : 0;
  return s / (pos.length * neg.length);
}

/** See the file header. */
export function brier(rows: ProbRow[]): number | null {
  return rows.length ? rows.reduce((s, r) => s + (r.p - r.y) ** 2, 0) / rows.length : null;
}

/** See the file header. */
export function reliability(rows: ProbRow[], bins = RELIABILITY_BINS): ReliabilityBin[] {
  const out = Array.from({ length: bins }, (_, i) => ({ lo: i / bins, hi: (i + 1) / bins, ps: [] as number[], ys: [] as number[] }));
  for (const r of rows) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor(r.p * bins)));
    out[i].ps.push(r.p); out[i].ys.push(r.y);
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return out.map((b) => ({ lo: b.lo, hi: b.hi, n: b.ps.length, mean_p: mean(b.ps), rate: mean(b.ys) }));
}
