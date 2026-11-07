// Frame compaction for the telemetry `ui` stream: a frame event's 23,040-byte shade array (UiEvent `frame.shades_b64`,
// SPEC §6.18) is stored as gzip+base64 under `gz_b64`. `server/replay.ts` inflates it back to the exact UiEvent before
// re-emitting, so the SSE contract is unchanged. The bytes-per-minute reading is printed by server/compact.test.ts.
import { gzipSync, gunzipSync } from "node:zlib";
import type { UiEvent } from "../src/schema.ts";

export type FrameEvent = Extract<UiEvent, { t: "frame" }>;
export interface StoredFrame { source: FrameEvent["source"]; counter: number; gz_b64: string }

/** gzip level for stored frames (zlib's default). */
export const FRAME_GZIP_LEVEL = 6;

export function packFrame(e: FrameEvent): StoredFrame {
  return { source: e.source, counter: e.counter, gz_b64: gzipSync(Buffer.from(e.shades_b64, "base64"), { level: FRAME_GZIP_LEVEL }).toString("base64") };
}

export function unpackFrame(s: StoredFrame): FrameEvent {
  return { t: "frame", source: s.source, shades_b64: gunzipSync(Buffer.from(s.gz_b64, "base64")).toString("base64"), counter: s.counter };
}
