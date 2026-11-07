// The campaign (SPEC §5 S10). `pnpm campaign [--resume] [--minutes M] [--dry] [--allow-nonempty-s0]` opens RUN-0001 and runs it:
//   open      writes runs/RUN-0001/manifest.json (loop/run-records.ts) with O_EXCL; refuses when it exists unless --resume,
//             and refuses a first open while skills/graduated or policies/graduated holds a member (S₀ must be ∅,
//             run-records.ts sMembers) unless the owner passes --allow-nonempty-s0.
//             Every record written after carries run RUN-0001 (RATCHET_RUN is set in this process and its children).
//   play      explorer segments with rotating seeds (CAMPAIGN_SEED0 + segment index) → lockstep against core-live's
//             core, spot sampling every CAMPAIGN_SPOT_EVERY-th counter (player/spot.ts), incidents into the ledger;
//   route     SubQ route() on each new incident (S17's hook, called here and not in loop/fast.ts);
//   narrate   one Gemini sentence per new incident, best-effort;
//   fast      the open incident whose box covers the parallax lines first (SPEC §7.8), then the largest pixel count;
//             at most CAMPAIGN_PARALLEL attempts at once, MAX_ATTEMPTS per incident (loop/fast.ts), the gate step
//             serialised through one mutex because every gate works in the one live clone; an attempt that throws
//             counts against MAX_ATTEMPTS (its ATT, or an attempt-error record when it threw before minting one),
//             and at MAX_ATTEMPTS the incident is parked: status records "parked" then status unrepaired
//             (campaign.test.ts "throws before minting");
//   slow      one slow-loop generation (loop/slow.ts runGeneration) whenever generationsDue says one is owed (every K);
//   spend     before every attempt, server/spend.ts's meter: at SPEND_ASK_USD a `pause` record and "owner gate: spend $X",
//             no new attempt until a steer "resume spend" (pnpm steer "resume spend") written after the pause; at
//             SPEND_STOP_USD a `stop` record and the campaign ends once in-flight attempts finish.
//   freeze    once runs/<run>/manifest.json holds s_star_sha (pnpm freeze), the loop starts nothing more and stops when
//             in-flight attempts finish (campaign.test.ts "frozen run").
// The campaign's own records (open, segment, pause, resume, attempt-error, park, stop) go to runs/<run>/campaign.jsonl.
// --dry runs the same loop on a scratch test bed (loop/fixtures/harness.ts) with the fake runner, a fake SubQ client,
// fake play that opens DRY_INCIDENTS incidents and no Gemini, and stops when the deadline passes or nothing is left.

import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { K, MAX_ATTEMPTS } from "./gate.ts";
import { all, appendNew, current, status } from "./ledger.ts";
import { pathsFromEnv, type LoopPaths } from "./paths.ts";
import { openIncidents, runFastCycle, type CycleOutput } from "./fast.ts";
import { generationsDue } from "./slow.ts";
import { buildManifest, manifestPath, openManifest, readManifest, RUN_ID, sDirs, sMembers } from "./run-records.ts";
import { meterLine, spendGate, spendMeter, type SpendMeter } from "../server/spend.ts";
import { tlog } from "../src/telemetry.ts";
import type { Attempt, Incident, Manifest, Steer } from "../src/schema.ts";

/** Attempts in flight at once. S8 Wiggle allows 3; the gate step is serialised (gateLock), the repairs run in parallel. */
export const CAMPAIGN_PARALLEL = 3;
/** First explorer seed; segment i plays seed CAMPAIGN_SEED0 + i, so no two segments replay one trace. */
export const CAMPAIGN_SEED0 = 1001;
/** Game frames per explorer segment: 60 s of play, so new incidents reach the queue between attempts. */
export const SEGMENT_FRAMES = 60 * 60;
/** Spot sampling: every Nth counter besides openings and controls; 600 is one per 10 s of game time, kept cheap. */
export const CAMPAIGN_SPOT_EVERY = 600;
/** Milliseconds the loop sleeps when it has nothing to start. */
export const POLL_MS = 2000;
/** Game lines the parallax SCX bands cover, [first, end): cloud from line 16 and mountain from 32, playfield from 48 (game/src/main.c SPLIT_HUD_END, SPLIT_PLAY). */
export const PARALLAX_LINES: readonly [number, number] = [16, 48];
/** The steer text that lifts an owner-gate pause. */
export const RESUME_STEER = "resume spend";
/** Incidents the dry run's fake play opens. */
export const DRY_INCIDENTS = 3;

