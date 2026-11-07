// The one screen (SPEC §5 S6): the core's LCD at the centre, played from the keyboard with inputs posted to the
// live trace; the oracle frame and a red diff beside it during an incident; the metadata panel on the right;
// the incident feed, ratchet stack, generation curve and Mooneye LEDs below. Ledger data arrives over SSE (§6.18).
// S19 frames these in a cabinet: the latest verdict's checks light as gate lamps beside the scope, and a new
// incident or verdict pulses the cabinet (ui/fx.ts).

import type { Attempt, Core, Incident, ProvenanceEntry, UiEvent, Verdict, VRead } from "../src/schema.ts";
import { GAME_RAM } from "../src/schema.ts";
import { loadCore } from "./core-seam.ts";
import type { CoreModule } from "./core-seam.ts";
import { Lcd, LCD_W, LCD_H, decodeShades, greyToShades } from "./lcd.ts";
import { disasm } from "./disasm.ts";
import { renderMeta, Heatmap, renderCurve, renderMooneye, mooneyeReadings } from "./panels.ts";
import { verdictCard } from "./cards/verdict-card.ts";
import { incidentCard } from "./cards/incident-card.ts";
import { gateBanks, latestByKind } from "./cards/gate-lamps.ts";
import { pulse, mountGridToggle, mountLookToggle } from "./fx.ts";
import { esc, fmtReading, evidenceUrl, verdictIncident } from "./format.ts";
import { detectReplay, startReplay } from "./replay.ts";
import { mountTelemetryLed } from "./telemetry-led.ts";
import "./present/mount.ts";

/** DMG CPU clock (Hz) and T-cycles per frame; the frame period the live loop paces to is their ratio (~16.74 ms). */
const CPU_HZ = 4_194_304;
const FRAME_CYCLES = 154 * 456;
const FRAME_MS = (FRAME_CYCLES / CPU_HZ) * 1000;
/** Most emulated frames run per animation frame; caps catch-up after a stalled tab. */
const MAX_CATCHUP = 3;
/** Metadata panel refreshes per second; the heatmap takes every frame. */
const META_HZ = 10;
/** Core frames and meta snapshots per second the page posts to /api/event so the server records them (TELEMETRY_FRAME_HZ, src/telemetry.ts). */
const RECORD_HZ = 1;
/** Keyboard → joypad bit (§6.1 setButtons: bit0 right, 1 left, 2 up, 3 down, 4 A, 5 B, 6 select, 7 start). */
const KEYMAP: Record<string, number> = {
  ArrowRight: 0, ArrowLeft: 1, ArrowUp: 2, ArrowDown: 3, KeyZ: 4, KeyX: 5, Backspace: 6, ShiftRight: 6, Enter: 7,
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);

// ---------- state ----------
const incidents = new Map<string, Incident>();
const attempts = new Map<string, Attempt>();
const verdicts = new Map<string, Verdict>();
const curve: Extract<UiEvent, { t: "curve" }>[] = [];
let provenance: ProvenanceEntry[] = [];
let vread: VRead | null = null;
let selectedIncident: string | null = null;
let liveOracle: Uint8Array | null = null;
/** The verdict the gate lamps show; they re-render, and so replay their sequence, only when it changes. */
let gateShown: string | null = null;

let replay: ReturnType<typeof startReplay> | null = null;
let mod: CoreModule;
let core: Core;
let rom: Uint8Array = new Uint8Array(0);
let mask = 0;

const lcd = new Lcd($("lcd"));
const oracleLcd = new Lcd($("oracle"));
let heatmap: Heatmap;

// ---------- ROM and core ----------
async function sha256(b: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", b as BufferSource);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function boot(romBytes: Uint8Array, label: string): Promise<void> {
  rom = romBytes;
  core = mod.createCore(rom);
  core.setButtons(mask);
  const sha = await sha256(rom);
  $("romlabel").textContent = `${label} · sha256 ${sha.slice(0, 12)}`;
  post("/api/trace/reset", { rom_sha: sha });
}

async function loadRomUrl(url: string): Promise<void> {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(String(r.status));
    await boot(new Uint8Array(await r.arrayBuffer()), url);
  } catch {
    await boot(new Uint8Array(0), `${url} not found; empty ROM`);
  }
}

function post(path: string, body: unknown): void {
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
}

function counter(): number {
  return core.read(GAME_RAM.counter) | (core.read(GAME_RAM.counter + 1) << 8);
}

function setMask(next: number): void {
  if (next === mask || replay) return;
  mask = next;
  core.setButtons(mask);
  post("/api/input", { counter: counter(), mask });
  $("mask").textContent = mask.toString(2).padStart(8, "0");
}

