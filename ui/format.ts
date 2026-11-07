// Formatting for readings and ledger records. Every figure it prints comes from the record passed in;
// the card templates under ui/cards/ call these and carry no numeric literal (ui/cards.test.ts).

import type { Verdict, SuiteReading, Attempt, Incident } from "../src/schema.ts";

export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function isSuiteReading(x: unknown): x is SuiteReading {
  if (typeof x !== "object" || x === null) return false;
  const r = x as SuiteReading;
  return typeof r.family === "string" && typeof r.split === "string" && typeof r.pass === "number" && typeof r.roms === "number";
}

/** Pixel match 0..1 as written in the reading, to three places, with its unit. */
export function fmtPixelMatch(v: number): string {
  return `${v.toFixed(3)} mean pixel match`;
}

export function fmtSuiteReading(r: SuiteReading): string {
  return `${r.split}/${r.family}: ${r.pass}/${r.roms} pass, ${r.exact} exact, ${fmtPixelMatch(r.pixel_match)}`;
}

/** One reading (a check's `reading: unknown`) as text. */
export function fmtReading(x: unknown): string {
  if (x === null || x === undefined) return "—";
  if (typeof x === "string") return x;
  if (typeof x === "number" || typeof x === "boolean") return String(x);
  if (Array.isArray(x)) return x.map(fmtReading).join("; ");
  if (isSuiteReading(x)) return fmtSuiteReading(x);
  if (typeof x === "object") return Object.entries(x as Record<string, unknown>).map(([k, v]) => `${k}: ${fmtReading(v)}`).join(", ");
  return JSON.stringify(x);
}

/** The check that decided a verdict: a REFUSE's first failing check, else the verdict's final check. */
export function decidingCheck(v: Verdict): Verdict["checks"][number] | undefined {
  if (v.decision === "REFUSE") return v.checks.find((c) => !c.pass) ?? v.checks.at(-1);
  return v.checks.at(-1);
}

/** Every SuiteReading a verdict's checks and arms carry, in record order. */
export function suiteReadings(v: Verdict): SuiteReading[] {
  const out: SuiteReading[] = [];
  const walk = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (isSuiteReading(x)) out.push(x);
  };
  for (const c of v.checks) walk(c.reading);
  return out;
}

/** The incident an attempt verdict traces to, through its attempt record. */
export function verdictIncident(v: Verdict, attempts: Map<string, Attempt>, incidents: Map<string, Incident>): Incident | undefined {
  if (v.subject.kind !== "attempt") return undefined;
  const id = attempts.get(v.subject.id)?.task.incident;
  return id ? incidents.get(id) : undefined;
}

/** Short form of a commit sha for display; the full sha stays in the card's title attribute. */
export const SHORT_SHA = 7;
export function shortSha(s: string | undefined): string {
  return s ? s.slice(0, SHORT_SHA) : "—";
}

/** Evidence URL for a file in an incident's evidence dir (`files.dir` is repo-relative, under evidence/). */
export function evidenceUrl(inc: Incident, file: string): string {
  return "/" + inc.files.dir.replace(/^\/+/, "").replace(/\/+$/, "") + "/" + file;
}
