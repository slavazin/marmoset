// Replay mode in the UI (server/replay.ts plays a recorded run through the same SSE). `startReplay(hooks)` mounts:
//   - the "REPLAY · <run> · recorded <date>" label, so a replay is never taken for live;
//   - the replay bar: play/pause, speed, a scrubber over the run's timeline with markers for incidents, verdicts,
//     fires and graduations (from GET /api/replay, which reads them from the recorded ledger);
//   - the inspector (toggle): the telemetry records around the scrubber time, filterable by stream; a click on an
//     llm record shows its full request and response, a click on a muse record shows that attempt's MSP stream.
// The LCD shows the recorded core frames. Between sampled frames it is regenerated from the input stream when the
// server names a core bundle for the recorded commit (status.regen); otherwise it holds the last sampled frame and says so.

import { esc } from "./format.ts";
import { loadCore } from "./core-seam.ts";
import type { Core } from "../src/schema.ts";
import { GAME_RAM } from "../src/schema.ts";

interface Marker { at: number; kind: string; id: string; label: string }
export interface ReplayStatus { run: string; recorded: string; t0: number; t1: number; pos: number; playing: boolean; speed: number; markers: Marker[]; regen: { commit: string; bundle_url: string } | null; commit: string | null; done: boolean; reset?: boolean }
interface Rec { at: string; seq: number; pid: number; stream: string; kind: string; data: unknown; i: number }

/** Playback speeds the bar offers, × the recorded clock. */
export const REPLAY_SPEEDS = [0.5, 1, 2, 4, 8, 16, 32, 64];
/** Most regenerated emulator frames per animation frame; caps catch-up at high speed. */
const REGEN_MAX_FRAMES = 240;