addEventListener("keydown", (e) => {
  const b = KEYMAP[e.code];
  if (b === undefined || (e.target as HTMLElement)?.tagName === "INPUT") return;
  e.preventDefault();
  setMask(mask | (1 << b));
});
addEventListener("keyup", (e) => {
  const b = KEYMAP[e.code];
  if (b === undefined) return;
  e.preventDefault();
  setMask(mask & ~(1 << b));
});
addEventListener("blur", () => setMask(0));

// ---------- live loop and pacing ----------
/** Frame pacing readings, measured in the page: emulated frames per second and per-frame runFrame cost. */
const pacing = { fps: 0, frameCostMs: 0, intervalMeanMs: 0, intervalP99Ms: 0, frames: 0 };
(window as unknown as { __ratchetPacing: typeof pacing }).__ratchetPacing = pacing;
const stamps: number[] = [];
const costs: number[] = [];
let acc = 0;
let lastT = 0;
let lastMeta = 0;

let lastRecord = 0;
function tick(t: number): void {
  if (replay) return; // replay draws recorded frames (ui/replay.ts)
  if (lastT) acc += t - lastT;
  lastT = t;
  let n = 0;
  while (acc >= FRAME_MS && n < MAX_CATCHUP) {
    const t0 = performance.now();
    core.runFrame();
    costs.push(performance.now() - t0);
    stamps.push(t0);
    heatmap.push(lastHits = core.tap.handlerHits());
    acc -= FRAME_MS; n++; pacing.frames++;
  }
  if (n === MAX_CATCHUP) acc = 0;
  if (n) lcd.draw(core.frame());
  const cutoff = t - 1000;
  while (stamps.length && stamps[0] < cutoff) { stamps.shift(); costs.shift(); }
  if (t - lastMeta > 1000 / META_HZ) {
    lastMeta = t;
    const iv = stamps.slice(1).map((s, i) => s - stamps[i]).sort((a, b) => a - b);
    pacing.fps = stamps.length;
    pacing.frameCostMs = costs.reduce((s, c) => s + c, 0) / Math.max(1, costs.length);
    pacing.intervalMeanMs = iv.reduce((s, c) => s + c, 0) / Math.max(1, iv.length);
    pacing.intervalP99Ms = iv[Math.floor(iv.length * 0.99)] ?? 0;
    $("fps").textContent = `${pacing.fps} fps · runFrame ${pacing.frameCostMs.toFixed(2)} ms`;
    const p = core.tap.ppu();
    const m = {
      pc: core.cpu.pc, op: disasm((a) => core.read(a), core.cpu.pc).text, ly: p.ly, mode: p.mode, stat: p.stat,
      ie: core.read(0xffff), if_: core.read(0xff0f), hits: lastHits,
    };
    renderMeta($("meta"), m, provenance);
    if (t - lastRecord > 1000 / RECORD_HZ) {
      lastRecord = t;
      const fb = core.frame();
      let bin = ""; for (let i = 0; i < fb.length; i++) bin += String.fromCharCode(fb[i]);
      post("/api/event", { t: "frame", source: "core", shades_b64: btoa(bin), counter: counter() });
      post("/api/event", { t: "meta", ...m, provenance: [] });
    }
  }
  requestAnimationFrame(tick);
}
let lastHits: Record<string, number> = {};

// ---------- incident view: oracle beside the LCD, red diff overlay ----------
async function imageShades(url: string): Promise<Uint8Array | null> {
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = LCD_W; c.height = LCD_H;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    return greyToShades(g.getImageData(0, 0, LCD_W, LCD_H).data);
  } catch { return null; }
}

function drawDiff(a: Uint8Array, b: Uint8Array): number {
  const c = $<HTMLCanvasElement>("diff");
  c.width = LCD_W; c.height = LCD_H;
  const g = c.getContext("2d")!;
  const img = g.createImageData(LCD_W, LCD_H);
  let n = 0;
  for (let i = 0; i < LCD_W * LCD_H; i++) {
    if (a[i] === b[i]) continue;
    n++;
    img.data[i * 4] = 255; img.data[i * 4 + 3] = 220;
  }
  g.putImageData(img, 0, 0);
  return n;
}

