// lockstep: steps a core in process and the oracle (oracle/client.ts) per game frame over one trace and
// compares every COMPARE_EVERY-th frame (SPEC §5 S5). A frame difference whose signature has no open
// incident opens a `frame` Incident; a known signature is counted. A game-state RAM difference
// (lockstep/diff.ts GAME_RAM) opens a `logic` Incident and stops the trace. Every oracle frame it reads is
// written to the oracleFrames cache, and the oracle runs on to the last incident's window end so that
// tools/replay.mjs finds the whole window n-60…n+120 cached. Truth-maker: lockstep/lockstep.test.ts.
// The game-state bytes, scene byte and counter come from the ROM's games-registry entry (lockstep/games.ts),
// selected by sha; an unregistered ROM is read by SPEC §6.17's map. An entry with a `start` runs both sides
// from one start state (lockstep/start-state.ts); its oracle frames are cached apart from power-on frames.
// Truth-maker for the registry path: lockstep/start-state.test.ts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { CreateCore, Incident, Trace } from "../src/schema.ts";
import { OracleClient, ratchetCache, sha256, traceSha } from "../oracle/client.ts";
import { GAME_RAM, bytesEqual, frameDiff, maskAt, signatureKey, signatureOf, type Signature } from "./diff.ts";
import { EVIDENCE_ROOT, writeEvidence, type RegWrite } from "./evidence.ts";
import type { IncidentSink } from "./incidents.ts";
import { counterStepper } from "./align.ts";
import { gameBySha, mapOf, mappedRam, sceneOffset, type GameEntry } from "./games.ts";
import { buildStartState, startDirSuffix, startFileSha, startPath, withStart, type StartState } from "./start-state.ts";

/**
 * Compare every Nth counter. SPEC §5 S5 Wiggle: every frame, or every fourth below 300 oracle fps.
 * Set to 1: counter.gb lockstep against the playback fixture runs well above 300 fps (lockstep/lockstep.test.ts
 * prints the reading; S3 measured about 600 oracle fps).
 */
export const COMPARE_EVERY = 1;
/** Trace window around the first diverging counter n (SPEC §6.5): n-60 … n+120. */
export const WINDOW_BEFORE = 60;
export const WINDOW_AFTER = 120;

const REPO = resolve(import.meta.dirname, "..");

export interface LockstepOptions {
  romPath: string;
  trace: Pick<Trace, "align" | "inputs" | "counter_end">;
  createCore: CreateCore;
  coreCommit: string;
  sink: IncidentSink;
  evidenceRoot?: string;
  source?: Incident["source"];
  run?: string | null;
  compareEvery?: number;
  /** Called with each compared counter's core frame and the core's scene byte (player/spot.ts samples these). */
  onCompared?: (n: number, frame: Uint8Array, scene: number) => void;
  /** The ROM's registry entry; omitted, it is looked up by the ROM's sha (lockstep/games.ts gameBySha). null: SPEC §6.17's map, no start. */
  game?: GameEntry | null;
  /** The start state; omitted, it is built from the entry's `start` (lockstep/start-state.ts). null: power-on. */
  start?: StartState | null;
}

export interface LockstepResult {
  compared: number;
  opened: Incident[];
  /** Repeat sightings of an open signature, by signatureKey. */
  known: Record<string, number>;
  stopped: { counter: number; incident: string } | null;
  fps: number;
}

interface Pending { inc: Incident; core: Uint8Array; oracle: Uint8Array; regwrites: RegWrite[] }

export function windowOf(n: number): [number, number] {
  return [Math.max(1, n - WINDOW_BEFORE), n + WINDOW_AFTER];
}

