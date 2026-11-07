// The Gemini visual sensor (S13, owner directive 2026-11-07). spot() shows the model one frame of OUR core,
// blind to the oracle, and asks whether it looks glitched, where, and which subsystem it suspects.
// spotDuring() runs lockstep (lockstep/lockstep.ts, unchanged) with a core wrapper that keeps the core's own
// frames, then sends (a) every frame-incident-opening counter, (b) a matched count of seeded-random clean
// counters and (c) every SPOT_EVERY-th counter. Only core frames reach the request; the oracle frame is read
// afterwards by player/spot-score.ts to score each answer, never sent.
// CLI: pnpm spot --rom <path> --trace <file.json> --core-dir <dir> [--every N] [--ledger <dir>] [--evidence <dir>]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { Core, Incident, Trace } from "../src/schema.ts";
import { oracleFrames, sha256, traceSha } from "../oracle/client.ts";
import { GAME_RAM, SCENE_OFFSET, signatureOf, frameDiff } from "../lockstep/diff.ts";
import { lockstep, type LockstepOptions, type LockstepResult } from "../lockstep/lockstep.ts";
import { ledgerDir } from "../loop/ledger.ts";
import { BOX_GRID, SPOT_MODEL, SPOT_SCALE, SPOT_THINKING, SUBSYSTEMS, checkAnswer, framePng, geminiClient, parseJsonObject, type VisionClient, type VisionRequest } from "./vision.ts";
import { recordSpot, truthOf, type Box, type SampledBy, type Spot, type SpotAnswer } from "./spot-score.ts";

/** Send every Nth counter besides openings and controls. 60 is one per second of game time; not tuned. */
export const SPOT_EVERY = 60;
/** Seed of the control sampler (mulberry32), so a rerun picks the same clean counters. */
export const SPOT_SEED = 0x5eed;
/** Calls per frame: one ask plus one parse-and-retry (owner brief, S13). */
export const SPOT_ATTEMPTS = 2;

export interface SpotContext { counter: number; scene?: number }
export interface SpotResult { answer: SpotAnswer | null; failure?: string; model: string; calls: number; tokens_in: number; tokens_out: number; ms: number }

const W = 160, H = 144;

export function spotPrompt(ctx: SpotContext): string {
  const crit = "ppu_fetcher: pixels shifted or wrong within a line; stat_irq: a raster split lands on the wrong line; " +
    "oam_dma: sprites missing or stale; window: window position or line counter wrong; timer: timing-dependent state off; other: none of these.";
  return [
    `This is one frame (frame counter ${ctx.counter}${ctx.scene !== undefined ? `, scene ${ctx.scene}` : ""}) from a Game Boy (DMG) emulator running a simple platformer.`,
    `The screen is 160x144 pixels in 4 grey shades, shown here scaled ${SPOT_SCALE}x. The emulator may have bugs.`,
    "Does this frame look glitched: a band of wrong or inverted shades, tiles torn or shifted within a line, sprites missing or doubled, a misplaced window, garbage tiles?",
    `Reply with JSON: glitch (boolean), confidence (0..1), bbox [x0, y0, x1, y1] of the glitched region on a 0..${BOX_GRID} grid of the image in both axes (x right, y down), or null if no glitch, ` +
      `subsystem (one of ${SUBSYSTEMS.join(", ")}) that most likely produced it (${crit}), and why (one sentence).`,
    "Judge only what you see. A plain, clean-looking frame is not glitched.",
  ].join("\n");
}

/** One model box on the BOX_GRID mapped to frame pixels, clamped to the screen and ordered. */
export function toFrameBox(b: [number, number, number, number]): Box {
  const cx = (v: number) => Math.min(W, Math.max(0, (v * W) / BOX_GRID));
  const cy = (v: number) => Math.min(H, Math.max(0, (v * H) / BOX_GRID));
  const [x0, x1] = [cx(b[0]), cx(b[2])].sort((p, q) => p - q);
  const [y0, y1] = [cy(b[1]), cy(b[3])].sort((p, q) => p - q);
  return [x0, y0, x1, y1];
}

