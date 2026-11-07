// Panels that serve the LCD: metadata (PC, opcode, LY, PPU mode, STAT LEDs, IE/IF, provenance), the per-frame
// handler heatmap, the generation curve, and the Mooneye LEDs. Every figure is read from the core or the ledger.

import type { ProvenanceEntry, SuiteReading, UiEvent, Verdict, VRead } from "../src/schema.ts";
import { esc, fmtPixelMatch, suiteReadings } from "./format.ts";

const hex = (v: number, w: number) => "$" + (v >>> 0).toString(16).toUpperCase().padStart(w, "0");
/** STAT bits 6..3 named as the hardware names them; bits 2 and 1..0 are the LY=LYC flag and the mode. */
const STAT_BITS = [["LYC int", 6], ["OAM int", 5], ["VBL int", 4], ["HBL int", 3], ["LY=LYC", 2]] as const;
const IRQ_BITS = ["VBL", "STAT", "TIMER", "SERIAL", "JOYP"];
const MODE_NAMES = ["HBLANK", "VBLANK", "OAM", "DRAW"];

export interface Meta { pc: number; op: string; ly: number; mode: number; stat: number; ie: number; if_: number; hits: Record<string, number> }

function led(on: boolean, label: string, cls = ""): string {
  return `<span class="led ${on ? "on" : ""} ${cls}" title="${esc(label)}"><i></i>${esc(label)}</span>`;
}

/** Provenance lines for the handlers this frame ran, hottest first: "this frame ran h (file), last changed by ATT under SKL". */
export function provenanceLines(hits: Record<string, number>, prov: ProvenanceEntry[]): string[] {
  const byHandler = new Map(prov.map((p) => [p.handler, p]));
  return Object.entries(hits).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1])
    .flatMap(([h]) => {
      const p = byHandler.get(h);
      if (!p) return [];
      const by = p.attempt ? `last changed by ${p.attempt}${p.skill ? ` under ${p.skill}` : ""}` : `last changed at ${p.commit}`;
      return [`this frame ran <code>${esc(h)}</code> (<code>${esc(p.file)}</code>), ${esc(by)}`];
    });
}

export function renderMeta(el: HTMLElement, m: Meta, prov: ProvenanceEntry[]): void {
  const mode = m.mode & 3;
  const lines = provenanceLines(m.hits, prov);
  el.innerHTML = `
  <div class="kv"><span>PC</span><code>${hex(m.pc, 4)}</code><code class="op">${esc(m.op)}</code></div>
  <div class="kv"><span>LY</span><code>${m.ly}</code><span>mode</span><code>${mode} ${MODE_NAMES[mode]}</code></div>
  <div class="leds">${MODE_NAMES.map((n, i) => led(i === mode, n, "mode")).join("")}</div>
  <div class="kv"><span>STAT</span><code>${hex(m.stat & 0xff, 2)}</code></div>
  <div class="leds">${STAT_BITS.map(([n, b]) => led(((m.stat >> b) & 1) === 1, n)).join("")}</div>
  <div class="kv"><span>IE</span><code>${hex(m.ie & 0xff, 2)}</code><span>IF</span><code>${hex(m.if_ & 0xff, 2)}</code></div>
  <div class="leds irq">${IRQ_BITS.map((n, b) => led(((m.ie >> b) & 1) === 1, "IE " + n)).join("")}</div>
  <div class="leds irq">${IRQ_BITS.map((n, b) => led(((m.if_ >> b) & 1) === 1, "IF " + n, "if")).join("")}</div>
  <div class="prov">${lines.length ? lines.map((l) => `<div>${l}</div>`).join("") : `<div class="dim">no provenance entry for the handlers this frame ran (ledger/provenance.json)</div>`}</div>`;
}

