// The How-it-works diagram (S14, Approach tab) as inline SVG: the fast loop across the top, the slow loop below it,
// and the V read at curve freeze. `stageFor(event)` maps one SSE UiEvent (SPEC §6.18) to the stage it shows, and
// `StageTracker` holds a loop stage for STAGE_HOLD_MS before play or lockstep events take the highlight back.
// `diagramSvg(lit)` draws the boxes with the lit stage marked. Every coordinate comes from ui/present/layout.ts;
// this template carries no numeric literal (ui/present/present.test.ts).

import type { UiEvent, Verdict } from "../../src/schema.ts";
import { esc, decidingCheck } from "../format.ts";
import {
  STAGE_GRID, STAGE_HOLD_MS, BOX_W_PX, BOX_H_PX, RX_PX, LABEL_DX_PX, LABEL_DY_PX, ORIGIN_PX, boxH, rowY, rowTalls, pairs, rowOf, last,
  colX, midX, rightX, half, titleY, subY, lineY, textX, viewW, viewH, gapAbove, arrowHead,
} from "./layout.ts";
import type { StageId } from "./layout.ts";

interface Stage { id: StageId; title: string; sub: string; lines?: string[] }

/** The gate's checks in the order it runs them (SPEC G4 and the S8 diff-scope check). */
export const GATE_CHECKS: Verdict["checks"][number]["name"][] = ["diff-scope", "repro", "admitted-traces", "base-suites", "H-no-regress"];
export const TRIAL_ARMS = ["candidate", "baseline", "placebo"] as const;

export const STAGES: Stage[] = [
  { id: "play", title: "Play", sub: "Gemini or explorer" },
  { id: "lockstep", title: "Lockstep", sub: "core vs SameBoy" },
  { id: "incident", title: "Incident", sub: "frames differ" },
  { id: "packet", title: "Repair packet", sub: "scratch repo, Muse" },
  { id: "gate", title: "Gate", sub: "checks, in order", lines: GATE_CHECKS },
  { id: "graduate", title: "GRADUATE", sub: "merged to core-live" },
  { id: "refuse", title: "REFUSE", sub: "branch left unmerged" },
  { id: "observation", title: "Observation", sub: "one per fast attempt" },
  { id: "consolidator", title: "Consolidator", sub: "Muse Wonder nominates" },
  { id: "trial", title: "Shadow trial", sub: "one commit, one budget", lines: [...TRIAL_ARMS] },
  { id: "skill", title: "Graduated skill", sub: "pentad + hook" },
  { id: "hook", title: "Hook fires", sub: "in later attempts" },
  { id: "tombstone", title: "Tombstone", sub: "refused, successor" },
  { id: "vread", title: "V read", sub: "once, at curve freeze" },
];

export interface Lit { stage: StageId | null; check?: string; pass?: boolean; label: string }

const LOOP_STAGES = new Set<StageId>(["play", "lockstep"]);

/** The stage one UiEvent shows, or null for an event no stage stands for. */
export function stageFor(e: UiEvent): Lit | null {
  switch (e.t) {
    case "frame": return { stage: e.source === "oracle" ? "lockstep" : "play", label: `${e.source} frame at counter ${e.counter}` };
    case "player": return { stage: "play", label: `player: ${e.intent}` };
    case "meta": return null;
    case "incident": return { stage: "incident", label: `${e.incident.id}${e.incident.source === "sabotage" ? " (sabotage, labelled)" : ""}` };
    case "attempt": return e.phase === "end"
      ? { stage: "gate", label: `${e.attempt.id} ended; the gate reads its core/** diff` }
      : { stage: "packet", label: `${e.attempt.id} ${e.phase} in its scratch repo` };
    case "verdict": {
      const v = e.verdict;
      const c = decidingCheck(v);
      if (v.subject.kind === "skill") return { stage: v.decision === "GRADUATE" ? "skill" : "tombstone", check: c?.name, pass: c?.pass, label: `${v.id} ${v.decision} skill ${v.subject.id}` };
      return { stage: v.decision === "GRADUATE" ? "graduate" : "refuse", check: c?.name, pass: c?.pass, label: `${v.id} ${v.decision} ${v.subject.id}, decided by ${c?.name ?? "—"}` };
    }
    case "curve": return { stage: "trial", label: `generation ${e.generation} trial arms` };
    case "fire": return { stage: "hook", label: `${e.fire.id}: ${e.fire.skill} fired in ${e.fire.attempt}` };
    case "core": return { stage: "graduate", label: `core bundle ${e.commit}` };
    case "vread": return { stage: "vread", label: `V read ${e.result.run}` };
  }
}

/** Holds the lit stage: a loop stage keeps the highlight for STAGE_HOLD_MS against play and lockstep events. */
export class StageTracker {
  lit: Lit = { stage: null, label: "no event received on /events" };
  private since = -Infinity;
  /** Applies one event at time `now` (ms); returns true when the lit stage changed. */
  push(e: UiEvent, now: number): boolean {
    const next = stageFor(e);
    if (!next) return false;
    const held = this.lit.stage && !LOOP_STAGES.has(this.lit.stage) && now - this.since < STAGE_HOLD_MS;
    if (next.stage && LOOP_STAGES.has(next.stage) && held) return false;
    const changed = next.stage !== this.lit.stage || next.check !== this.lit.check;
    this.lit = next;
    this.since = now;
    return changed || !LOOP_STAGES.has(next.stage!);
  }
}