export type CampaignRecord =
  | { t: "open"; at: string; run: string; manifest: string; resumed: boolean }
  | { t: "segment"; at: string; run: string; seed: number; opened: string[]; error?: string }
  | { t: "pause"; at: string; run: string; usd: number; source: SpendMeter["source"]; priced_usd: number; owner_read_usd: number | null }
  | { t: "resume"; at: string; run: string; steer: string }
  /** An attempt that threw; `minted` says whether it wrote its ATT before throwing. */
  | { t: "attempt-error"; at: string; run: string; incident: string; minted: boolean; error: string }
  | { t: "park"; at: string; run: string; incident: string; early_throws: number; attempts: number }
  | { t: "stop"; at: string; run: string; reason: string; attempts: number };

export interface CampaignDeps {
  paths: LoopPaths; run: string; runsDir: string;
  /** One play segment at `seed`; returns the incidents it opened. `exhausted` says play has nothing more (dry). */
  play(seed: number): Promise<{ opened: Incident[]; exhausted?: boolean }>;
  route(inc: Incident): Promise<unknown>;
  narrate(inc: Incident): Promise<unknown>;
  fast(incidentId: string, gateLock: <T>(fn: () => Promise<T>) => Promise<T>): Promise<CycleOutput>;
  slow(): Promise<unknown>;
  minutes: number;
  /** Stop once play is exhausted and no incident is open (dry). */
  stopWhenIdle?: boolean;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (s: string) => void;
}

export interface CampaignOutput { attempts: CycleOutput[]; segments: number; paused: boolean; stopped: string; records: CampaignRecord[] }

export function campaignFile(runsDir: string, run: string): string { return join(runsDir, run, "campaign.jsonl"); }

export function readCampaign(runsDir: string, run: string): CampaignRecord[] {
  const f = campaignFile(runsDir, run);
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as CampaignRecord);
}

function record(runsDir: string, run: string, r: CampaignRecord): CampaignRecord {
  mkdirSync(join(runsDir, run), { recursive: true });
  appendFileSync(campaignFile(runsDir, run), JSON.stringify(r) + "\n");
  tlog("loop", `campaign.${r.t}`, r);
  return r;
}

/** True when an incident's box overlaps the parallax lines (SPEC §7.8: the 1 px parallax SCX shift is first). */
export function coversParallax(inc: Pick<Incident, "kind" | "signature">): boolean {
  const [, y0, , y1] = inc.signature.bbox;
  return inc.kind === "frame" && y0 < PARALLAX_LINES[1] && y1 > PARALLAX_LINES[0];
}

/** The next incident to attempt: open frame incidents first, those covering the parallax lines first, then most pixels, then oldest id. */
export function pickIncident(open: Incident[], busy: Set<string>): Incident | undefined {
  const c = open.filter((i) => !busy.has(i.id));
  const rank = (i: Incident) => [i.kind === "frame" ? 0 : 1, coversParallax(i) ? 0 : 1, -i.pixels] as const;
  return c.sort((a, b) => { const ra = rank(a), rb = rank(b); for (let k = 0; k < 3; k++) if (ra[k] !== rb[k]) return ra[k] - rb[k]; return a.id.localeCompare(b.id); })[0];
}

/** A steer "resume spend" written after `pauseAt`, if any. */
export function resumeSteer(ledger: string, pauseAt: string): Steer | undefined {
  return all<Steer>("steers.jsonl", ledger).find((s) => s.text.trim().toLowerCase() === RESUME_STEER && Date.parse(s.at) > Date.parse(pauseAt));
}