/** Handler × frame heatmap: one row per handler, one column per frame, brightness log-scaled to the column's hits. */
export class Heatmap {
  private ctx: CanvasRenderingContext2D;
  private rows: string[];
  readonly canvas: HTMLCanvasElement;
  constructor(canvas: HTMLCanvasElement, labels: HTMLElement, handlers: string[]) {
    this.canvas = canvas;
    this.rows = handlers;
    canvas.height = handlers.length;
    this.ctx = canvas.getContext("2d")!;
    labels.innerHTML = handlers.map((h) => `<div>${esc(h)}</div>`).join("");
  }
  push(hits: Record<string, number>): void {
    const { width, height } = this.canvas;
    this.ctx.drawImage(this.canvas, -1, 0);
    const max = Math.max(1, ...Object.values(hits));
    for (let r = 0; r < height; r++) {
      const n = hits[this.rows[r]] ?? 0;
      const t = n > 0 ? Math.log1p(n) / Math.log1p(max) : 0;
      this.ctx.fillStyle = n > 0 ? `rgba(155,188,15,${0.15 + 0.85 * t})` : "#0b1a0b";
      this.ctx.fillRect(width - 1, r, 1, 1);
    }
  }
}

const meanPm = (rs: SuiteReading[]) => (rs.length ? rs.reduce((s, r) => s + r.pixel_match, 0) / rs.length : NaN);

/** Generation curve: mean pixel match of each trial arm per generation, from §6.18 curve events. */
export function renderCurve(el: HTMLElement, curve: Extract<UiEvent, { t: "curve" }>[]): void {
  if (!curve.length) { el.innerHTML = `<div class="dim">no trial generation in ledger/verdicts.jsonl</div>`; return; }
  const arms = ["candidate", "baseline", "placebo"] as const;
  const pts = curve.map((c) => arms.map((a) => meanPm(c.arms?.[a] ?? [])));
  const vals = pts.flat().filter((v) => !Number.isNaN(v));
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1;
  const W = 240, H = 72, pad = 6;
  const X = (i: number) => pad + (curve.length === 1 ? (W - 2 * pad) / 2 : (i * (W - 2 * pad)) / (curve.length - 1));
  const Y = (v: number) => H - pad - ((v - lo) / span) * (H - 2 * pad);
  const lines = arms.map((a, k) => {
    const d = pts.map((p, i) => (Number.isNaN(p[k]) ? "" : `${X(i)},${Y(p[k])}`)).filter(Boolean).join(" ");
    const dots = pts.map((p, i) => (Number.isNaN(p[k]) ? "" : `<circle cx="${X(i)}" cy="${Y(p[k])}" r="2.5"/>`)).join("");
    return `<g class="arm ${a}"><polyline points="${d}"/>${dots}</g>`;
  }).join("");
  const last = curve.at(-1)!;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" class="curve">${lines}</svg>
  <div class="legend">${arms.map((a, k) => `<span class="arm ${a}">${a} ${Number.isNaN(pts.at(-1)![k]) ? "—" : fmtPixelMatch(pts.at(-1)![k])}</span>`).join("")}
  <span class="dim">generation ${last.generation} · n ${last.arms?.n_family_runs_per_arm ?? "—"} family-runs/arm</span></div>`;
}

/** Latest SuiteReading per split/family for Mooneye families, from verdict readings; V only from the V read. */
export function mooneyeReadings(verdicts: Verdict[], vread: VRead | null): SuiteReading[] {
  const latest = new Map<string, SuiteReading>();
  for (const v of verdicts) for (const r of suiteReadings(v)) {
    if (!r.family.startsWith("mooneye") || r.split === "V" || r.split === "base") continue;
    latest.set(`${r.split}/${r.family}`, r);
  }
  if (vread) for (const r of vread.arms.ratchet) if (r.family.startsWith("mooneye")) latest.set(`V/${r.family}`, { ...r, split: "V" });
  return [...latest.values()].sort((a, b) => (a.split + a.family).localeCompare(b.split + b.family));
}

export function renderMooneye(el: HTMLElement, rs: SuiteReading[], vread: VRead | null): void {
  const rows = rs.map((r) => `<div class="mrow"><span class="fam">${esc(r.split)} ${esc(r.family)}</span>
    <span class="leds">${Array.from({ length: r.roms }, (_, i) => `<span class="led ${i < r.pass ? "on" : "off"}"><i></i></span>`).join("")}</span>
    <span class="dim">${r.pass}/${r.roms}</span></div>`).join("");
  el.innerHTML = (rows || `<div class="dim">no Mooneye reading in ledger/verdicts.jsonl</div>`)
    + (vread ? "" : `<div class="mrow sealed"><span class="fam">V</span><span class="dim">sealed until the V read (runs/RUN-*/vread.json)</span></div>`);
}
