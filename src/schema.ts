// The one home of every shared shape (SPEC §6). Import from here; a shape change is the orchestrator's.

// §6.0 Id prefixes: INC incident · ATT attempt · VER verdict · OBS observation · SKL skill · FIR fire ·
// D decision · BEL belief · TRC admitted trace · RUN run. Format: PREFIX-NNNN.
export const ID_PREFIXES = ["INC", "ATT", "VER", "OBS", "SKL", "FIR", "D", "BEL", "TRC", "RUN", "SPT", "STR"] as const; // SPT spot (S13), STR steer (S8)
export type IdPrefix = (typeof ID_PREFIXES)[number];

// Status record appended to a ledger file; loop/ledger.ts current(id) reads the last one written (SPEC §6).
export interface StatusRecord { t: "status"; id: string; field: string; value: unknown; at: string; run: string | null }

// §6.2 Telemetry
export type HandlerId = string; // "cpu.op", "cpu.cb", "ppu.oam", "ppu.fetcher", "ppu.fifo", "ppu.window", "ppu.sprites", "timer", "irq", "dma", "mbc1", "bus.io"
export interface TelemetryTap {
  onRegWrite?: (e: { addr: number; value: number; ly: number; dot: number; cycles: number }) => void;
  handlerHits(): Record<HandlerId, number>; // per frame, reset on read
  ppu(): { ly: number; mode: 0 | 1 | 2 | 3; dot: number; stat: number; lcdc: number };
}

// §6.1 Core API (core/index.ts exports createCore and HANDLERS with these types)
export interface CoreRegs { a: number; b: number; c: number; d: number; e: number; f: number; h: number; l: number; sp: number; pc: number }
export interface Core {
  step(): void; // one instruction or HALT idle step; advances timer/PPU/DMA; services an interrupt
  runFrame(): void; // until the PPU completes the next frame (LY 143 → 144)
  runToCounter(n: number, wramAddr?: number): boolean; // until the game's counter (§6.17) equals n; false on a 5-frame stall
  cpu: CoreRegs;
  read(addr: number): number; // bus read, no side effects
  frame(): Uint8Array; // 160*144 shades 0..3 (0 = white), last completed frame
  serial: string;
  cycles: number; // total T-cycles
  setButtons(mask: number): void; // bit0 right,1 left,2 up,3 down,4 A,5 B,6 select,7 start (1 = pressed)
  snapshot(): Uint8Array;
  restore(s: Uint8Array): void; // same-commit only; cross-commit resume replays the trace (N3)
  tap: TelemetryTap;
}
export type CreateCore = (rom: Uint8Array) => Core;
export type Handlers = Record<HandlerId, string>; // handler id → implementing file under core/

// §6.3 Provenance (ledger/provenance.json)
export interface ProvenanceEntry { handler: HandlerId; file: string; commit: string; attempt?: string; skill?: string }

// §6.4 Oracle protocol (oracle/frontend.py; one JSON object per line each way)
export type OracleReq =
  | { op: "load"; rom_path: string; align?: "counter" | "frame" } // align defaults to "counter" (S3)
  | { op: "run_to_counter"; counter: number; inputs: TraceInput[] } // applies inputs keyed by counter
  | { op: "frame" } // → { ok, shades_b64 } (23040 bytes)
  | { op: "ram"; addr: number; len: number } // WRAM 0xC000–0xDFFF only → { ok, bytes_b64 }
  | { op: "save" }
  | { op: "restore"; state_b64: string }
  | { op: "info" }; // → { ok, core: "SameBoy", version, model: "DMG", build_hash }
export type OracleRes = { ok: true; [k: string]: unknown } | { ok: false; error: string };
// run_to_counter → { ok, counter, stalled: boolean }

// §6.5 Trace and incident
export interface TraceInput { from_counter: number; mask: number } // mask holds until the next entry
export interface Trace {
  id: string; rom_sha: string; align: "counter" | "frame"; inputs: TraceInput[]; counter_end: number;
  source: "explorer" | "gemini" | "keyboard" | "sabotage" | "suite";
}
// align "counter": from_counter is the game's counter (§6.17); align "frame": the frame index since load
// traces/TRC-NNNN.json for admitted windows; $RATCHET_CACHE/traces/<sha>.json for working traces

export interface Incident {
  id: string; at: string; run: string | null;
  kind: "frame" | "logic"; align: "counter" | "frame";
  signature: { scene: number; band: number; bbox: [number, number, number, number] };
  rom_sha: string; trace_sha: string; window: [number, number]; // counters n-60 … n+120
  core_commit: string; counter: number; // first diverging counter n
  pixels: number;
  files: { dir: string }; // evidence/incidents/<id>/: core.png oracle.png diff.png regwrites.jsonl window.json
  source: "play" | "suite" | "sabotage";
  narration?: string; // nominates, never decides
  route?: Record<string, Record<string, number>>; // N7 router probabilities
  status: "open" | "repaired" | "unrepaired"; // status flip only
  spot?: { spot: string; subsystem: string; bbox: [number, number, number, number] | null; confidence: number }; // S13 sensor hint, status record
}

