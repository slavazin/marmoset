// The server recorder: taps the EventBus so every emitted UiEvent lands in telemetry stream `ui` (src/telemetry.ts).
// Frames are thinned to TELEMETRY_FRAME_HZ per source and stored compacted (server/compact.ts); every other event is
// written in full with its origin ("ledger" for tailed records, "producer" for POST /api/event and inputs).
// `server/replay.ts` re-emits producer-origin events from here and re-derives ledger-origin events from ledger/ (G9).
import { tlog as realTlog, TELEMETRY_FRAME_HZ } from "../src/telemetry.ts";
import type { TelemetryStream } from "../src/telemetry.ts";
import type { EventBus, Origin } from "./events.ts";
import { packFrame } from "./compact.ts";
import type { UiEvent } from "../src/schema.ts";

export type Tlog = (stream: TelemetryStream, kind: string, data: unknown) => void;

/** Keeps a frame per source when 1000/hz ms have passed since the last kept one. */
export class FrameThinner {
  private last = new Map<string, number>();
  readonly hz: number;
  constructor(hz = TELEMETRY_FRAME_HZ) { this.hz = hz; }
  keep(source: string, now: number): boolean {
    const l = this.last.get(source);
    if (l !== undefined && now - l < 1000 / this.hz) return false;
    this.last.set(source, now);
    return true;
  }
}

/** Subscribes the recorder to `bus`; returns the unsubscribe. `log` and `now` are seams for tests. */
export function attachRecorder(bus: EventBus, log: Tlog = realTlog, now: () => number = Date.now): () => void {
  const thin = new FrameThinner();
  return bus.subscribe((e: UiEvent, origin: Origin) => {
    if (e.t === "frame") {
      if (thin.keep(e.source, now())) log("ui", "frame", { origin, ...packFrame(e) });
      return;
    }
    log("ui", e.t, { origin, event: e });
  });
}