/** A promise-chain mutex. */
export function mutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>) => { const p = tail.then(fn, fn); tail = p.catch(() => {}); return p; };
}

/** The campaign loop (see the file header). The run must already be open (openRun). */
export async function runCampaign(d: CampaignDeps): Promise<CampaignOutput> {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = d.log ?? ((s: string) => console.log(s));
  const deadline = now() + d.minutes * 60_000;
  const prior = readCampaign(d.runsDir, d.run);
  let segments = prior.filter((r) => r.t === "segment").length;
  // an owner-gate pause already lifted by a resume record stays lifted across --resume
  let lastPause = [...prior].reverse().find((r) => r.t === "pause") as Extract<CampaignRecord, { t: "pause" }> | undefined;
  let askLifted = !!lastPause && prior.lastIndexOf(lastPause) < prior.findLastIndex((r) => r.t === "resume");
  let paused = !!lastPause && !askLifted;
  const gateLock = mutex();
  const inflight = new Map<string, Promise<void>>();
  const done: CycleOutput[] = [];
  let slowRun: Promise<void> | null = null;
  let exhausted = false;
  let stopped = "";

  // an attempt that throws counts against MAX_ATTEMPTS: its ATT if it minted one, else its attempt-error record;
  // at MAX_ATTEMPTS the incident is parked: a "parked" status record, then status unrepaired
  const attemptFailed = (incident: string, minted: boolean, error: string) => {
    record(d.runsDir, d.run, { t: "attempt-error", at: new Date(now()).toISOString(), run: d.run, incident, minted, error });
    const early_throws = readCampaign(d.runsDir, d.run).filter((r) => r.t === "attempt-error" && r.incident === incident && !r.minted).length;
    const attempts = attemptsOn(incident);
    if (attempts + early_throws < MAX_ATTEMPTS || current<Incident>("incidents.jsonl", incident, d.paths.ledger)?.status !== "open") return;
    status("incidents.jsonl", incident, "parked", { at: new Date(now()).toISOString(), early_throws, attempts, error }, d.paths.ledger);
    status("incidents.jsonl", incident, "status", "unrepaired", d.paths.ledger);
    record(d.runsDir, d.run, { t: "park", at: new Date(now()).toISOString(), run: d.run, incident, early_throws, attempts });
    log(`${incident} parked unrepaired: ${attempts} attempts and ${early_throws} early throws reach MAX_ATTEMPTS ${MAX_ATTEMPTS}`);
  };
  const attemptsOn = (id: string) => all<Attempt>("attempts.jsonl", d.paths.ledger).filter((a) => a.task.incident === id).length;
  const startAttempt = (inc: Incident) => {
    const before = attemptsOn(inc.id);
    const p = (async () => {
      try {
        const r = await d.fast(inc.id, gateLock);
        done.push(r);
        log(`${r.attempt.id} on ${inc.id}: ${r.verdict.id} ${r.verdict.decision} (${r.verdict.reason})`);
      } catch (e) {
        const error = String((e as Error)?.message ?? e).split("\n")[0].slice(0, 300);
        log(`attempt on ${inc.id} failed: ${error}`);
        tlog("loop", "campaign.attempt-failed", { incident: inc.id, error });
        attemptFailed(inc.id, attemptsOn(inc.id) > before, error);
      }
      finally { inflight.delete(inc.id); }
    })();
    inflight.set(inc.id, p);
  };

  while (!stopped) {
    if (now() >= deadline) { stopped = `deadline: ${d.minutes} min`; break; }
    // curve freeze ends learning: no attempt and no slow generation starts once the manifest holds s_star_sha
    const frozen = readManifest(d.runsDir, d.run);
    if (frozen?.s_star_sha) { stopped = `frozen at ${frozen.frozen_at}: s_star_sha ${frozen.s_star_sha.slice(0, 12)}`; break; }
    let did = false;

    // play one segment; route and narrate what it opened
    if (!exhausted) {
      const seed = CAMPAIGN_SEED0 + segments;
      let opened: Incident[] = [], error: string | undefined;
      try { const r = await d.play(seed); opened = r.opened; exhausted = !!r.exhausted; } catch (e) { error = (e as Error).message; }
      segments++;
      record(d.runsDir, d.run, { t: "segment", at: new Date(now()).toISOString(), run: d.run, seed, opened: opened.map((i) => i.id), ...(error ? { error } : {}) });
      for (const inc of opened) {
        try { await d.route(inc); } catch (e) { log(`route ${inc.id} failed: ${(e as Error).message}`); }
        try { await d.narrate(inc); } catch (e) { log(`narrate ${inc.id} skipped: ${(e as Error).message}`); }
      }
      did = opened.length > 0 || !exhausted;
    }

    // fill the attempt slots, the spend guard first before each
    while (inflight.size < CAMPAIGN_PARALLEL) {
      const m = spendMeter({ ledger: d.paths.ledger, runsDir: d.runsDir, run: d.run, env: d.env });
      const g = spendGate(m.usd);
      if (g === "stop") { stopped = `spend stop: $${m.usd.toFixed(2)} (${m.source}) ≥ $${m.stop_usd}`; log(meterLine(m)); break; }
      if (g === "ask" && !askLifted) {
        if (!paused) {
          lastPause = record(d.runsDir, d.run, { t: "pause", at: new Date(now()).toISOString(), run: d.run, usd: m.usd, source: m.source, priced_usd: m.priced_usd, owner_read_usd: m.owner_read_usd }) as Extract<CampaignRecord, { t: "pause" }>;
          paused = true;
          log(`owner gate: spend $${m.usd.toFixed(2)}`);
          log(meterLine(m));
        }
        const s = resumeSteer(d.paths.ledger, lastPause!.at);
        if (!s) break;
        record(d.runsDir, d.run, { t: "resume", at: new Date(now()).toISOString(), run: d.run, steer: s.id });
        paused = false; askLifted = true;
        log(`owner gate lifted by ${s.id}`);
      }
      const inc = pickIncident(openIncidents(d.paths), new Set(inflight.keys()));
      if (!inc) break;
      startAttempt(inc);
      did = true;
    }
    if (stopped) break;

    // the slow loop, one generation at a time, beside the fast loop
    if (!slowRun && generationsDue({ paths: d.paths, runsDir: d.runsDir, run: d.run }) > 0) {
      slowRun = (async () => { try { await d.slow(); } catch (e) { log(`slow generation failed: ${(e as Error).message}`); } finally { slowRun = null; } })();
      did = true;
    }

    if (d.stopWhenIdle && exhausted && !inflight.size && !slowRun && !openIncidents(d.paths).length) { stopped = "idle: play exhausted and no open incident"; break; }
    if (!did || exhausted) await Promise.race([sleep(POLL_MS), ...inflight.values()]);
  }
  await Promise.all(inflight.values());
  if (slowRun) await slowRun;
  record(d.runsDir, d.run, { t: "stop", at: new Date(now()).toISOString(), run: d.run, reason: stopped, attempts: done.length });
  log(`campaign stopped: ${stopped}; ${done.length} attempts, ${segments} segments`);
  return { attempts: done, segments, paused, stopped, records: readCampaign(d.runsDir, d.run) };
}

