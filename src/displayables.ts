// The displayables manifest: one entry per thing the UI or the demo shows (SPEC §5 S6 panels, §7.7 demo beats, the
// S13 spotter summary, the S10 cost meter), each naming where its data is recorded and which module writes it.
// `server/verify.ts` (`pnpm telemetry:verify`) reads this list: the static check greps each producer file for its
// pattern; the dynamic check reads the run's telemetry and ledger for each source once the entry's trigger has
// happened. An entry whose producer is another slice's unbuilt file reads `gap` until that file lands.

import type { TelemetryStream } from "./telemetry.ts";

/** A place a displayable's data is recorded. `match` narrows telemetry records by one field of `data`. */
export type DisplaySource =
  | { telemetry: { stream: TelemetryStream; kind?: string; match?: { field: string; equals: unknown } } }
  | { ledger: { file: string; field?: string } }
  | { runs: { file: string } };

/** A module that writes a source: `file` (repo-relative) contains a match for the regex `pattern`. */
export interface Producer { file: string; pattern: string }

/** What makes a displayable due: play started, a ledger record exists (optionally with field = value), a runs file exists, a telemetry record exists. */
export type Trigger =
  | { always: true }
  | { play: true }
  | { ledger: { file: string; field?: string; equals?: unknown } }
  | { runs: { file: string } }
  | { telemetry: { stream: TelemetryStream; kind?: string } };

export interface Displayable { id: string; shows: string; where: "panel" | "beat" | "meter"; sources: DisplaySource[]; producers: Producer[]; trigger: Trigger }

const verdictRec = { ledger: { file: "verdicts.jsonl" } } as const;
const meta = { telemetry: { stream: "ui", kind: "meta" } } as const;
const metaProducer: Producer = { file: "ui/main.ts", pattern: String.raw`t: "meta"` };
const recorder: Producer = { file: "server/recorder.ts", pattern: String.raw`log\("ui", e\.t` };

