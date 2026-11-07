// The History tab's router block (S17b): the reliability plot of the SubQ router's applies: probabilities against
// whether the skill fired, and the sensor figures, every one read from GET /api/history's `router`
// (loop/route.ts routeCalibrationOf over the ledger) with its n. An absent reading prints an empty state, never a
// zero. Geometry comes from ui/present/layout.ts; no numeric literal (ui/present/present.test.ts).

import type { History } from "../../server/history.ts";
import { esc } from "../format.ts";
import { fmtRatio } from "./units.ts";
import { REL_SIDE_PX, REL_DOT_PX, ORIGIN_PX, relX, relY, relBelow, relLeft, last } from "./layout.ts";

type Router = NonNullable<History["router"]>;
const empty = (what: string) => `<div class="dim empty">${esc(what)}</div>`;

/** The reliability plot as SVG: the diagonal of perfect calibration and one point per non-empty bin (mean predicted, observed rate). */
export function reliabilitySvg(r: Router): string {
  const bins = r.applies.reliability;
  if (!r.applies.n || !bins.length) return empty("No applies: probability has an outcome yet: no routed skill was shown in a later attempt.");
  const [first] = bins;
  const lo = first.lo, hi = last(bins).hi;
  const pts = bins.filter((b) => b.n && b.mean_p !== null && b.rate !== null).map((b) =>
    `<circle cx="${relX(b.mean_p!)}" cy="${relY(b.rate!)}" r="${REL_DOT_PX}" class="relpt"><title>${esc(fmtRatio(b.lo))}–${esc(fmtRatio(b.hi))}: n ${esc(b.n)}, mean predicted ${esc(fmtRatio(b.mean_p))}, observed ${esc(fmtRatio(b.rate))}</title></circle>`).join("");
  return `<svg class="reliability" viewBox="${ORIGIN_PX} ${ORIGIN_PX} ${REL_SIDE_PX} ${REL_SIDE_PX}" width="${REL_SIDE_PX}" height="${REL_SIDE_PX}" role="img" aria-label="reliability of applies: probabilities">
<rect x="${relX(lo)}" y="${relY(hi)}" width="${relX(hi) - relX(lo)}" height="${relY(lo) - relY(hi)}" class="relframe"/>
<line x1="${relX(lo)}" y1="${relY(lo)}" x2="${relX(hi)}" y2="${relY(hi)}" class="reldiag"/>
${pts}
<text x="${relX(lo)}" y="${relBelow()}" class="rellab">${esc(fmtRatio(lo))}</text><text x="${relX(hi)}" y="${relBelow()}" class="rellab" text-anchor="end">${esc(fmtRatio(hi))} predicted</text>
<text x="${relLeft()}" y="${relY(hi)}" class="rellab">${esc(fmtRatio(hi))}</text><text x="${relLeft()}" y="${relY(lo)}" class="rellab">observed</text>
</svg>`;
}

const rate = (label: string, s: { n: number; hits: number; rate: number | null }) => (s.n ? ` · ${esc(label)} <b>${esc(s.hits)}</b> of ${esc(s.n)}` : "");

/** The router block: plot, then the figures that have rows. */
export function routerBlock(h: History): string {
  const r = h.router;
  if (!r) return empty("No SubQ route or forecast in ledger/: no incident carries a route and no attempt a forecast.");
  const steered = r.subsystem.steered ? ` · <b>${esc(r.subsystem.steered)}</b> route(s) unscored: repaired under a policy` : "";
  const sub = (r.subsystem.n ? ` · subsystem n <b>${esc(r.subsystem.n)}</b>, wrong <b>${esc(r.subsystem.wrong)}</b>, accuracy <b>${esc(fmtRatio(r.subsystem.accuracy))}</b> against a uniform pick's <b>${esc(fmtRatio(r.subsystem.chance))}</b> (truth is per core file), AUROC of uncertainty <b>${esc(fmtRatio(r.subsystem.auroc_uncertainty))}</b>, of p(other) <b>${esc(fmtRatio(r.subsystem.auroc_other))}</b>` : "") + steered;
  const app = r.applies.n ? ` · applies: n <b>${esc(r.applies.n)}</b>, Brier <b>${esc(fmtRatio(r.applies.brier))}</b>` : "";
  const fp = r.forecast_pass.n ? ` · pass forecast n <b>${esc(r.forecast_pass.n)}</b>, Brier <b>${esc(fmtRatio(r.forecast_pass.brier))}</b>, AUROC <b>${esc(fmtRatio(r.forecast_pass.auroc))}</b>` : "";
  const twin = r.twin.n ? `${rate("twin agrees", r.twin)}, mean |Δp| <b>${esc(fmtRatio(r.twin.mean_dp))}</b>` : "";
  return `${reliabilitySvg(r)}
<div>routes <b>${esc(r.routed)}</b>${rate("abstained", r.abstention)}${rate("decoy rejected", r.decoy)}${twin}${sub}${app}${fp}${rate("mechanism forecast agrees with H-no-regress", r.forecast_mechanism)}</div>
<div class="dim">routeCalibrationOf over ledger/ (loop/route.ts). The router nominates; the gate decides (D-0004).</div>`;
}