export interface OpenOptions {
  runsDir: string; run: string; resume: boolean; build: () => Promise<Manifest> | Manifest;
  /** The S dirs (run-records.ts sDirs); a first open refuses when they hold any member (sMembers): the curve starts at S₀ = ∅. */
  s0Dirs?: string[];
  /** The owner's --allow-nonempty-s0: opens the run over a non-empty S₀. */
  allowNonEmptyS0?: boolean;
}

/**
 * Opens the run: writes the manifest, or with --resume reads the existing one. Throws when it exists without --resume,
 * and on a first open when s0Dirs hold a graduated skill or policy, unless allowNonEmptyS0 (campaign.test.ts "S0 is not empty").
 */
export async function openRun(o: OpenOptions): Promise<Manifest> {
  const existing = readManifest(o.runsDir, o.run);
  if (existing) {
    if (!o.resume) throw new Error(`${manifestPath(o.runsDir, o.run)} exists: the run is already open (pass --resume to continue it)`);
    record(o.runsDir, o.run, { t: "open", at: new Date().toISOString(), run: o.run, manifest: manifestPath(o.runsDir, o.run), resumed: true });
    return existing;
  }
  if (o.resume) throw new Error(`--resume: ${manifestPath(o.runsDir, o.run)} does not exist`);
  const s0 = o.s0Dirs ? sMembers(o.s0Dirs) : [];
  if (s0.length && !o.allowNonEmptyS0) throw new Error(`S0 is not empty (${s0.slice(0, 6).join(", ")}${s0.length > 6 ? ", …" : ""}): the curve starts at S0 = ∅; retire them first, or pass --allow-nonempty-s0`);
  const m = await o.build();
  const p = openManifest(o.runsDir, m);
  record(o.runsDir, o.run, { t: "open", at: m.opened_at, run: o.run, manifest: p, resumed: false });
  return m;
}

