// The telemetry coverage LED in the header: "telemetry: k/n covered, m gaps" from GET /api/telemetry-verify (the
// latest server/verify.ts report); a click lists the gaps and the not-yet rows. Polls every LED_POLL_S.
import { esc } from "./format.ts";

/** Seconds between polls of /api/telemetry-verify; the server re-verifies every VERIFY_EVERY_S (server/verify.ts). */
export const LED_POLL_S = 30;

interface Report { at: string; covered: number; total: number; gaps: { id: string; check: string; why: string }[]; rows: { id: string; status: string; why: string }[]; replay: string }

export function mountTelemetryLed(led: HTMLElement, list: HTMLElement): void {
  let last: Report | null = null;
  const poll = async () => {
    try { last = (await (await fetch("/api/telemetry-verify")).json()) as Report | null; } catch { last = null; }
    if (!last) { led.className = "led"; led.lastElementChild!.textContent = "telemetry: not verified"; return; }
    led.className = `led ${last.gaps.length ? "off" : "on"}`;
    led.lastElementChild!.textContent = `telemetry: ${last.covered}/${last.total} covered, ${last.gaps.length} gaps`;
    led.title = `verified ${last.at} · replay ${last.replay}`;
  };
  led.addEventListener("click", () => {
    if (!last) return;
    list.hidden = !list.hidden;
    list.innerHTML = `<b>Telemetry gaps</b> <span class="dim">(${esc(last.at)})</span>` +
      last.gaps.map((g) => `<div class="fail">${esc(g.check)} · <b>${esc(g.id)}</b> · ${esc(g.why)}</div>`).join("") +
      last.rows.filter((r) => r.status === "not-yet").map((r) => `<div class="dim">not-yet · ${esc(r.id)}</div>`).join("");
  });
  poll();
  setInterval(poll, LED_POLL_S * 1000);
}