/** Asks the vision client about one core frame; one parse-and-retry, then a recorded failure. */
export async function spot(frameShades: Uint8Array, context: SpotContext, client: VisionClient = geminiClient()): Promise<SpotResult> {
  const base: VisionRequest = { model: SPOT_MODEL, thinking: SPOT_THINKING, prompt: spotPrompt(context), image: { mime_type: "image/png", data: framePng(frameShades).toString("base64") } };
  let model = SPOT_MODEL, tokens_in = 0, tokens_out = 0, ms = 0, calls = 0, failure = "";
  for (let attempt = 0; attempt < SPOT_ATTEMPTS; attempt++) {
    const req = attempt === 0 ? base : { ...base, prompt: `${base.prompt}\nYour last reply did not parse (${failure}). Reply with one JSON object only.` };
    calls++;
    let reply;
    try { reply = await client(req); } catch (e) { failure = `call failed: ${String((e as Error).message ?? e)}`; continue; }
    model = reply.model; tokens_in += reply.tokens_in; tokens_out += reply.tokens_out; ms += reply.ms;
    try {
      const a = checkAnswer(parseJsonObject(reply.text));
      const answer: SpotAnswer = { ...a, bbox: a.glitch && a.bbox ? toFrameBox(a.bbox) : null };
      return { answer, model, calls, tokens_in, tokens_out, ms };
    } catch (e) { failure = String((e as Error).message ?? e); }
  }
  return { answer: null, failure, model, calls, tokens_in, tokens_out, ms };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The counters to send and why: openings, a matched count of seeded clean controls, and every `every`-th. */
export function sampleCounters(o: { counters: number[]; openings: number[]; clean: Set<number>; every: number; seed: number }): Map<number, SampledBy[]> {
  const out = new Map<number, SampledBy[]>();
  const add = (n: number, why: SampledBy) => out.set(n, [...(out.get(n) ?? []), why]);
  for (const n of o.openings) add(n, "opening");
  for (const n of o.counters) if (n % o.every === 0) add(n, "every");
  const pool = o.counters.filter((n) => o.clean.has(n) && !out.has(n));
  const rand = mulberry32(o.seed);
  for (let k = 0; k < o.openings.length && pool.length; k++) add(pool.splice(Math.floor(rand() * pool.length), 1)[0], "control");
  return new Map([...out.entries()].sort((a, b) => a[0] - b[0]));
}

export interface SpotDuringOptions { every?: number; seed?: number; client?: VisionClient; ledger?: string }
export interface SpotDuringResult { lockstep: LockstepResult; spots: Spot[] }

/** Runs lockstep with the sampler; appends one SPT record per sent counter to `ledger`. */
export async function spotDuring(run: LockstepOptions, o: SpotDuringOptions = {}): Promise<SpotDuringResult> {
  const every = o.every ?? SPOT_EVERY;
  const dir = o.ledger ?? ledgerDir();
  const client = o.client ?? geminiClient(dir);
  const frames = new Map<number, { shades: Uint8Array; scene: number }>();
  const wrapped: LockstepOptions = {
    ...run,
    createCore: (rom) => {
      const c: Core = run.createCore(rom);
      let n = 0;
      const runToCounter = c.runToCounter.bind(c), runFrame = c.runFrame.bind(c), frame = c.frame.bind(c);
      c.runFrame = () => { runFrame(); n++; };
      c.runToCounter = (k, addr) => { const ok = runToCounter(k, addr); n = k; return ok; };
      c.frame = () => {
        const f = frame();
        frames.set(n, { shades: f.slice(), scene: c.read(GAME_RAM.addr + SCENE_OFFSET) & 0xff });
        return f;
      };
      return c;
    },
  };
  const res = await lockstep(wrapped);

  const rom_sha = sha256(readFileSync(run.romPath));
  const trace_sha = traceSha({ rom_sha, align: run.trace.align, inputs: run.trace.inputs });
  const counters = [...frames.keys()].sort((a, b) => a - b);
  const oracle = await oracleFrames(run.romPath, run.trace, counters); // cached by lockstep; the scorer's alone
  const truth = new Map(counters.map((n) => [n, truthOf(frames.get(n)!.shades, oracle.get(n)!)]));
  const clean = new Set(counters.filter((n) => !truth.get(n)!.diff));
  const frameIncidents: Incident[] = [...res.opened, ...run.sink.open()].filter((i, k, a) => i.kind === "frame" && i.rom_sha === rom_sha && a.findIndex((j) => j.id === i.id) === k);
  const openings = res.opened.filter((i) => i.kind === "frame").map((i) => i.counter);
  const plan = sampleCounters({ counters, openings, clean, every, seed: o.seed ?? SPOT_SEED });

  const attached = new Set<string>();
  const spots: Spot[] = [];
  for (const [n, sampled_by] of plan) {
    const { shades, scene } = frames.get(n)!;
    const r = await spot(shades, { counter: n, scene }, client);
    const t = truth.get(n)!;
    let incident: string | undefined;
    if (t.diff) {
      const sig = signatureOf(scene, frameDiff(shades, oracle.get(n)!));
      incident = frameIncidents.find((i) => i.signature.band === sig.band && i.signature.bbox.join() === sig.bbox.join())?.id;
    }
    const rec = recordSpot({ counter: n, rom_sha, trace_sha, sampled_by, answer: r.answer, truth: t, incident, model: r.model, calls: r.calls, tokens_in: r.tokens_in, tokens_out: r.tokens_out, ms: r.ms, failure: r.failure, attach: !!incident && !attached.has(incident) }, dir);
    if (rec.score.outcome === "tp" && incident) attached.add(incident);
    spots.push(rec);
  }
  return { lockstep: res, spots };
}

function commitOf(dir: string): string {
  try { return execFileSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return "unknown"; }
}

async function main(): Promise<number> {
  const { values: v } = parseArgs({ options: { rom: { type: "string" }, trace: { type: "string" }, "core-dir": { type: "string" }, every: { type: "string" }, ledger: { type: "string" }, evidence: { type: "string" } } });
  if (!v.rom || !v.trace || !v["core-dir"] || (v.every && !(Number(v.every) >= 1))) {
    console.error("usage: player/spot.ts --rom <path> --trace <file.json> --core-dir <dir> [--every N] [--ledger <dir>] [--evidence <dir>]");
    return 2;
  }
  const { loadCreateCore } = await import("../lockstep/core-dir.ts");
  const { LedgerIncidentSink } = await import("../loop/incident-sink.ts");
  const { spotSummary } = await import("./spot-score.ts");
  const dir = resolve(v.ledger ?? ledgerDir());
  const trace = JSON.parse(readFileSync(v.trace, "utf8")) as Trace;
  const res = await spotDuring({
    romPath: v.rom, trace, createCore: await loadCreateCore(v["core-dir"]), coreCommit: commitOf(v["core-dir"]),
    sink: new LedgerIncidentSink(dir), source: trace.source === "sabotage" ? "sabotage" : "play", run: process.env.RATCHET_RUN ?? null,
    ...(v.evidence ? { evidenceRoot: resolve(v.evidence) } : {}),
  }, { every: v.every ? Number(v.every) : undefined, ledger: dir });
  for (const s of res.spots)
    console.log(JSON.stringify({ id: s.id, counter: s.counter, sampled_by: s.sampled_by, outcome: s.score.outcome, iou: s.score.iou, glitch: s.answer?.glitch, confidence: s.answer?.confidence, bbox: s.answer?.bbox?.map((x) => Math.round(x)), truth_box: s.truth.box, subsystem: s.answer?.subsystem, model: s.model, calls: s.calls, tokens_in: s.tokens_in, tokens_out: s.tokens_out, ms: s.ms, incident: s.incident, failure: s.failure }));
  console.log(JSON.stringify({ opened: res.lockstep.opened.map((i) => i.id), summary: spotSummary(dir) }));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(); } catch (e) { console.error(String(e instanceof Error ? e.message : e)); process.exitCode = 2; }
}