// ---------- real and dry wiring ----------

function child(cmd: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number; out: string; err: string }> {
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (b) => { out += b; });
    p.stderr.on("data", (b) => { err += b; });
    p.on("close", (code) => res({ code: code ?? 1, out, err }));
  });
}

/** Real play: an explorer trace at `seed`, then player/spot.ts (lockstep plus spot sampling) in a child process against the live clone's core. */
function realPlay(paths: LoopPaths, env: NodeJS.ProcessEnv): CampaignDeps["play"] {
  return async (seed) => {
    const { explorerTrace } = await import("../player/explore.ts");
    const { ratchetCache, sha256, traceSha } = await import("../oracle/client.ts");
    const romPath = join(paths.root, "game", "game.gb");
    const trace = explorerTrace({ rom_sha: sha256(readFileSync(romPath)), frames: SEGMENT_FRAMES, seed });
    const dir = join(ratchetCache(), "traces");
    mkdirSync(dir, { recursive: true });
    const tp = join(dir, `${traceSha(trace)}.json`);
    writeFileSync(tp, JSON.stringify(trace) + "\n");
    const before = new Set(all<Incident>("incidents.jsonl", paths.ledger).map((i) => i.id));
    const coreDir = join(paths.live, "core");
    let r = await child(process.execPath, [join(paths.root, "player", "spot.ts"), "--rom", romPath, "--trace", tp, "--core-dir", coreDir, "--every", String(CAMPAIGN_SPOT_EVERY), "--ledger", paths.ledger], env, paths.root);
    if (r.code !== 0) r = await child(process.execPath, [join(paths.root, "lockstep", "run.ts"), "--rom", romPath, "--trace", tp, "--core-dir", coreDir, "--ledger", paths.ledger], env, paths.root);
    if (r.code === 2) throw new Error(`lockstep failed: ${r.err.trim().split("\n").pop()}`);
    return { opened: all<Incident>("incidents.jsonl", paths.ledger).filter((i) => !before.has(i.id)) };
  };
}