// §6.6 Repair task, attempt, result
export type Arm = "fast" | "candidate" | "baseline" | "placebo" | "vread-baseline" | "vread-ratchet";
export interface RepairTask {
  kind: "incident" | "family";
  incident?: string; // kind incident
  family?: string; // kind family: one H family (trial) or V family (vread)
  base_commit: string; // core-live commit
  arm: Arm;
  skills: string[]; // SKL ids shown
  budget: { max_steps: number; wall_s: number };
}
export interface RepairResult { // written by the repairer at packet/RESULT.json
  dispositions: Record<string, "applied" | "considered-not-applicable">;
  off_map: string | null; // a lesson relied on that no shown skill holds
  beliefs: { claim: string; false_if: string }[];
  summary: string; // one sentence: what the diff changes
}
export interface Attempt {
  id: string; at: string; run: string | null;
  task: RepairTask; branch: string; head_commit?: string;
  model: string; // echoed by the service
  result?: RepairResult; fires: string[];
  spent: { steps: number; wall_s: number; tokens_in: number; tokens_out: number; usd: number }; // usd priced from tokens by PRICES in loop/llm.ts
  scratch_files: string[]; // the allowlist the projection test asserts
  isolation: { home: string; skills_list: string; observers: "off" | "on-identical"; web_tools: "off" | "on" };
}

// §6.7 Observation, steer, spend
export interface Observation {
  id: string; at: string; run: string | null;
  anchor: { incident?: string; attempt: string; counter?: number };
  text: string; // written by loop/fast.ts for arm "fast" attempts only
}
// triage, appended by the consolidator as status records: field "shape" (string) and field "reducible" (boolean)
export interface Steer {
  id: string; at: string; run: string | null; text: string;
  vetoes?: string; // VER id
  latch_should_have_fired?: string; // SKL id
}
export interface SpendRecord {
  at: string; run: string | null; role: "consolidator" | "narrator" | "player" | "router" | "spotter";
  model: string; tokens_in: number; tokens_out: number; usd: number;
} // ledger/spend.jsonl

// §6.8 Readings and verdicts
export type Split = "base" | "T" | "H" | "V";
export interface SuiteReading { split: Split; family: string; roms: number; pass: number; exact: number; pixel_match: number /* mean, 0..1 */ }
export type CheckName = "diff-scope" | "repro" | "admitted-traces" | "base-suites" | "H-no-regress" | "trial-margin";
export interface Verdict {
  id: string; at: string; run: string | null;
  subject: { kind: "attempt" | "skill"; id: string };
  decision: "GRADUATE" | "REFUSE";
  checks: { name: CheckName; pass: boolean; reading: unknown }[];
  arms?: {
    candidate: SuiteReading[]; baseline: SuiteReading[]; placebo: SuiteReading[];
    margin: Record<string, number>; // per family, its unit
    n_family_runs_per_arm: number;
  };
  reason: string; // names the deciding check and its reading
  residue: string[]; // e.g. ["audio", "CGB", "serial timing", "V (sealed)", "boot-state difference"]
  rule_version: string;
  generation?: number; // skill verdicts: the slow-loop generation (runs/<run>/generations.jsonl) that ran the trial
}
// loop/gate.ts constants, declared at S0 with defaults, frozen when the run opens:
// H_TOLERANCE, MARGIN_FLOOR (per family), TRIAL_FAMILIES (2 H families), SUITE_MIN_GAIN, K, MAX_STEPS, MAX_ATTEMPTS, MAX_SHOWN, LITERAL_LIMIT

// §6.9 Skill frontmatter (skills/{shadow,graduated}/SKL-NNNN/SKILL.md)
export type SkillStatus = "shadow" | "graduated" | "tombstoned" | "retired";
export interface SkillFrontmatter {
  id: string; name: string; status: SkillStatus;
  activation: { "fires-when": string; "not-this": string; paths: string[]; owed: string };
  warrant: { anchors: string[]; "false-if": string };
  enforcement: { "checked-by": CheckName[]; residue: string };
  lifecycle: { consumer: "repairer"; "retire-when": string; successor: string | null };
}

// §6.10 Tombstone frontmatter (skills/tombstones/<id>.md)
export interface TombstoneFrontmatter { id: string; was: SkillStatus; verdict: string; reason: string; successor: string | null }

