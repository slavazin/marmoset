// The Play tab (S18): a visitor plays game/game.gb in the browser on main's core/ (loaded through ui/core-seam.ts),
// from the keyboard or the on-screen buttons, at the DMG frame rate (ui/play/session.ts FramePacer). It is outside
// the experiment: its core is its own instance, its input reaches only that core's setButtons, and it posts only
// POST /api/play-session start/stop (ui/play/session.ts PlaySession). ui/present/mount.ts shows and hides it.

import "./play.css";
import type { Core } from "../../src/schema.ts";
import { loadCore } from "../core-seam.ts";
import { Lcd, LCD_W, LCD_H } from "../lcd.ts";
import { esc } from "../format.ts";
import { FramePacer, PlayInput, PlaySession, PLAY_LEGEND, integerScale, playKeyHandler } from "./session.ts";
import type { PlaySessionBody } from "./session.ts";

/** The ROM the Play tab loads, served by the server's GET /game/** route from the game dir. */
export const PLAY_ROM_URL = "/game/game.gb";

/** Largest share of the viewport height the Play LCD takes, so a phone shows the buttons below it. */
const LCD_MAX_VH = 0.62;

/** On-screen buttons: label, joypad bit, CSS class. */
const PAD: [string, number, string][] = [
  ["▲", 2, "up"], ["◀", 1, "left"], ["▶", 0, "right"], ["▼", 3, "down"],
  ["B", 5, "b"], ["A", 4, "a"], ["Select", 6, "sel"], ["Start", 7, "start"],
];

function postSession(path: string, body: PlaySessionBody): void {
  fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), keepalive: true }).catch(() => {});
}

export interface PlayTab { el: HTMLElement; show(): void; hide(): void }

/** Builds the Play tab's element and its controller; nothing loads or runs until the first `show`. */
export function createPlayTab(): PlayTab {
  const el = document.createElement("div");
  el.className = "play";
  el.innerHTML = `
<div class="play-stage"><canvas class="play-lcd" aria-label="Game Boy screen"></canvas><div class="play-note" hidden></div></div>
<div class="play-bar">
  <button type="button" data-act="pause">Pause</button>
  <button type="button" data-act="reset">Reset</button>
  <span class="play-status dim"></span>
</div>
<div class="play-pad" aria-label="on-screen buttons">
  <div class="dpad">${PAD.slice(0, 4).map(([l, b, c]) => `<button type="button" class="pb ${c}" data-bit="${b}" aria-label="${c}">${l}</button>`).join("")}</div>
  <div class="ab">${PAD.slice(4, 6).map(([l, b, c]) => `<button type="button" class="pb ${c}" data-bit="${b}">${l}</button>`).join("")}</div>
  <div class="ss">${PAD.slice(6).map(([l, b, c]) => `<button type="button" class="pb ${c}" data-bit="${b}">${l}</button>`).join("")}</div>
</div>
<table class="play-keys"><tbody>${PLAY_LEGEND.map(([b, k]) => `<tr><td>${esc(b)}</td><td>${esc(k)}</td></tr>`).join("")}</tbody></table>
<p class="dim play-about">This tab is a toy beside the experiment. It runs main's <code>core/</code>; its buttons reach only this tab's core and never the live trace, the ledger or the input telemetry. Only the start and stop of a session, with its length, are logged.</p>`;

  const q = <T extends HTMLElement>(s: string) => el.querySelector(s) as T;
  const canvas = q<HTMLCanvasElement>(".play-lcd");
  const lcd = new Lcd(canvas);
  const status = q<HTMLElement>(".play-status");
  const note = q<HTMLElement>(".play-note");
  const pauseBtn = q<HTMLButtonElement>('[data-act="pause"]');

  let core: Core | null = null;
  let rom: Uint8Array | null = null;
  let makeCore: ((r: Uint8Array) => Core) | null = null;
  let active = false;
  let paused = false;
  let raf = 0;
  let loading: Promise<void> | null = null;
  const pacer = new FramePacer();
  const input = new PlayInput((m) => core?.setButtons(m));
  const session = new PlaySession(postSession);
  const onKey = playKeyHandler(input, () => active);
  addEventListener("keydown", onKey, { capture: true });
  addEventListener("keyup", onKey, { capture: true });
  addEventListener("blur", () => input.clear());
  addEventListener("pagehide", () => session.stop());

  function fit(): void {
    const box = q<HTMLElement>(".play-stage").getBoundingClientRect();
    const s = integerScale(box.width - (parseFloat(getComputedStyle(canvas).borderLeftWidth) || 0) * 2, Math.max(LCD_H, innerHeight * LCD_MAX_VH), LCD_W, LCD_H);
    canvas.style.width = `${LCD_W * s}px`;
    canvas.style.height = `${LCD_H * s}px`;
  }
  addEventListener("resize", () => { if (active) fit(); });

  async function load(): Promise<void> {
    try {
      const { mod } = await loadCore(null);
      makeCore = mod.createCore;
      const r = await fetch(PLAY_ROM_URL);
      if (!r.ok) throw new Error(`${PLAY_ROM_URL}: HTTP ${r.status}`);
      rom = new Uint8Array(await r.arrayBuffer());
      boot();
    } catch (err) {
      note.hidden = false;
      note.textContent = `game not loaded: ${(err as Error).message}`;
    }
  }

  function boot(): void {
    if (!rom || !makeCore) return;
    core = makeCore(rom);
    core.setButtons(input.mask);
    pacer.reset();
    lcd.draw(core.frame());
  }

  function tick(t: number): void {
    raf = 0;
    if (!active) return;
    if (core && !paused) {
      const n = pacer.due(t);
      for (let i = 0; i < n; i++) { core.runFrame(); input.frameDone(); }
      if (n) lcd.draw(core.frame());
    }
    raf = requestAnimationFrame(tick);
  }

  function setPaused(p: boolean): void {
    paused = p;
    pacer.reset();
    pauseBtn.textContent = p ? "Resume" : "Pause";
    status.textContent = p ? "paused" : "main's core/ · game/game.gb";
  }

  el.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "pause") setPaused(!paused);
    if (act === "reset") { boot(); setPaused(false); }
  });
  const press = (e: PointerEvent, down: boolean) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-bit]");
    if (!b) return;
    e.preventDefault();
    b.classList.toggle("held", down);
    input.set(Number(b.dataset.bit), down);
  };
  const pad = q<HTMLElement>(".play-pad");
  pad.addEventListener("pointerdown", (e) => { (e.target as HTMLElement).releasePointerCapture?.(e.pointerId); press(e, true); });
  for (const ev of ["pointerup", "pointercancel", "pointerout"] as const) pad.addEventListener(ev, (e) => press(e, false));
  pad.addEventListener("contextmenu", (e) => e.preventDefault());

  return {
    el,
    show() {
      if (active) return;
      active = true;
      document.body.classList.add("play-on");
      fit();
      setPaused(false);
      loading ??= load();
      session.start();
      if (!raf) raf = requestAnimationFrame(tick);
    },
    hide() {
      if (!active) return;
      active = false;
      document.body.classList.remove("play-on");
      input.clear();
      pad.querySelectorAll(".held").forEach((b) => b.classList.remove("held"));
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      session.stop();
    },
  };
}
