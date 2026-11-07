// Motion and display toggles for the cabinet (S19). Decoration only: nothing here reads or prints a figure.
// `pulse` restarts a one-shot CSS animation class on a stable element (the cabinet, a module), so a re-render of
// the cards inside it never replays the animation. The CSS turns every animation off under prefers-reduced-motion.

/** localStorage key for the LCD pixel-grid toggle; a per-viewer convenience, default off. */
const GRID_KEY = "ratchet.lcdgrid";

/** Restarts `cls` on `el`, first removing every class in `clear` (the sibling one-shots it replaces). */
export function pulse(el: Element | null, cls: string, clear: string[] = []): void {
  if (!el) return;
  el.classList.remove(cls, ...clear);
  void (el as HTMLElement).offsetWidth; // reflow, so the animation starts again
  el.classList.add(cls);
}

/** localStorage key for the chosen look, "cabinet" (wide, the default) or "handheld" (compact, stacked). */
const LOOK_KEY = "ratchet.look";
/** Viewport width (px) at or below which the handheld look applies whatever was chosen: phones. */
export const COMPACT_MAX_PX = 700;
/** The looks the header switch offers, the default first; `?look=compact` and `?look=wide` alias them for demo links. */
export const LOOKS = ["cabinet", "handheld"] as const;
export type Look = (typeof LOOKS)[number];

/** The look a URL `look` parameter names, or null when it names none. */
export function lookFromParam(p: string | null): Look | null {
  if (p === "compact" || p === "handheld") return "handheld";
  if (p === "wide" || p === "cabinet") return "cabinet";
  return null;
}

/**
 * Wires the header's look switch to `look-compact` on <body>. The URL parameter wins for this page load and is not
 * remembered; a click is remembered per browser when storage allows. Narrow viewports are compact regardless.
 */
export function mountLookToggle(btn: HTMLElement | null, param: string | null): void {
  if (!btn) return;
  const narrow = matchMedia(`(max-width: ${COMPACT_MAX_PX}px)`);
  let chosen: Look = lookFromParam(param) ?? "cabinet";
  if (!lookFromParam(param)) try { chosen = lookFromParam(localStorage.getItem(LOOK_KEY)) ?? "cabinet"; } catch { /* storage blocked */ }
  const apply = () => {
    const compact = narrow.matches || chosen === "handheld";
    document.body.classList.toggle("look-compact", compact);
    document.body.dataset.look = compact ? "handheld" : "cabinet";
    btn.textContent = narrow.matches ? "handheld · auto" : chosen;
    btn.setAttribute("aria-pressed", String(chosen === "handheld"));
    btn.toggleAttribute("disabled", narrow.matches);
  };
  btn.addEventListener("click", () => {
    chosen = chosen === "cabinet" ? "handheld" : "cabinet";
    try { localStorage.setItem(LOOK_KEY, chosen); } catch { /* storage blocked */ }
    apply();
  });
  narrow.addEventListener("change", apply);
  apply();
}

/** Wires the bezel's grid switch to the `lcd-grid` class on the cabinet, remembered per browser when storage allows. */
export function mountGridToggle(btn: HTMLElement | null, cabinet: HTMLElement | null): void {
  if (!btn || !cabinet) return;
  const set = (on: boolean) => {
    cabinet.classList.toggle("lcd-grid", on);
    btn.setAttribute("aria-pressed", String(on));
    try { localStorage.setItem(GRID_KEY, on ? "on" : "off"); } catch { /* storage blocked */ }
  };
  let on = false;
  try { on = localStorage.getItem(GRID_KEY) === "on"; } catch { /* storage blocked */ }
  set(on);
  btn.addEventListener("click", () => set(!cabinet.classList.contains("lcd-grid")));
}
