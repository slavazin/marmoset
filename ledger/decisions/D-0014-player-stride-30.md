---
id: D-0014
title: Gemini play widens its decision stride to 30 frames once a decision takes over 3 s
status: admitted
supersedes: null
---
**Decision:** `player/play.ts` decides every `STRIDE` (15) game frames and switches to `STRIDE_SLOW` (30) after the first decision slower than `SLOW_MS` (3000 ms); the game waits on the oracle during a decision, so latency costs wall time and no frames.
**Not this:** a fixed 15-frame stride at every latency, or a decision timeout that substitutes a scripted press for Gemini's.
**Warrant:** SPEC §5 S7 Wiggle names stride 30 above 3 s. On 2026-11-07, two `gemini-3.8-flash` Interactions calls with `thinking_level: "low"` from this machine took 68,799 ms and 355,905 ms. False if: the `llm` telemetry stream's `wall_ms` for player calls in a run reads under 3000 at the median.
**Revisit when:** {when: "player call median wall_ms under 3000 ms", then: "keep stride 15 throughout"}
**Residue:** at the measured latency one Gemini decision costs one to six minutes of wall time, so a Gemini segment covers tens of decisions per hour; the explorer supplies the volume.
