// lockstep: steps a core in process and the oracle (oracle/client.ts) per game frame over one trace and
// compares every COMPARE_EVERY-th frame (SPEC §5 S5). A frame difference whose signature has no open
// incident opens a `frame` Incident; a known signature is counted. A game-state RAM difference
// (lockstep/diff.ts GAME_RAM) opens a `logic` Incident and stops the trace. Every oracle frame it reads is
// written to the oracleFrames cache, and the oracle runs on to the last incident's window end so that
// tools/replay.mjs finds the whole window n-60…n+120 cached. Truth-maker: lockstep/lockstep.test.ts.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { CreateCore, Incident, Trace } from "../src/schema.ts";
import { OracleClient, ratchetCache, sha256, traceSha } from "../oracle/client.ts";
import { GAME_RAM, SCENE_OFFSET, bytesEqual, coreGameRam, frameDiff, maskAt, signatureKey, signatureOf, type Signature } from "./diff.ts";
import { EVIDENCE_ROOT, writeEvidence, type RegWrite } from "./evidence.ts";
import type { IncidentSink } from "./incidents.ts";

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
  const oracleDir = join(ratchetCache(), "oracle", rom_sha, trace_sha);
  mkdirSync(oracleDir, { recursive: true });
  const evidenceRoot = o.evidenceRoot ?? EVIDENCE_ROOT;
  const every = o.compareEvery ?? COMPARE_EVERY;

  const core = o.createCore(rom);
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
    await oracle.load(o.romPath, align);
    const oracleStep = async (n: number) => {
      const r = await oracle.runToCounter(n, inputs);
      if (r.stalled) throw new Error(`oracle stalled at counter ${r.counter} before ${n}`);
      const frame = await oracle.frame();
      const file = join(oracleDir, `${n}.bin`);
      if (!existsSync(file)) writeFileSync(file, frame);
      const ram = await oracle.ram(GAME_RAM.addr, GAME_RAM.len);
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
      if (align === "counter") core.runToCounter(n, GAME_RAM.addr);
      else core.runFrame();
      const { frame: of, ram: oram } = await oracleStep(n);
      last = n;
      if (n % every !== 0) continue;
      compared++;
      const cf = core.frame();
      const d = frameDiff(cf, of);
      const sig = signatureOf(oram[SCENE_OFFSET], d);
      if (!bytesEqual(coreGameRam((a) => core.read(a)), oram)) {
        stopped = { counter: n, incident: open("logic", n, sig, d.pixels, cf, of).id };
        break;
      }
      if (d.pixels) open("frame", n, sig, d.pixels, cf, of);
    }
    const fps = compared / ((performance.now() - t0) / 1000);

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
      }, p.core, p.oracle, p.regwrites);
    }
    return { compared, opened: pending.map((p) => p.inc), known, stopped, fps };
  } finally {
    await oracle.close();
  }
}