/** Shows an incident's evidence beside the LCD; an automatic pick with missing evidence keeps the prior view. */
async function showIncident(id: string | null, auto = false): Promise<void> {
  const prior = selectedIncident;
  selectedIncident = id;
  const side = $("side");
  const inc = id ? incidents.get(id) : undefined;
  if (!inc) { side.hidden = !liveOracle; renderFeed(); return; }
  side.hidden = false;
  const [coreS, oracleS] = await Promise.all([imageShades(evidenceUrl(inc, "core.png")), imageShades(evidenceUrl(inc, "oracle.png"))]);
  const cap = $("sidecap");
  if ((!coreS || !oracleS) && auto && prior) { selectedIncident = prior; renderFeed(); return; }
  if (!coreS || !oracleS) { cap.textContent = `${inc.id}: evidence missing at ${inc.files.dir}`; renderFeed(); return; }
  $<HTMLCanvasElement>("evcore").hidden = false;
  new Lcd($("evcore")).draw(coreS);
  oracleLcd.draw(oracleS);
  const n = drawDiff(coreS, oracleS);
  cap.innerHTML = `<b>${esc(inc.id)}</b> replayed from <code>${esc(inc.files.dir)}</code> · counter ${esc(inc.counter)} · ${n} px differ`;
  renderFeed();
}

function onOracleFrame(shades: Uint8Array, ctr: number): void {
  liveOracle = shades;
  if (selectedIncident) return;
  $("side").hidden = false;
  $<HTMLCanvasElement>("evcore").hidden = true;
  oracleLcd.draw(shades);
  const n = drawDiff(core.frame(), shades);
  $("sidecap").textContent = `oracle at counter ${ctr} · ${n} px differ from the live core`;
}

// ---------- feed, stack, curve, LEDs ----------
let renderQueued = false;
function queueRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderFeed(); renderStack(); renderCurve($("curve"), curve); renderMooneye($("mooneye"), mooneyeReadings([...verdicts.values()], vread), vread); renderVRead(); renderGate(); });
}

function renderFeed(): void {
  const list = [...incidents.values()].reverse();
  $("feed").innerHTML = list.map((i) => incidentCard(i, i.id === selectedIncident)).join("") || `<div class="dim">no incident in ledger/incidents.jsonl</div>`;
}

function renderStack(): void {
  const list = [...verdicts.values()].reverse();
  $("stack").innerHTML = list.map((v) => {
    const a = v.subject.kind === "attempt" ? attempts.get(v.subject.id) : undefined;
    return verdictCard(v, a, verdictIncident(v, attempts, incidents));
  }).join("") || `<div class="dim">no verdict in ledger/verdicts.jsonl</div>`;
}

function renderGate(): void {
  const vs = latestByKind([...verdicts.values()]);
  const key = vs.map((v) => v.id).join(" ");
  if (key === gateShown) return;
  gateShown = key;
  $("gatelamps").innerHTML = gateBanks(vs);
}

function renderVRead(): void {
  const el = $("vread");
  if (!vread) { el.hidden = true; return; }
  el.hidden = false;
  const rows = (arm: "baseline" | "ratchet") => vread!.arms[arm].map((r) => `<div>${esc(arm)} · ${esc(fmtReading(r))}</div>`).join("");
  el.innerHTML = `<h3>V read · ${esc(vread.run)} · n ${esc(vread.n_family_runs_per_arm)} family-runs/arm</h3>${rows("baseline")}${rows("ratchet")}<div class="dim">residue: ${esc(vread.residue.join(", "))}</div>`;
}

function openEvidence(v: Verdict): void {
  const inc = verdictIncident(v, attempts, incidents);
  const a = v.subject.kind === "attempt" ? attempts.get(v.subject.id) : undefined;
  const imgs = inc ? ["core.png", "oracle.png", "diff.png"].map((f) => `<figure><img src="${esc(evidenceUrl(inc, f))}"><figcaption>${esc(f)}</figcaption></figure>`).join("") : "";
  $("modalbody").innerHTML = `
    <h2>${esc(v.id)} · ${esc(v.decision)} · ${esc(v.subject.kind)} ${esc(v.subject.id)}</h2>
    <p>${esc(v.reason)}</p>
    <table>${v.checks.map((c) => `<tr class="${c.pass ? "pass" : "fail"}"><td>${c.pass ? "pass" : "FAIL"}</td><td>${esc(c.name)}</td><td>${esc(fmtReading(c.reading))}</td></tr>`).join("")}</table>
    ${v.arms ? `<p>arms (n ${esc(v.arms.n_family_runs_per_arm)} family-runs/arm): margin ${esc(fmtReading(v.arms.margin))}</p>` : ""}
    <p class="dim">attempt ${esc(a?.id ?? "—")} · commit ${esc(a?.head_commit ?? "—")} · branch ${esc(a?.branch ?? "—")} · rule_version ${esc(v.rule_version)} · residue ${esc(v.residue.join(", "))}</p>
    ${inc ? `<p>evidence: <code>${esc(inc.files.dir)}</code> (${esc(inc.id)})</p><div class="figs">${imgs}</div>` : ""}
    <details><summary>record</summary><pre>${esc(JSON.stringify(v, null, 2))}</pre></details>`;
  $<HTMLDialogElement>("modal").showModal();
}