export interface ReplayHooks { reset(): void; draw(shades: Uint8Array): void; note(text: string): void }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const post = (body: unknown) => fetch("/api/replay/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
const hhmmss = (ms: number) => new Date(ms).toISOString().slice(11, 19);

export async function detectReplay(): Promise<ReplayStatus | null> {
  try { const r = await fetch("/api/replay"); return r.ok ? ((await r.json()) as ReplayStatus) : null; } catch { return null; }
}

export function startReplay(first: ReplayStatus, hooks: ReplayHooks) {
  let st = first;
  let dragging = false;
  const inputs: { counter: number; mask: number }[] = [];
  document.body.classList.add("replay");
  $("replaylabel").hidden = false;
  $("replaylabel").textContent = `REPLAY · ${st.run} · recorded ${st.recorded.slice(0, 16).replace("T", " ")} UTC`;
  const bar = $("replaybar");
  bar.hidden = false;
  bar.innerHTML = `
    <button id="rp-play" title="play / pause">▶</button>
    <select id="rp-speed" title="speed">${REPLAY_SPEEDS.map((s) => `<option value="${s}">${s}×</option>`).join("")}</select>
    <span id="rp-time" class="dim"></span>
    <div id="rp-track"><input id="rp-scrub" type="range" min="0" max="1000" value="0"><div id="rp-marks"></div></div>
    <span id="rp-end" class="dim"></span>
    <button id="rp-insp" title="inspector">inspector</button>`;
  const scrub = $<HTMLInputElement>("rp-scrub");
  const span = () => Math.max(1, st.t1 - st.t0);
  const toPos = (v: number) => st.t0 + (v / 1000) * span();
  const renderMarks = () => {
    $("rp-marks").innerHTML = st.markers.map((m) => `<i class="mk mk-${esc(m.kind)}" style="left:${(((m.at - st.t0) / span()) * 100).toFixed(2)}%" title="${esc(hhmmss(m.at))} ${esc(m.label)}" data-at="${m.at}"></i>`).join("");
  };
  const renderBar = () => {
    $("rp-play").textContent = st.playing ? "❚❚" : "▶";
    $<HTMLSelectElement>("rp-speed").value = String(st.speed);
    $("rp-time").textContent = hhmmss(Math.max(st.pos, st.t0));
    $("rp-end").textContent = hhmmss(st.t1);
    if (!dragging) scrub.value = String(Math.round(((Math.max(st.pos, st.t0) - st.t0) / span()) * 1000));
  };
  renderMarks(); renderBar();
  $("rp-play").addEventListener("click", () => post({ op: st.playing ? "pause" : "play" }));
  $<HTMLSelectElement>("rp-speed").addEventListener("change", (e) => post({ op: "speed", value: Number((e.target as HTMLSelectElement).value) }));
  scrub.addEventListener("input", () => { dragging = true; $("rp-time").textContent = hhmmss(toPos(Number(scrub.value))); });
  scrub.addEventListener("change", () => { dragging = false; post({ op: "seek", value: toPos(Number(scrub.value)) }); });
  $("rp-marks").addEventListener("click", (e) => { const at = (e.target as HTMLElement).dataset.at; if (at) post({ op: "seek", value: Number(at) }); });

  // ---------- inspector ----------
  const insp = $("inspector");
  let stream = "";
  let lastFetch = 0;
  let lastAt = NaN;
  $("rp-insp").addEventListener("click", () => { insp.hidden = !insp.hidden; if (!insp.hidden) refreshInspector(true); });
  insp.innerHTML = `<div class="ihead"><b>Telemetry</b> <select id="in-stream"><option value="">all streams</option>${["ui", "input", "llm", "muse", "loop", "spot", "process"].map((s) => `<option>${s}</option>`).join("")}</select> <span id="in-at" class="dim"></span><button id="in-close">close</button></div><div id="in-rows"></div><pre id="in-detail" class="detail"></pre>`;
  $("in-close").addEventListener("click", () => { insp.hidden = true; });
  $<HTMLSelectElement>("in-stream").addEventListener("change", (e) => { stream = (e.target as HTMLSelectElement).value; refreshInspector(true); });
  let rows: Rec[] = [];
  async function refreshInspector(force = false): Promise<void> {
    const at = Math.max(st.pos, st.t0);
    if (insp.hidden || (!force && (Date.now() - lastFetch < 1000 || at === lastAt))) return;
    lastFetch = Date.now();
    lastAt = at;
    $("in-at").textContent = `±30 s of ${hhmmss(at)}`;
    try { rows = (await (await fetch(`/api/replay/records?at=${Math.round(at)}${stream ? `&stream=${stream}` : ""}`)).json()) as Rec[]; } catch { rows = []; }
    $("in-rows").innerHTML = rows.map((r) => `<div class="irow ${Date.parse(r.at) <= at ? "past" : "future"}" data-i="${r.i}"><span class="dim">${esc(r.at.slice(11, 23))}</span> <b class="s-${esc(r.stream)}">${esc(r.stream)}</b> ${esc(r.kind)} <span class="dim">${esc(summary(r))}</span></div>`).join("") || `<div class="dim">no telemetry record within 30 s</div>`;
  }
  $("in-rows").addEventListener("click", async (e) => {
    const i = Number((e.target as HTMLElement).closest<HTMLElement>("[data-i]")?.dataset.i);
    const r = rows.find((x) => x.i === i);
    if (!r) return;
    const det = $("in-detail");
    if (r.stream === "muse") {
      const att = (r.data as { attempt?: string }).attempt ?? "";
      const msp = (await (await fetch(`/api/replay/muse?attempt=${encodeURIComponent(att)}`)).json()) as Rec[];
      det.textContent = `MSP stream of ${att} (${msp.length} records)\n` + msp.map((m) => `${m.at.slice(11, 23)} ${JSON.stringify((m.data as { record?: unknown }).record)}`).join("\n");
    } else if (r.stream === "llm") {
      const d = r.data as { request?: unknown; response?: unknown };
      det.textContent = `llm ${r.kind} at ${r.at}\n\nREQUEST\n${JSON.stringify(d.request, null, 2)}\n\nRESPONSE\n${typeof d.response === "string" ? d.response : JSON.stringify(d.response, null, 2)}\n\nRECORD\n${JSON.stringify(r.data, null, 2)}`;
    } else det.textContent = JSON.stringify(r, null, 2);
  });

  // ---------- LCD: sampled frames, regenerated between them when a bundle exists ----------
  let regen: { core: Core; rom: Uint8Array; mod: Awaited<ReturnType<typeof loadCore>>["mod"] } | null = null;
  let lastSample = 0;
  const counterOf = (c: Core) => c.read(GAME_RAM.counter) | (c.read(GAME_RAM.counter + 1) << 8);
  const maskAt = (ctr: number) => { let m = 0; for (const x of inputs) { if (x.counter > ctr) break; m = x.mask; } return m; };
  const runTo = (target: number) => {
    if (!regen) return;
    if (counterOf(regen.core) > target) regen.core = regen.mod.createCore(regen.rom);
    for (let n = 0; n < 1e5 && counterOf(regen.core) < target; n++) { regen.core.setButtons(maskAt(counterOf(regen.core))); regen.core.runFrame(); }
  };
  if (st.regen) {
    (async () => {
      try {
        const { mod } = await loadCore(st.regen!.bundle_url);
        const rom = new Uint8Array(await (await fetch("/game/game.gb")).arrayBuffer());
        regen = { core: mod.createCore(rom), rom, mod };
        hooks.note(`LCD regenerated from the input stream on core ${st.regen!.commit}`);
      } catch { hooks.note(`LCD holds the last sampled frame: ${st.regen!.bundle_url} failed to load`); }
    })();
  } else hooks.note(`LCD holds the last sampled frame (no dist/core-${st.commit ?? "?"}.js for the recorded commit)`);
  let lastT = 0;
  const tick = (t: number) => {
    if (regen && st.playing && lastT) {
      const n = Math.min(REGEN_MAX_FRAMES, Math.round(((t - lastT) / 1000) * 59.73 * st.speed));
      for (let k = 0; k < n; k++) { regen.core.setButtons(maskAt(counterOf(regen.core))); regen.core.runFrame(); }
      if (n) hooks.draw(regen.core.frame());
    }
    lastT = t;
    refreshInspector();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  return {
    onStatus(s: ReplayStatus) {
      st = s;
      if (s.reset) { inputs.length = 0; hooks.reset(); }
      renderBar();
    },
    onTelemetry(r: Rec) {
      if (r.stream === "input" && r.kind === "mask") { const d = r.data as { counter: number; mask: number }; inputs.push({ counter: d.counter, mask: d.mask }); }
    },
    /** A sampled core frame: drawn as is, and the regenerated core is brought to its counter. */
    onCoreFrame(shades: Uint8Array, counter: number) {
      lastSample = counter;
      hooks.draw(shades);
      if (regen) runTo(counter);
      else hooks.note(`LCD holds the sampled frame at counter ${lastSample} (no core bundle for ${st.commit ?? "the recorded commit"})`);
    },
  };
}

function summary(r: Rec): string {
  const d = r.data as Record<string, unknown>;
  if (r.stream === "ui") { const e = (d.event ?? d) as Record<string, unknown>; return r.kind === "frame" ? `${d.source} counter ${d.counter}` : JSON.stringify(e).slice(0, 90); }
  if (r.stream === "llm") return `${d.role ?? ""} ${d.model ?? ""} ${d.outcome ?? ""}`;
  if (r.stream === "muse") return `${d.attempt} ${JSON.stringify((d.record as { payload?: unknown })?.payload ?? d.record).slice(0, 70)}`;
  return JSON.stringify(d).slice(0, 100);
}
