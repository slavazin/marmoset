// The run picker (S24). The page shows one run at a time, in one mode, chosen by URL `?run=RUN-NNNN&mode=live|replay`
// (a replay also takes `t=<iso>`, ui/replay.ts), else by this viewer's last pick (localStorage), else the server's
// default run. The choice travels to the server as the `ratchet_run` and `ratchet_mode` cookies (server/runs.ts
// selectedRun, selectedMode), so every fetch, EventSource and <img> the page makes reads that run with no URL change.
// A pick reloads the page, which reconnects /events. The header select lists GET /api/runs by name, with the selected
// run's description beneath; ui/main.ts imports this module first so the cookies stand before any request.

import { esc } from "./format.ts";

/** localStorage keys holding this viewer's last pick. */
export const RUN_KEY = "ratchet.run";
export const MODE_KEY = "ratchet.mode";
const RUN_ID = /^RUN-\d{4}$/;

export interface Selection { run: string | null; mode: "live" | "replay" }

/** The selection a page load stands on: URL first, then stored pick; `run: null` leaves the server's default. */
export function initialSelection(search: string, stored: { run?: string | null; mode?: string | null }): Selection {
  const q = new URLSearchParams(search);
  const qr = q.get("run"), sr = stored.run ?? null;
  const run = qr && RUN_ID.test(qr) ? qr : sr && RUN_ID.test(sr) ? sr : null;
  const m = q.get("mode") ?? stored.mode ?? "live";
  return { run, mode: m === "replay" ? "replay" : "live" };
}

/** The cookie strings that carry a selection to the server. */
export function selectionCookies(s: Selection): string[] {
  return [
    s.run ? `ratchet_run=${encodeURIComponent(s.run)}; path=/; SameSite=Lax` : "ratchet_run=; path=/; max-age=0; SameSite=Lax",
    `ratchet_mode=${s.mode}; path=/; SameSite=Lax`,
  ];
}

function store(): { get(k: string): string | null; set(k: string, v: string): void } {
  return {
    get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked: the URL still carries the pick */ } },
  };
}

export interface RunRow { id: string; name: string; description: string; has_telemetry: boolean }

/** Rows of the picker's <select>: one per run, the selected one marked. */
export function pickerOptions(runs: RunRow[], selected: string): string {
  return runs.map((r) => `<option value="${esc(r.id)}"${r.id === selected ? " selected" : ""}>${esc(r.id)} · ${esc(r.name)}</option>`).join("");
}

const isBrowser = typeof document !== "undefined" && typeof location !== "undefined";
export const selection: Selection = isBrowser ? initialSelection(location.search, { run: store().get(RUN_KEY), mode: store().get(MODE_KEY) }) : { run: null, mode: "live" };
if (isBrowser) for (const c of selectionCookies(selection)) document.cookie = c;

/** Moves the page to `run` in `mode`: stores the pick, writes it into the URL, reloads. */
export function choose(run: string, mode: "live" | "replay"): void {
  const s = store();
  s.set(RUN_KEY, run); s.set(MODE_KEY, mode);
  for (const c of selectionCookies({ run, mode })) document.cookie = c;
  const u = new URL(location.href);
  u.searchParams.set("run", run); u.searchParams.set("mode", mode); u.searchParams.delete("t");
  location.assign(u.toString());
}

async function mount(): Promise<void> {
  const host = document.getElementById("runpick");
  if (!host) return;
  let data: { default: string; runs: RunRow[] } | null = null;
  try { data = (await (await fetch("/api/runs")).json()) as { default: string; runs: RunRow[] }; } catch { data = null; }
  if (!data) { host.innerHTML = `<span class="dim">runs: GET /api/runs failed</span>`; return; }
  const cur = selection.run ?? data.default;
  const row = data.runs.find((r) => r.id === cur);
  host.innerHTML = `
    <select id="runsel" title="run">${pickerOptions(data.runs, cur)}</select>
    <span class="modes"><button id="mode-live" type="button" aria-pressed="${selection.mode === "live"}">live</button><button id="mode-replay" type="button" aria-pressed="${selection.mode === "replay"}"${row && !row.has_telemetry ? ` disabled title="no runs/${esc(cur)}/telemetry"` : ""}>replay</button></span>
    <span class="rdesc" id="rundesc" title="${esc(row?.description ?? "")}">${esc(row?.description ?? `no registry entry for ${cur}`)}</span>`;
  document.getElementById("runsel")!.addEventListener("change", (e) => choose((e.target as HTMLSelectElement).value, selection.mode));
  document.getElementById("mode-live")!.addEventListener("click", () => choose(cur, "live"));
  document.getElementById("mode-replay")!.addEventListener("click", () => choose(cur, "replay"));
}

if (isBrowser) void mount();
