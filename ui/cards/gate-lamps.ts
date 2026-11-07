// The gate-sequence lamps beside the LCD (S19): one bank per subject kind, the repair gate's latest attempt verdict
// first and the shadow trial's latest skill verdict after it. A bank has one lamp per check, in the order the verdict
// lists them (loop/gate.ts runs them in that order), then an outcome lamp, merge for an attempt and graduate for a
// skill. Each lamp carries its position as --i so the CSS lights them in sequence when a verdict lands. Every name
// and reading is read from the verdict record; this file carries no numeric literal (ui/cards.test.ts greps for one).

import type { Verdict } from "../../src/schema.ts";
import { esc, fmtReading } from "../format.ts";

const lamp = (name: string, pass: boolean, i: number, title: string) =>
  `<li class="glamp ${pass ? "pass" : "fail"}" style="--i:${i}" title="${esc(title)}"><i></i><span>${esc(name)}</span></li>`;

/** The verdict a new ruling replaces on the lamps: the latest by `at`, the later-listed on a tie. */
export function latestVerdict(vs: Iterable<Verdict>): Verdict | undefined {
  let best: Verdict | undefined;
  for (const v of vs) if (!best || v.at >= best.at) best = v;
  return best;
}

/** The latest verdict of each subject kind, attempts (the repair gate) first, then skills (the shadow trial). */
export function latestByKind(vs: Verdict[]): Verdict[] {
  const rank = (k: string) => (k === "attempt" ? "" : k);
  const kinds = [...new Set(vs.map((v) => v.subject.kind))].sort((a, b) => rank(a).localeCompare(rank(b)));
  return kinds.map((k) => latestVerdict(vs.filter((v) => v.subject.kind === k))!);
}

/** One lamp bank per verdict given; none prints the empty state. */
export function gateBanks(vs: Verdict[]): string {
  if (!vs.length) return gateLamps(undefined);
  return vs.map((v) => `<div class="gbank">${gateLamps(v)}</div>`).join("");
}

export function gateLamps(v: Verdict | undefined): string {
  if (!v) return `<div class="dim">no verdict in ledger/verdicts.jsonl; the lamps light when the gate rules</div>`;
  const grad = v.decision === "GRADUATE";
  const outcome = v.subject.kind === "attempt" ? "merge" : "graduate";
  const lamps = v.checks.map((c, i) => lamp(c.name, c.pass, i, `${c.name}: ${fmtReading(c.reading)}`));
  lamps.push(lamp(outcome, grad, v.checks.length, `${v.decision} · ${v.reason}`));
  return `<div class="gsub"><b>${esc(v.id)}</b> · ${esc(v.subject.kind)} ${esc(v.subject.id)}</div>
<ol class="lamps ${grad ? "grad" : "refuse"}" data-gate="${esc(v.id)}">${lamps.join("")}</ol>
<div class="gstamp ${grad ? "grad" : "refuse"}" style="--i:${v.checks.length}">${grad ? "GRADUATED" : "REFUSED"}</div>`;
}
