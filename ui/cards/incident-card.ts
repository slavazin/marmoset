// Incident card template for the incident feed. Every figure is read from the incident record;
// this file carries no numeric literal (ui/cards.test.ts greps for one).

import type { Incident } from "../../src/schema.ts";
import { esc } from "../format.ts";
import { routeBars } from "../route-bars.ts";

export function incidentCard(inc: Incident, selected: boolean): string {
  const [x0, y0, x1, y1] = inc.signature.bbox;
  return `
<article class="card incident ${esc(inc.status)}${selected ? " selected" : ""}" data-incident="${esc(inc.id)}">
  <div class="row"><b>${esc(inc.id)}</b> <span class="tag">${esc(inc.source)}</span> <span class="tag">${esc(inc.kind)}</span> <span class="status">${esc(inc.status)}</span></div>
  <div class="row">counter ${esc(inc.counter)} · window ${esc(inc.window.join("…"))} · ${esc(inc.pixels)} px</div>
  <div class="row dim">scene ${esc(inc.signature.scene)} · band ${esc(inc.signature.band)} · bbox ${esc(`${x0},${y0}–${x1},${y1}`)}</div>
  ${inc.narration ? `<div class="row narr">${esc(inc.narration)}</div>` : ""}
  ${routeBars(inc)}
</article>`;
}
