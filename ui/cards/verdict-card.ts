// Verdict card template for the ratchet stack: stamp GRADUATED or REFUSED, the deciding check and its reading,
// and the attempt, commit and evidence path it cites (SPEC G9). Every figure is read from the verdict record;
// this file carries no numeric literal (ui/cards.test.ts greps for one).

import type { Verdict, Attempt, Incident } from "../../src/schema.ts";
import { esc, fmtReading, decidingCheck, shortSha } from "../format.ts";

export function verdictCard(v: Verdict, attempt: Attempt | undefined, incident: Incident | undefined): string {
  const stamp = v.decision === "GRADUATE" ? "GRADUATED" : "REFUSED";
  const cls = v.decision === "GRADUATE" ? "grad" : "refuse";
  const c = decidingCheck(v);
  const commit = attempt?.head_commit;
  return `
<article class="card verdict ${cls}" data-verdict="${esc(v.id)}" title="${esc(v.reason)}">
  <div class="stamp">${stamp}</div>
  <div class="subject">${esc(v.id)} · ${esc(v.subject.kind)} ${esc(v.subject.id)}</div>
  <div class="deciding"><b>${esc(c?.name ?? "—")}</b> ${esc(fmtReading(c?.reading))}</div>
  <div class="reason">${esc(v.reason)}</div>
  <div class="cite">${commit ? `<span title="${esc(commit)}">${esc(shortSha(commit))}</span>` : ""}${incident ? ` · ${esc(incident.files.dir)}` : ""}${v.run === null ? ` · <i>run: null</i>` : ""}</div>
</article>`;
}