$("stack").addEventListener("click", (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>("[data-verdict]")?.dataset.verdict;
  const v = id ? verdicts.get(id) : undefined;
  if (v) openEvidence(v);
});
$("feed").addEventListener("click", (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>("[data-incident]")?.dataset.incident;
  if (id) showIncident(id === selectedIncident ? null : id);
});
$("modalclose").addEventListener("click", () => $<HTMLDialogElement>("modal").close());
$<HTMLInputElement>("rompick").addEventListener("change", async (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) await boot(new Uint8Array(await f.arrayBuffer()), f.name);
});

// ---------- SSE ----------
async function onEvent(e: UiEvent): Promise<void> {
  switch (e.t) {
    case "incident": {
      const isNew = !incidents.has(e.incident.id);
      incidents.set(e.incident.id, e.incident);
      if (isNew) { showIncident(e.incident.id, true); pulse($("cabinet"), "ping"); pulse($("logmod"), "ping"); }
      break;
    }
    case "attempt": attempts.set(e.attempt.id, e.attempt); break;
    case "verdict": {
      const isNew = !verdicts.has(e.verdict.id);
      verdicts.set(e.verdict.id, e.verdict);
      if (isNew) pulse($("cabinet"), e.verdict.decision === "GRADUATE" ? "flash-grad" : "flash-refuse", ["flash-grad", "flash-refuse"]);
      break;
    }
    case "curve": curve[e.generation - 1] = e; break;
    case "vread": vread = e.result; break;
    case "meta":
      provenance = e.provenance.length ? e.provenance : provenance;
      if (replay) { lastHits = e.hits; heatmap.push(e.hits); renderMeta($("meta"), e, provenance); }
      break;
    case "frame":
      if (e.source === "oracle") onOracleFrame(decodeShades(e.shades_b64), e.counter);
      else if (replay) replay.onCoreFrame(decodeShades(e.shades_b64), e.counter);
      break;
    case "player": $("player").textContent = `${e.intent} · ${e.mask.toString(2).padStart(8, "0")}`; break;
    case "core": {
      const next = await loadCore(e.bundle_url);
      mod = next.mod; core = mod.createCore(rom); core.setButtons(mask);
      $("corelabel").textContent = `${next.label} @ ${e.commit}`;
      break;
    }
    case "fire": break;
  }
  queueRender();
}

function connect(): void {
  const es = new EventSource("/events");
  es.onopen = () => { $("conn").className = "led on"; };
  es.onerror = () => { $("conn").className = "led"; };
  es.onmessage = (m) => { try { onEvent(JSON.parse(m.data) as UiEvent); } catch { /* malformed event enters no view */ } };
  es.addEventListener("replay", (m) => { try { replay?.onStatus(JSON.parse((m as MessageEvent).data)); } catch { /* ignored */ } });
  es.addEventListener("telemetry", (m) => { try { replay?.onTelemetry(JSON.parse((m as MessageEvent).data)); } catch { /* ignored */ } });
}

/** Clears every ledger-derived view; a replay seek rebuilds them from the events that follow. */
function resetViews(): void {
  incidents.clear(); attempts.clear(); verdicts.clear(); curve.length = 0; vread = null; selectedIncident = null; liveOracle = null; gateShown = null;
  $("side").hidden = true;
  queueRender();
}

async function refreshProvenance(): Promise<void> {
  try { provenance = ((await (await fetch("/api/state")).json()) as { provenance: ProvenanceEntry[] }).provenance; } catch { /* server down */ }
}

// ---------- start ----------
(async () => {
  const loaded = await loadCore(params.get("core"));
  mod = loaded.mod;
  $("corelabel").textContent = loaded.label;
  heatmap = new Heatmap($("heat"), $("heatlabels"), Object.keys(mod.HANDLERS));
  mountTelemetryLed($("tled"), $("tgaps"));
  mountGridToggle($("gridtoggle"), $("cabinet"));
  mountLookToggle($("looktoggle"), params.get("look"));
  const rs = await detectReplay();
  if (rs) {
    replay = startReplay(rs, { reset: resetViews, draw: (s) => lcd.draw(s), note: (s) => { $("fps").textContent = s; } });
    $("romlabel").textContent = "inputs disabled in replay";
    await refreshProvenance();
    connect();
    return;
  }
  await loadRomUrl(params.get("rom") ?? "/game/game.gb");
  await refreshProvenance();
  connect();
  requestAnimationFrame(tick);
})();