/** The dry bed's fake play: each of the first DRY_INCIDENTS segments opens one incident cloned from the bed's INC-0001 with its own band. */
export function dryPlay(paths: LoopPaths, n = DRY_INCIDENTS): CampaignDeps["play"] {
  let made = 0;
  return async () => {
    if (made >= n) return { opened: [], exhausted: true };
    made++;
    const base = current<Incident>("incidents.jsonl", "INC-0001", paths.ledger)!;
    if (made === 1) return { opened: [base], exhausted: made >= n };
    const band = made + 1;
    const inc = appendNew<Incident>("incidents.jsonl", "INC", (id) => {
      const x: Incident = { ...base, id, at: new Date().toISOString(), run: process.env.RATCHET_RUN ?? null, status: "open", signature: { ...base.signature, band, bbox: [0, band * 8, 160, band * 8 + 8] }, pixels: 160 * 8 * made, files: { dir: `evidence/incidents/${id}` } };
      delete (x as Partial<Incident>).route;
      const src = join(paths.evidence, "incidents", "INC-0001"), dst = join(paths.evidence, "incidents", id);
      cpSync(src, dst, { recursive: true });
      const w = JSON.parse(readFileSync(join(dst, "window.json"), "utf8"));
      writeFileSync(join(dst, "window.json"), JSON.stringify({ ...w, incident: x }));
      return x;
    }, paths.ledger);
    return { opened: [inc], exhausted: made >= n };
  };
}

export async function dryDeps(minutes: number): Promise<{ deps: CampaignDeps; manifest: () => Manifest }> {
  const { makeBed, setShade, FIX } = await import("./fixtures/harness.ts");
  const { fakeRunner } = await import("./repair.ts");
  const { isolatedReplayer } = await import("./replay-seam.ts");
  const { route } = await import("./route.ts");
  const bed = makeBed();
  const runsDir = mkdtempSync(join(tmpdir(), "ratchet-runs-"));
  // the fake repairer fixes every incident but INC-0002, which it leaves unedited: two REFUSEs at diff-scope, then unrepaired
  const runner = fakeRunner((dir) => { if (!readFileSync(join(dir, "packet", "incident.json"), "utf8").includes('"INC-0002"')) setShade(dir, FIX); }, { dispositions: {}, off_map: null, beliefs: [], summary: "Renders a ROM's first byte as its shade." });
  const steady = { async score() { return { readings: [], roms: {} }; } };
  const client = async () => ({ status: 200, wall_ms: 1, body: { model: "subq-snap-1.1 (dry)", answers: { subsystem: { type: "choice", probabilities: { ppu_fetcher: 0.7, other: 0.3 } } } as never, usage: { input_tokens: 10, output_tokens: 0 } } });
  const deps: CampaignDeps = {
    paths: bed.paths, run: RUN_ID, runsDir, minutes, stopWhenIdle: true, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
    play: dryPlay(bed.paths),
    route: (inc) => route(inc, { client, ledger: bed.paths.ledger, root: bed.paths.root, skills: [], observations: [] }),
    narrate: async () => null,
    fast: (id, gateLock) => runFastCycle(id, { paths: bed.paths, runner, replayer: isolatedReplayer(bed.paths.root), suites: steady, quiet: true, gateLock }),
    slow: async () => null,
  };
  const manifest = (): Manifest => ({ id: RUN_ID, opened_at: new Date().toISOString(), models: { repairer: "fake-muse (dry)" }, oracle: { core: "dry", build_hash: "dry" }, roms: {}, splits_sha: "dry", rule_version: "dry", s0_sha: "dry" });
  return { deps, manifest };
}