function tallPerRow(): number[] {
  return rowTalls(STAGES.map((s) => { const [, row] = STAGE_GRID[s.id]; return { row, lines: s.lines?.length }; }));
}

/** A box's top, height and column; the graduate and refuse outcomes split their shared cell at the gate's height. */
function geom(s: Stage, tall: number[]): { x: number; y: number; h: number; col: number } {
  const [col, row] = STAGE_GRID[s.id];
  const top = rowY(row, tall);
  if (s.id === "graduate" || s.id === "refuse") {
    const h = half(boxH(tall[row]));
    return { x: colX(col), y: s.id === "graduate" ? top : top + h, h, col };
  }
  return { x: colX(col), y: top, h: boxH(s.lines?.length), col };
}

function box(s: Stage, lit: Lit, tall: number[]): string {
  const g = geom(s, tall);
  const on = lit.stage === s.id;
  const cls = ["stage", s.id, on ? "on" : ""].join(" ");
  const lines = (s.lines ?? []).map((l, i) => {
    const hit = (lit.stage === "graduate" || lit.stage === "refuse" || lit.stage === "skill" || lit.stage === "tombstone") && lit.check === l;
    return `<text class="line${hit ? (lit.pass ? " hit pass" : " hit fail") : ""}" x="${textX(g.col)}" y="${lineY(g.y, i)}">${esc(l)}</text>`;
  }).join("");
  return `<g class="${cls}" data-stage="${s.id}"><rect x="${g.x}" y="${g.y}" width="${BOX_W_PX}" height="${g.h}" rx="${RX_PX}"/>
<text class="title" x="${textX(g.col)}" y="${titleY(g.y)}">${esc(s.title)}</text><text class="sub" x="${textX(g.col)}" y="${subY(g.y)}">${esc(s.sub)}</text>${lines}</g>`;
}

const byId = (id: StageId) => STAGES.find((s) => s.id === id)!;

function arrows(tall: number[]): string {
  const g = (id: StageId) => geom(byId(id), tall);
  const out: string[] = [];
  const line = (pts: [number, number][], dir: "r" | "l" | "u" | "d", label?: string, lx?: number, ly?: number) => {
    const tip = last(pts);
    const [tx, ty] = tip;
    out.push(`<polyline class="arrow" points="${pts.map((p) => p.join(",")).join(" ")}"/><polygon class="head" points="${arrowHead(tx, ty, dir)}"/>`);
    if (label) out.push(`<text class="alabel" x="${lx}" y="${ly}">${esc(label)}</text>`);
  };
  const midY = (id: StageId) => { const b = g(id); return b.y + half(b.h); };
  for (const [a, b] of pairs<StageId>(["play", "lockstep", "incident", "packet", "gate"])) {
    const y = g(a).y + half(BOX_H_PX);
    line([[rightX(g(a).col), y], [colX(g(b).col), y]], "r");
  }
  for (const id of ["graduate", "refuse"] as StageId[]) line([[rightX(g("gate").col), midY(id)], [colX(g(id).col), midY(id)]], "r");
  const ref = g("refuse");
  line([[midX(ref.col), ref.y + ref.h], [midX(ref.col), g("observation").y]], "d", "fast loop writes", midX(ref.col) + LABEL_DX_PX, gapAbove(rowOf("observation"), tall));
  for (const [a, b] of pairs<StageId>(["observation", "consolidator", "trial", "skill", "hook"])) {
    const y = g(a).y + half(BOX_H_PX);
    line([[colX(g(a).col), y], [rightX(g(b).col), y]], "l");
  }
  const tr = g("trial");
  line([[midX(tr.col), tr.y + tr.h], [midX(tr.col), g("tombstone").y]], "d", "refused", midX(tr.col) + LABEL_DX_PX, gapAbove(rowOf("tombstone"), tall));
  const sk = g("skill");
  line([[midX(sk.col), sk.y + sk.h], [midX(sk.col), g("vread").y]], "d", "S* hashed", midX(sk.col) + LABEL_DX_PX, gapAbove(rowOf("vread"), tall));
  const hk = g("hook"), pk = g("packet");
  const elbow = gapAbove(rowOf("hook"), tall);
  line([[midX(hk.col), hk.y], [midX(hk.col), elbow], [midX(pk.col), elbow], [midX(pk.col), pk.y + pk.h]], "u", "owed act printed to the repairer", midX(hk.col) + LABEL_DX_PX, elbow - LABEL_DY_PX);
  return out.join("");
}

/** The diagram as one SVG string with `lit.stage` highlighted and, on a verdict, its deciding check marked. */
export function diagramSvg(lit: Lit): string {
  const tall = tallPerRow();
  return `<svg class="howit" viewBox="${[ORIGIN_PX, ORIGIN_PX, viewW(), viewH(tall)].join(" ")}" role="img" aria-label="How Ratchet works: fast loop, slow loop, V read">
${arrows(tall)}${STAGES.map((s) => box(s, lit, tall)).join("")}</svg>`;
}
