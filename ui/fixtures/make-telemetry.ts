// `node ui/fixtures/make-telemetry.ts`: writes ui/fixtures/runs/prerun/telemetry/*.jsonl, a synthetic recorded session
// timed around the fixture ledger (ui/fixtures/ledger, 12:01–12:40 on 2026-11-07), so `pnpm replay:fixtures` has every
// stream to play: process start/stop, core frames (fixture core test pattern, one per FIXTURE_FRAME_EVERY_S) and meta,
// input masks, player llm calls, Muse MSP records for ATT-0001 and ATT-0002, loop steps and spotter answers.
// The records are fixtures, not readings; they enter no figure (G9).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testPattern, LCD_W, LCD_H } from "./core.ts";
import { packFrame } from "../../server/compact.ts";

/** Seconds between fixture core frames; sparser than TELEMETRY_FRAME_HZ to keep the fixture small. */
export const FIXTURE_FRAME_EVERY_S = 10;
const T0 = Date.parse("2026-11-07T12:00:00Z");
const T1 = Date.parse("2026-11-07T12:42:00Z");
const dir = join(import.meta.dirname, "runs", "prerun", "telemetry");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const out: Record<string, string[]> = {};
let seq = 0;
const put = (t: number, stream: string, kind: string, data: unknown) => (out[stream] ??= []).push(JSON.stringify({ at: new Date(t).toISOString(), seq: seq++, pid: 4242, run: null, stream, kind, data }));

put(T0, "process", "start", { name: "server", argv: ["server/index.ts"], head: "f1c7e00", node: "v22.12.0", cwd: "/ratchet", env_names: ["GEMINI_API_KEY", "META_API_KEY", "PATH", "RATCHET_RUN"] });
const fb = new Uint8Array(LCD_W * LCD_H);
let mask = 0;
for (let t = T0 + 1000; t < T1; t += 1000) {
  const s = (t - T0) / 1000;
  const counter = (s * 60) & 0xffff;
  if (s % 20 === 0) {
    mask = [0, 1, 2, 4, 8, 16][(s / 20) % 6];
    put(t, "input", "mask", { counter, mask, source: s % 40 === 0 ? "keyboard" : "gemini" });
    put(t, "ui", "player", { origin: "producer", event: { t: "player", intent: mask ? "explore" : "idle", mask } });
  }
  if (s % FIXTURE_FRAME_EVERY_S === 0) {
    testPattern(fb, s * 60, 8 + (s % 136), 16 + ((s * 3) % 112));
    put(t, "ui", "frame", { origin: "producer", ...packFrame({ t: "frame", source: "core", shades_b64: Buffer.from(fb).toString("base64"), counter }) });
    put(t, "ui", "meta", { origin: "producer", event: { t: "meta", pc: 0x150 + (s % 8), op: "LD A,($FF44)", ly: (s * 37) % 154, mode: s % 4, stat: 0x80 | (s % 4), ie: 1, if_: s % 2, hits: { "cpu.op": 8778, "ppu.fetcher": 2880, "ppu.fifo": 23040, irq: 1 + (s % 3) }, provenance: [] } });
  }
  if (s % 120 === 30) {
    put(t, "llm", "call", { role: "player", model: "gemini-2.5-flash", model_echoed: "gemini-2.5-flash-001", request: { headers: { authorization: "[redacted]" }, prompt: `Frame at counter ${counter}. Which button next?` }, response: '{"intent":"explore","mask":1}', tokens: { in: 812, out: 14 }, wall_ms: 640, outcome: "ok" });
    put(t + 700, "spot", "answer", { question: "Does the HUD look torn?", answer: s % 240 === 30 ? "yes, top band" : "no", oracle: { diff_px: s % 240 === 30 ? 1280 : 0 }, scored: "agree" });
  }
}
const at = (iso: string) => Date.parse(iso);
put(at("2026-11-07T12:01:00Z") + 50, "loop", "incident-picked", { incident: "INC-0001", prior_attempts: 0, kind: "frame", counter: 300 });
for (const [att, start, end, verdict, decision] of [["ATT-0001", "12:10:00", "12:12:00", "VER-0001", "REFUSE"], ["ATT-0002", "12:20:00", "12:29:00", "VER-0002", "GRADUATE"]] as const) {
  const s = at(`2026-11-07T${start}Z`), e = at(`2026-11-07T${end}Z`);
  put(s + 10, "loop", "attempt-start", { attempt: att, incident: "INC-0001", base_commit: "f1x7ure", skills: att === "ATT-0002" ? ["SKL-0002"] : [] });
  for (let k = 0; k < 6; k++) put(s + 20 + k * ((e - s - 60_000) / 6), "muse", "msp", { attempt: att, record: { schema_version: 1, stream: att, record_type: "event", payload: k === 0 ? { kind: "run_model_configured", model_id: "muse-code-1" } : k === 5 ? { kind: "run_usage", model: "muse-code-1", input_tokens: 41_000, output_tokens: 2_100 } : { kind: "tool_call", tool: k % 2 ? "read_file" : "edit_file", path: "core/ppu.ts" } } });
  for (const [k, name] of ["diff-scope", "repro", "admitted-traces", "base-suites", "H-no-regress"].entries()) put(e - 50_000 + k * 9000, "loop", "gate-check", { attempt: att, name, pass: !(decision === "REFUSE" && name === "H-no-regress") });
  put(e - 5, "loop", "attempt-end", { attempt: att, verdict, decision, model: "muse-code-1" });
  put(e, "loop", "verdict", { attempt: att, verdict, decision });
}
put(T1, "process", "stop", { name: "server", code: 0, uptime_s: (T1 - T0) / 1000 });

let bytes = 0;
for (const [s, lines] of Object.entries(out)) { const text = lines.join("\n") + "\n"; bytes += text.length; writeFileSync(join(dir, `${s}.jsonl`), text); }
console.log(`fixture telemetry: ${seq} records, ${bytes} bytes in ${dir}`);
