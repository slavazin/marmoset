// The router row of an incident card (SPEC §4 N7): probability bars for `subsystem` and the top applies: skills, and
// the call meter (questions, calls, input tokens, usd, ms) loop/route.ts writes under ROUTE_META_KEY. Every figure is
// read from Incident.route in the ledger; no number shown here is a literal.

import type { Incident } from "../src/schema.ts";
import { esc } from "./format.ts";

/** How many applies: skills the row shows, highest probability first. */
export const TOP_APPLIES = 3;
/** Mirrors loop/route.ts ROUTE_META_KEY (the UI bundle does not import loop/, which reads node:fs). */
const META = "_call";

// The meter shape lives in ui/style.css under .rbar, .rfill and .rlab (S19); only the fill width, the reading, is inline.
const pct = (p: number) => p.toLocaleString("en", { style: "percent" });
const bar = (label: string, p: number) =>
  `<span class="rbar" title="${esc(label)} ${esc(pct(p))}"><span class="rfill" style="width:${esc(pct(p))}"></span><span class="rlab">${esc(label)} ${esc(pct(p))}</span></span>`;

export function routeBars(inc: Incident): string {
  const r = inc.route;
  if (!r) return "";
  const sub = Object.entries(r.subsystem ?? {}).sort((a, b) => b[1] - a[1]);
  const applies = Object.entries(r).filter(([k, v]) => k.startsWith("applies:") && typeof v.yes === "number")
    .map(([k, v]) => [k.slice("applies:".length), v.yes] as const).sort((a, b) => b[1] - a[1]).slice(0, TOP_APPLIES);
  const m = r[META];
  const meter = m ? `<span class="dim">SubQ · ${esc(m.questions)} q in ${esc(m.calls)} call · ${esc(m.images)} img · ${esc(m.n_input)} tok in · $${esc(m.usd)} · ${esc(m.ms)} ms</span>` : "";
  return `<div class="row route">${sub.map(([k, p]) => bar(k, p)).join("")}</div>${applies.length ? `<div class="row route">${applies.map(([k, p]) => bar(k, p)).join("")}</div>` : ""}<div class="row route">${meter}</div>`;
}