export const DISPLAYABLES: readonly Displayable[] = [
  // ---- SPEC §5 S6 panels ----
  { id: "lcd", shows: "the core's LCD", where: "panel", trigger: { play: true },
    sources: [{ telemetry: { stream: "ui", kind: "frame", match: { field: "source", equals: "core" } } }],
    producers: [{ file: "ui/main.ts", pattern: String.raw`t: "frame", source: "core"` }, { file: "server/recorder.ts", pattern: String.raw`log\("ui", "frame"` }] },
  { id: "oracle-diff", shows: "the oracle frame and the red diff during an incident", where: "panel", trigger: { ledger: { file: "incidents.jsonl" } },
    sources: [{ ledger: { file: "incidents.jsonl", field: "files" } }, { telemetry: { stream: "ui", kind: "frame", match: { field: "source", equals: "oracle" } } }],
    producers: [{ file: "loop/incident-sink.ts", pattern: String.raw`appendNew\("incidents\.jsonl"` }, { file: "lockstep/lockstep.ts", pattern: String.raw`source: "oracle"` }] },
  { id: "pc-opcode", shows: "PC and the disassembled opcode", where: "panel", trigger: { play: true }, sources: [meta], producers: [metaProducer, recorder] },
  { id: "ppu-leds", shows: "LY, PPU mode and STAT", where: "panel", trigger: { play: true }, sources: [meta], producers: [metaProducer, recorder] },
  { id: "ie-if", shows: "IE and IF", where: "panel", trigger: { play: true }, sources: [meta], producers: [metaProducer, recorder] },
  { id: "heatmap", shows: "the per-frame handler heatmap", where: "panel", trigger: { play: true }, sources: [meta], producers: [metaProducer, recorder] },
  { id: "provenance", shows: "provenance: handler, file, last attempt and skill", where: "panel", trigger: { ledger: { file: "verdicts.jsonl", field: "decision", equals: "GRADUATE" } },
    sources: [{ ledger: { file: "provenance.json" } }], producers: [{ file: "loop/gate-repair.ts", pattern: String.raw`regenerateProvenance\(paths` }] },
  { id: "incident-feed", shows: "the incident feed", where: "panel", trigger: { ledger: { file: "incidents.jsonl" } },
    sources: [{ ledger: { file: "incidents.jsonl" } }], producers: [{ file: "loop/incident-sink.ts", pattern: String.raw`appendNew\("incidents\.jsonl"` }] },
  { id: "verdict-stack", shows: "the ratchet stack of verdict cards", where: "panel", trigger: { ledger: { file: "verdicts.jsonl" } },
    sources: [{ ledger: { file: "verdicts.jsonl", field: "checks" } }, { telemetry: { stream: "loop", kind: "verdict" } }],
    producers: [{ file: "loop/gate-repair.ts", pattern: String.raw`appendNew<Verdict>\("verdicts\.jsonl"` }, { file: "loop/gate-repair.ts", pattern: String.raw`tlog\("loop", "verdict"` }] },
  { id: "generation-curve", shows: "the generation curve of trial arms", where: "panel", trigger: { ledger: { file: "verdicts.jsonl", field: "subject.kind", equals: "skill" } },
    sources: [{ ledger: { file: "verdicts.jsonl", field: "arms" } }], producers: [{ file: "loop/trial.ts", pattern: String.raw`arms` }] },
  { id: "mooneye-leds", shows: "Mooneye LEDs for T and H", where: "panel", trigger: { ledger: { file: "verdicts.jsonl" } },
    sources: [{ ledger: { file: "verdicts.jsonl", field: "checks" } }], producers: [{ file: "loop/gate-repair.ts", pattern: String.raw`"H-no-regress"` }] },
  { id: "vread", shows: "the V read with its unit and n", where: "panel", trigger: { runs: { file: "vread.json" } },
    sources: [{ runs: { file: "vread.json" } }], producers: [{ file: "loop/vread.ts", pattern: String.raw`vread\.json` }] },
  // ---- SPEC §7.7 demo beats ----
  { id: "beat-incident", shows: "a real incident from play", where: "beat", trigger: { ledger: { file: "incidents.jsonl" } },
    sources: [{ ledger: { file: "incidents.jsonl" } }, { telemetry: { stream: "loop", kind: "incident-picked" } }],
    producers: [{ file: "loop/incident-sink.ts", pattern: String.raw`appendNew\("incidents\.jsonl"` }, { file: "loop/fast.ts", pattern: String.raw`tlog\("loop", "incident-picked"` }] },
  { id: "beat-narration", shows: "the incident's narration", where: "beat", trigger: { ledger: { file: "incidents.jsonl" } },
    sources: [{ ledger: { file: "incidents.jsonl", field: "narration" } }], producers: [{ file: "loop/narrate.ts", pattern: String.raw`"narration"` }] },
  { id: "beat-hook-fire", shows: "a hook firing", where: "beat", trigger: { ledger: { file: "fires.jsonl" } },
    sources: [{ ledger: { file: "fires.jsonl" } }], producers: [{ file: "server/fire.ts", pattern: String.raw`fires\.jsonl` }] },
  { id: "beat-repair", shows: "the repair: the attempt and its Muse MSP stream", where: "beat", trigger: { ledger: { file: "attempts.jsonl" } },
    sources: [{ ledger: { file: "attempts.jsonl" } }, { telemetry: { stream: "muse", kind: "msp" } }, { telemetry: { stream: "loop", kind: "attempt-start" } }],
    producers: [{ file: "loop/fast.ts", pattern: String.raw`appendNew<Attempt>\("attempts\.jsonl"` }, { file: "loop/repair.ts", pattern: String.raw`tlog\("muse", "msp"` }, { file: "loop/fast.ts", pattern: String.raw`tlog\("loop", "attempt-start"` }] },
  { id: "beat-resume", shows: "resume on the fixed core (N3 core hot-swap)", where: "beat", trigger: { ledger: { file: "verdicts.jsonl", field: "decision", equals: "GRADUATE" } },
    sources: [{ telemetry: { stream: "ui", kind: "core" } }], producers: [{ file: "loop/gate-repair.ts", pattern: String.raw`t: "core"` }, recorder] },
  { id: "beat-refused-card", shows: "a REFUSED card with its deciding reading", where: "beat", trigger: { ledger: { file: "verdicts.jsonl", field: "decision", equals: "REFUSE" } },
    sources: [{ ledger: { file: "verdicts.jsonl", field: "reason" } }], producers: [{ file: "loop/gate-repair.ts", pattern: String.raw`decision, checks, reason` }] },
  { id: "beat-graduated-card", shows: "a GRADUATED card", where: "beat", trigger: { ledger: { file: "verdicts.jsonl", field: "decision", equals: "GRADUATE" } },
    sources: [verdictRec], producers: [{ file: "loop/gate-repair.ts", pattern: String.raw`"GRADUATE"` }] },
  { id: "beat-tombstones", shows: "skill tombstones with deciding reading and placebo arm (G10)", where: "beat", trigger: { ledger: { file: "verdicts.jsonl", field: "subject.kind", equals: "skill" } },
    sources: [{ ledger: { file: "verdicts.jsonl", field: "arms" } }], producers: [{ file: "loop/placebo.ts", pattern: String.raw`placebo` }] },
  { id: "beat-curve", shows: "the generation curve beat", where: "beat", trigger: { ledger: { file: "verdicts.jsonl", field: "subject.kind", equals: "skill" } },
    sources: [{ ledger: { file: "verdicts.jsonl", field: "arms" } }], producers: [{ file: "loop/trial.ts", pattern: String.raw`arms` }] },
  { id: "beat-vread", shows: "the V read with its unit and n", where: "beat", trigger: { runs: { file: "vread.json" } },
    sources: [{ runs: { file: "vread.json" } }], producers: [{ file: "loop/vread.ts", pattern: String.raw`n_family_runs_per_arm` }] },
  // ---- D-0020 policies: verdicts with subject kind "policy", their arms, and each move to graduated or tombstones ----
  { id: "policy", shows: "policy verdicts (packet, tool and routing changes) with their arms and moves", where: "panel", trigger: { ledger: { file: "verdicts.jsonl", field: "subject.kind", equals: "policy" } },
    sources: [{ ledger: { file: "verdicts.jsonl", field: "arms" } }, { telemetry: { stream: "loop", kind: "policy.move" } }],
    producers: [{ file: "loop/trial.ts", pattern: String.raw`tlog\("loop", \`\$\{kind\}\.move\`` }, { file: "loop/policies.ts", pattern: String.raw`tlog\("loop", "policy\.nominate"` }] },
  // ---- S13, S10 ----
  { id: "spotter-summary", shows: "the S13 Gemini spotter summary and its oracle scoring", where: "meter", trigger: { play: true },
    sources: [{ telemetry: { stream: "spot" } }], producers: [{ file: "player/spot.ts", pattern: String.raw`tlog\("spot"` }] },
  { id: "cost-meter", shows: "the spend meter (SPEC §7.3)", where: "meter", trigger: { ledger: { file: "attempts.jsonl" } },
    sources: [{ ledger: { file: "spend.jsonl" } }], producers: [{ file: "server/spend.ts", pattern: String.raw`spend\.jsonl` }] },
  // ---- S14 presentation tabs: the History tab reads GET /api/history, which replay mode serves from the recorded ledger ----
  { id: "history-tab", shows: "the History tab (S14)", where: "panel", trigger: { ledger: { file: "verdicts.jsonl" } },
    sources: [{ ledger: { file: "verdicts.jsonl" } }, { ledger: { file: "attempts.jsonl" } }], producers: [{ file: "server/history.ts", pattern: String.raw`history` }] },
  // ---- the replay itself ----
  { id: "inputs", shows: "the input stream the replay regenerates frames from", where: "panel", trigger: { play: true },
    sources: [{ telemetry: { stream: "input", kind: "mask" } }], producers: [{ file: "server/index.ts", pattern: String.raw`log\("input", "mask"` }] },
  { id: "process", shows: "the replay label's recorded date and core commit", where: "panel", trigger: { always: true },
    sources: [{ telemetry: { stream: "process", kind: "start" } }], producers: [{ file: "src/telemetry-process.ts", pattern: String.raw`tlog\("process", "start"` }] },
];