export async function lockstep(o: LockstepOptions): Promise<LockstepResult> {
  const rom = new Uint8Array(readFileSync(o.romPath));
  const rom_sha = sha256(rom);
  const { align, inputs, counter_end } = o.trace;
  const trace_sha = traceSha({ rom_sha, align, inputs });
  const game = o.game !== undefined ? o.game : gameBySha(rom);
  const map = mapOf(game);
  const sceneAt = sceneOffset(map);
  if (sceneAt < 0) throw new Error(`game ${game?.id}: scene byte is outside its logic ranges`);
  const ramInit = game?.ram_init ?? "seeded";
  const start = o.start !== undefined ? o.start : game?.start ? await buildStartState(o.romPath, { ...game.start, ram_init: "zero" }) : null;
  const oracleDir = join(ratchetCache(), "oracle", rom_sha, trace_sha + startDirSuffix(start));
  mkdirSync(oracleDir, { recursive: true });
  const evidenceRoot = o.evidenceRoot ?? EVIDENCE_ROOT;
  const every = o.compareEvery ?? COMPARE_EVERY;

  const core = (start ? withStart(o.createCore, start) : o.createCore)(rom);
  const stepper = counterStepper(core, map.counter ?? GAME_RAM.addr);
  const regBuf: RegWrite[] = [];
  core.tap.onRegWrite = (e) => { regBuf.push({ ...e }); };

  const openByKey = new Map<string, Incident>();
  for (const i of o.sink.open()) if (i.rom_sha === rom_sha) openByKey.set(signatureKey(i.kind, i.rom_sha, i.signature), i);
  const known: Record<string, number> = {};
  const pending: Pending[] = [];
  const oracleRam = new Map<number, Uint8Array>();
  let compared = 0;
  let stopped: LockstepResult["stopped"] = null;

  const oracle = OracleClient.spawn();
  const t0 = performance.now();
  try {
    await oracle.load(o.romPath, align, "DMG", start ? "zero" : ramInit);
    if (start) await oracle.restore(start.oracle_state_b64, true);
    const oracleRamOf = async (): Promise<Uint8Array> => {
      if (map.logic.length === 1) return oracle.ram(map.logic[0].addr, map.logic[0].len);
      const parts: Uint8Array[] = [];
      for (const r of map.logic) parts.push(await oracle.ram(r.addr, r.len));
      return new Uint8Array(Buffer.concat(parts));
    };
    const oracleStep = async (n: number) => {
      const r = await oracle.runToCounter(n, inputs);
      if (r.stalled) throw new Error(`oracle stalled at counter ${r.counter} before ${n}`);
      const frame = await oracle.frame();
      const file = join(oracleDir, `${n}.bin`);
      if (!existsSync(file)) writeFileSync(file, frame);
      const ram = await oracleRamOf();
      oracleRam.set(n, ram);
      return { frame, ram };
    };
    const open = (kind: Incident["kind"], n: number, sig: Signature, pixels: number, cf: Uint8Array, of: Uint8Array): Incident => {
      const key = signatureKey(kind, rom_sha, sig);
      const seen = openByKey.get(key);
      if (seen) { known[key] = (known[key] ?? 0) + 1; return seen; }
      const inc = o.sink.record((id) => {
        const dir = join(evidenceRoot, id);
        const rel = relative(REPO, dir);
        return {
          id, at: new Date().toISOString(), run: o.run ?? null, kind, align, signature: sig, rom_sha, trace_sha,
          window: windowOf(n), core_commit: o.coreCommit, counter: n, pixels,
          files: { dir: rel.startsWith("..") ? dir : rel }, source: o.source ?? "play", status: "open",
        };
      });
      openByKey.set(key, inc);
      pending.push({ inc, core: cf.slice(), oracle: of.slice(), regwrites: [...regBuf] });
      return inc;
    };

    let last = 0;
    for (let n = 1; n <= counter_end; n++) {
      core.setButtons(maskAt(inputs, n - 1));
      regBuf.length = 0;
      // align counter: the frame completed before the VBlank that wrote n (lockstep/align.ts)
      const stepped = align === "counter" ? stepper.to(n) : (core.runFrame(), core.frame());
      const { frame: of, ram: oram } = await oracleStep(n);
      last = n;
      if (n % every !== 0) continue;
      compared++;
      const cf = stepped ?? core.frame();
      o.onCompared?.(n, cf, core.read(map.scene.addr) & 0xff);
      const d = frameDiff(cf, of);
      const sig = signatureOf(oram[sceneAt], d);
      if (!bytesEqual(mappedRam(map, (a) => core.read(a)), oram)) {
        stopped = { counter: n, incident: open("logic", n, sig, d.pixels, cf, of).id };
        break;
      }
      if (d.pixels) open("frame", n, sig, d.pixels, cf, of);
    }
    const fps = compared / ((performance.now() - t0) / 1000);

    const startFile = start ? startPath(start.spec) : null;
    const startInfo = start && startFile && existsSync(startFile) ? { file: startFile, sha: startFileSha(startFile), key: start.key } : start ? { file: "", sha: "", key: start.key } : null;
    const end = Math.max(0, ...pending.map((p) => p.inc.window[1]));
    for (let n = last + 1; n <= end; n++) await oracleStep(n);

    for (const p of pending) {
      const ram: Record<string, string> = {};
      for (let n = p.inc.window[0]; n <= p.inc.window[1]; n++) {
        const r = oracleRam.get(n);
        if (r) ram[n] = Buffer.from(r).toString("hex");
      }
      writeEvidence(join(evidenceRoot, p.inc.id), {
        kind: "frames", incident: p.inc, rom: { path: resolve(o.romPath), sha: rom_sha },
        trace: { align, inputs, counter_end }, oracle_dir: oracleDir, oracle_ram: ram,
        ...(game?.map ? { map: { game: game.id, logic: game.map.logic.map(({ addr, len }) => ({ addr, len })) } } : {}),
        ...(startInfo ? { start: startInfo } : {}),
      }, p.core, p.oracle, p.regwrites);
    }
    return { compared, opened: pending.map((p) => p.inc), known, stopped, fps };
  } finally {
    await oracle.close();
  }
}
