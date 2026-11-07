// The presentation tabs (S14), mounted by one import in ui/main.ts. Adds a tab bar to the header: Game (the
// default, S6's screen untouched), Premise, Approach, History, the Pre-event evidence tab and Play (ui/play/play.ts,
// a visitor's game outside the experiment, which hides the live LCD while open). A non-game tab shows
// its panel beside the LCD and hides the metadata panel and footer; the LCD keeps playing. The page opens on the
// tab named by `#tab=<id>`. A second EventSource on /events drives the Approach diagram's highlight
// (ui/present/diagram.ts StageTracker) and refetches /api/history while History is open. No numeric literal
// (ui/present/present.test.ts).

import "./present.css";
import type { UiEvent } from "../../src/schema.ts";
import type { History } from "../../server/history.ts";
import { renderCurve } from "../panels.ts";
import { StageTracker, diagramSvg } from "./diagram.ts";
import { premiseTab, approachTab, preEventTab } from "./tabs.ts";
import { historyTab } from "./history.ts";
import { openEvidence } from "./evidence.ts";
import { PRE_EVENT_LABEL } from "./pre-event-evidence.ts";
import { HISTORY_REFETCH_MS } from "./layout.ts";
import { esc } from "../format.ts";
import { createPlayTab } from "../play/play.ts";

export const TABS = [
  { id: "game", label: "Game" },
  { id: "premise", label: "Premise" },
  { id: "approach", label: "Approach" },
  { id: "history", label: "History" },
  { id: "pre-event", label: PRE_EVENT_LABEL },
  { id: "play", label: "Play" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const LEDGER_EVENTS = new Set<UiEvent["t"]>(["incident", "attempt", "verdict", "fire", "curve", "vread", "core"]);

const tracker = new StageTracker();
const play = createPlayTab();
let tab: TabId = "game";
let history: History | null = null;
let historyError: string | undefined;
let refetchTimer: ReturnType<typeof setTimeout> | null = null;

const nav = document.createElement("nav");
nav.className = "ptabs";
nav.setAttribute("role", "tablist");
nav.innerHTML = TABS.map((t) => `<button role="tab" data-tab="${t.id}" class="${t.id === "pre-event" ? "pre" : ""}">${esc(t.label)}</button>`).join("");
document.querySelector("header")?.appendChild(nav);

const panel = document.createElement("section");
panel.id = "present";
panel.hidden = true;
document.querySelector("main")?.appendChild(panel);

function renderDiagram(): void {
  const d = document.getElementById("present-diagram");
  const c = document.getElementById("present-diagram-cap");
  if (d) d.innerHTML = diagramSvg(tracker.lit);
  if (c) c.textContent = `last event: ${tracker.lit.label}`;
}

function renderHistory(): void {
  panel.innerHTML = historyTab(history, historyError);
  const el = document.getElementById("present-curve");
  if (el && history) renderCurve(el, history.curve as Extract<UiEvent, { t: "curve" }>[]);
}

async function fetchHistory(): Promise<void> {
  try {
    const r = await fetch("/api/history");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    history = (await r.json()) as History;
    historyError = undefined;
  } catch (err) { historyError = String((err as Error).message); }
  if (tab === "history") renderHistory();
}

function render(): void {
  document.body.classList.toggle("present-on", tab !== "game");
  panel.hidden = tab === "game";
  nav.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  if (tab === "premise") panel.innerHTML = premiseTab();
  if (tab === "approach") panel.innerHTML = approachTab(diagramSvg(tracker.lit), `last event: ${tracker.lit.label}`);
  if (tab === "pre-event") panel.innerHTML = preEventTab();
  if (tab === "history") { renderHistory(); fetchHistory(); }
  if (tab === "play") { panel.replaceChildren(play.el); play.show(); } else play.hide();
}

export function selectTab(id: TabId): void {
  tab = id;
  render();
  try { window.history.replaceState(null, "", id === "game" ? location.pathname + location.search : `#tab=${id}`); } catch { /* history API unavailable */ }
}

nav.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-tab]");
  if (!b) return;
  selectTab(b.dataset.tab as TabId);
  b.blur();
});
panel.addEventListener("click", (e) => {
  const key = (e.target as HTMLElement).closest<HTMLElement>("[data-ev]")?.dataset.ev;
  if (key && history) openEvidence(history, key);
});

function onEvent(e: UiEvent): void {
  if (tracker.push(e, performance.now()) && tab === "approach") renderDiagram();
  if (LEDGER_EVENTS.has(e.t) && tab === "history") {
    if (refetchTimer) clearTimeout(refetchTimer);
    refetchTimer = setTimeout(fetchHistory, HISTORY_REFETCH_MS);
  }
}

const es = new EventSource("/events");
es.onmessage = (m) => { try { onEvent(JSON.parse(m.data) as UiEvent); } catch { /* malformed event enters no view */ } };

(window as unknown as { __ratchetPresent: unknown }).__ratchetPresent = { tracker, selectTab };
const want = /#tab=([\w-]+)/.exec(location.hash)?.pop();
if (want && TABS.some((t) => t.id === want)) selectTab(want as TabId);