// Gemini visual sensor record (ledger/spots.jsonl, S13). It nominates, never decides (D-0004).
export interface Spot {
  id: string; at: string; run: string | null; kind: "scored" | "sensor-only" | "failed";
  counter: number; rom_sha: string; trace_sha: string; sampled_by: string;
  answer: unknown; truth: { diff: boolean; pixels: number; box: [number, number, number, number] | null };
  score: { outcome: "tp" | "fp" | "fn" | "tn"; iou: number | null; mislocated?: boolean };
  incident?: string; model: string; calls: number; tokens_in: number; tokens_out: number; ms: number; failure?: string;
}

// §6.11 Player action
export interface PlayerAction { mask: number; frames: number; intent: string }

// §6.12 Hook and fire
// .muse/hooks.json (shape measured at S0, D-0001; Claude-compatible). matcher keys on tool names only, so
// tools/fire.mjs reads tool_input.path from stdin JSON and checks it against the skill's activation.paths itself.
// Hook commands run in a cleared environment: ATTEMPT_ID and RATCHET_SERVER reach fire.mjs through the scratch repo
// (packet/ATTEMPT.json, read via cwd), not through the environment.
// { "hooks": { "PreToolUse": [ { "matcher": "edit_file", "hooks": [ { "type": "command", "command": "node tools/fire.mjs SKL-0003" } ] } ] } }
export interface HookCommand { type: "command"; command: string }
export interface HookMatcher { matcher: string; hooks: HookCommand[] }
export interface HooksFile { hooks: { PreToolUse?: HookMatcher[] } }
export interface HookStdin { tool_name: string; tool_input: { path?: string; [k: string]: unknown }; session_id: string; cwd: string }
export interface Fire { id: string; at: string; run: string | null; skill: string; attempt: string; path: string; owed: string }

// §6.13 Router question shapes (SubQ Snap, N7)
export interface RouterQuestion { type: "choice" | "noul"; instructions: string; criteria: Record<string, string | null> }

// §6.14 Decision frontmatter (ledger/decisions/D-NNNN-<slug>.md)
export interface DecisionFrontmatter { id: string; title: string; status: "draft" | "admitted" | "superseded"; supersedes: string | null }

// §6.15 Belief frontmatter (ledger/beliefs/BEL-NNNN-<slug>.md)
export interface BeliefFrontmatter { id: string; mark: "suspected" | "verified"; anchors: string[]; "contradicted-by": string[] }

// §6.16 Splits (splits.json)
export interface Splits {
  version: string;
  families: Record<string, { split: Split; roms: string[] /* globs under $RATCHET_ROMS */ }>;
  dmg_suffixes: string[];
  excluded: { rom: string; reason: string }[];
}

// §6.17 Game RAM contract
export const GAME_RAM = {
  counter: 0xc0f0, // 2 bytes, little-endian, written once per VBlank
  scene: 0xc0f2, // 1 byte: 0 title, 1–3 levels
  heroX: 0xc0f3, // 2 bytes, world pixels
  heroY: 0xc0f5, // 1 byte
  lives: 0xc0f6, // 1 byte
} as const;

// §6.19 Run records (runs/RUN-NNNN/)
export interface Manifest {
  id: string; opened_at: string; models: Record<string, string>; oracle: { core: string; build_hash: string };
  roms: Record<string, string>; splits_sha: string; rule_version: string; s0_sha: string; s_star_sha?: string; frozen_at?: string;
}
export interface Calibration { run: string; at: string; family: string; baseline_runs: [SuiteReading, SuiteReading]; spread: number; margin: number } // runs/RUN-NNNN/calibration.jsonl
export interface VReadLock { run: string; at: string; token: string } // runs/RUN-NNNN/vread.lock
export interface VRead {
  run: string; at: string; core_commit: string; s0_sha: string; s_star_sha: string;
  arms: { baseline: SuiteReading[]; ratchet: SuiteReading[] }; n_family_runs_per_arm: number; residue: string[];
} // runs/RUN-NNNN/vread.json

// §6.18 UI events (SSE, server/events.ts)
export type UiEvent =
  | { t: "frame"; source: "core" | "oracle"; shades_b64: string; counter: number }
  | { t: "meta"; pc: number; op: string; ly: number; mode: number; stat: number; ie: number; if_: number; hits: Record<string, number>; provenance: ProvenanceEntry[] }
  | { t: "player"; intent: string; mask: number }
  | { t: "incident"; incident: Incident }
  | { t: "attempt"; attempt: Attempt; phase: "start" | "progress" | "end"; note?: string }
  | { t: "verdict"; verdict: Verdict }
  | { t: "fire"; fire: Fire }
  | { t: "core"; commit: string; bundle_url: string } // N3 hot-swap
  | { t: "curve"; generation: number; arms: Verdict["arms"] }
  | { t: "vread"; result: VRead };