async function realDeps(minutes: number): Promise<{ deps: CampaignDeps; manifest: () => Promise<Manifest> }> {
  const paths = pathsFromEnv();
  const runsDir = resolve(paths.root, process.env.RATCHET_RUNS ?? "runs");
  const env = { ...process.env, RATCHET_RUN: RUN_ID };
  const { museCli } = await import("./repair.ts");
  const { defaultReplayer } = await import("./replay-seam.ts");
  const { defaultSuites } = await import("./gate-repair.ts");
  const { route } = await import("./route.ts");
  const { narrate } = await import("../player/narrate.ts");
  const { runGeneration } = await import("./slow.ts");
  const { defaultJudge } = await import("./trial.ts");
  const replayer = defaultReplayer(), suites = defaultSuites(), judge = defaultJudge();
  const deps: CampaignDeps = {
    paths, run: RUN_ID, runsDir, minutes, env,
    play: realPlay(paths, env),
    route: (inc) => route(inc, { ledger: paths.ledger, root: paths.root }),
    narrate: (inc) => narrate({ id: inc.id, dir: resolve(paths.root, inc.files.dir), run: RUN_ID, ledgerDir: paths.ledger }),
    fast: (id, gateLock) => runFastCycle(id, { paths, runner: museCli, replayer, suites, gateLock }),
    slow: () => runGeneration({ paths, runner: museCli, judge, run: RUN_ID, runsDir }),
  };
  const manifest = async (): Promise<Manifest> => {
    const { OracleClient } = await import("../oracle/client.ts");
    const { loadSplits, familyRoms, SPLITS_PATH } = await import("../suites/splits.ts");
    const o = OracleClient.spawn();
    let info: { core: string; build_hash: string };
    try { info = await o.info(); } finally { await o.close(); }
    const splits = loadSplits();
    return buildManifest({
      run: RUN_ID, root: paths.root, skills: paths.skills, ledger: paths.ledger, roms: paths.roms, splitsPath: SPLITS_PATH, splits,
      familyRoms: (f) => { try { return familyRoms(splits, f, paths.roms); } catch { return []; } },
      oracle: { core: info.core, build_hash: info.build_hash },
      telemetryFiles: [join(paths.root, "runs", "prerun", "telemetry", "llm.jsonl"), join(runsDir, RUN_ID, "telemetry", "llm.jsonl")],
    });
  };
  return { deps, manifest };
}

async function main(argv: string[]): Promise<number> {
  const { values: v } = parseArgs({ args: argv, options: { resume: { type: "boolean" }, dry: { type: "boolean" }, minutes: { type: "string" }, "allow-nonempty-s0": { type: "boolean" } } });
  const minutes = Number(v.minutes ?? (v.dry ? 2 : 75));
  process.env.RATCHET_RUN = RUN_ID; // every record written from here carries the run (loop/ledger.ts runId)
  const { deps, manifest } = v.dry ? await dryDeps(minutes) : await realDeps(minutes);
  if (v.dry) console.log(`dry campaign: scratch ledger ${deps.paths.ledger}, runs ${deps.runsDir}`);
  const m = await openRun({ runsDir: deps.runsDir, run: deps.run, resume: !!v.resume, build: manifest, s0Dirs: sDirs(deps.paths.skills, deps.paths.root), allowNonEmptyS0: !!v["allow-nonempty-s0"] });
  console.log(`${m.id} open: rule_version ${m.rule_version.slice(0, 12)}, s0 ${m.s0_sha.slice(0, 12)}, ${Object.keys(m.roms).length} ROM hashes, models ${JSON.stringify(m.models)}`);
  console.log(meterLine(spendMeter({ ledger: deps.paths.ledger, runsDir: deps.runsDir, run: deps.run, env: deps.env })));
  console.log(`K ${K}, MAX_ATTEMPTS ${MAX_ATTEMPTS}, CAMPAIGN_PARALLEL ${CAMPAIGN_PARALLEL}, ${minutes} min`);
  const out = await runCampaign(deps);
  console.log(JSON.stringify({ stopped: out.stopped, segments: out.segments, attempts: out.attempts.map((a) => `${a.attempt.id} ${a.attempt.task.incident} ${a.verdict.id} ${a.verdict.decision}`), paused: out.paused }));
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // dry: telemetry goes to a temp dir, so a dry RUN-0001 never writes under the repository's runs/
  if (process.argv.includes("--dry")) process.env.RATCHET_TELEMETRY_DIR ??= mkdtempSync(join(tmpdir(), "ratchet-dry-telemetry-"));
  else process.env.RATCHET_RUN = RUN_ID;
  (await import("../src/telemetry-process.ts")).processStart("campaign");
  try { process.exitCode = await main(process.argv.slice(2)); } catch (e) { console.error(String(e instanceof Error ? e.message : e)); process.exitCode = 1; }
}
