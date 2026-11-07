// OracleClient: spawns oracle/frontend.py (SameBoy libretro, SPEC §6.4) and
// offers typed requests over its one-JSON-object-per-line stdio protocol.
// oracleFrames: the oracle-frame cache at
// $RATCHET_CACHE/oracle/<rom_sha>/<trace_sha>/<n>.bin, filled on a miss.
// Truth-maker for both: oracle/oracle.test.ts.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { OracleReq, OracleRes, Trace, TraceInput } from "../src/schema.ts";

export const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), "frontend.py");
export const FRAME_BYTES = 160 * 144;

export type Align = "counter" | "frame";
// `load` carries an optional `align` that src/schema.ts's OracleReq lacks
// (a finding for the orchestrator); every other request is OracleReq as typed.
// `colours` is a frontend debug op: the distinct 0xRRGGBB values of the frame `frame` returns.
export type OracleRequest = OracleReq | { op: "load"; rom_path: string; align?: Align } | { op: "colours" };

export interface OracleInfo { core: "SameBoy"; version: string; model: "DMG"; build_hash: string; frames: number; first_write_frame: number | null }

export function ratchetCache(): string {
  return process.env.RATCHET_CACHE ?? join(homedir(), ".cache", "ratchet");
}

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

// traceSha: the cache key of a trace's inputs, the sha256 of the JSON of
// { rom_sha, align, inputs }. The trace id, source and counter_end do not
// change any oracle frame, so they stay out of the key.
export function traceSha(trace: Pick<Trace, "rom_sha" | "align" | "inputs">): string {
  return sha256(JSON.stringify({ rom_sha: trace.rom_sha, align: trace.align, inputs: trace.inputs }));
}

export class OracleClient {
  private child: ChildProcessWithoutNullStreams;
  private pending: Array<(res: OracleRes) => void> = [];
  private stderr: string[] = [];

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => {
      const resolve = this.pending.shift();
      if (resolve) resolve(JSON.parse(line) as OracleRes);
    });
    child.stderr.on("data", (d: Buffer) => {
      this.stderr.push(d.toString());
      if (this.stderr.length > 50) this.stderr.shift();
    });
    child.on("exit", (code) => {
      const err: OracleRes = { ok: false, error: `frontend exited ${code}: ${this.stderr.join("").slice(-500)}` };
      for (const r of this.pending.splice(0)) r(err);
    });
  }

  static spawn(python = process.env.PYTHON ?? "python3"): OracleClient {
    return new OracleClient(spawn(python, ["-I", FRONTEND], { stdio: ["pipe", "pipe", "pipe"], env: process.env }));
  }

  request(req: OracleRequest): Promise<OracleRes> {
    return new Promise((resolve) => {
      this.pending.push(resolve);
      this.child.stdin.write(JSON.stringify(req) + "\n");
    });
  }

  private async ok(req: OracleRequest): Promise<Record<string, unknown>> {
    const res = await this.request(req);
    if (!res.ok) throw new Error(`oracle ${req.op}: ${res.error}`);
    return res;
  }

  async load(romPath: string, align: Align = "counter"): Promise<{ rom_sha: string }> {
    const res = await this.ok({ op: "load", rom_path: romPath, align });
    return { rom_sha: res.rom_sha as string };
  }

  async runToCounter(counter: number, inputs: TraceInput[] = []): Promise<{ counter: number; stalled: boolean }> {
    const res = await this.ok({ op: "run_to_counter", counter, inputs });
    return { counter: res.counter as number, stalled: res.stalled as boolean };
  }

  async frame(): Promise<Uint8Array> {
    const res = await this.ok({ op: "frame" });
    return new Uint8Array(Buffer.from(res.shades_b64 as string, "base64"));
  }

  async ram(addr: number, len: number): Promise<Uint8Array> {
    const res = await this.ok({ op: "ram", addr, len });
    return new Uint8Array(Buffer.from(res.bytes_b64 as string, "base64"));
  }

  async save(): Promise<string> {
    return (await this.ok({ op: "save" })).state_b64 as string;
  }

  async restore(state_b64: string): Promise<void> {
    await this.ok({ op: "restore", state_b64 });
  }

  async info(): Promise<OracleInfo> {
    return (await this.ok({ op: "info" })) as unknown as OracleInfo;
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.child.exitCode !== null) return resolve();
      this.child.once("exit", () => resolve());
      this.child.stdin.end();
    });
  }
}

// oracleFrames: the oracle frame at each counter in `counters` (ascending is
// fastest) for `romPath` under `trace`, read from the cache or run on a fresh
// oracle and written to it. Throws when the oracle stalls before a counter.
export async function oracleFrames(
  romPath: string,
  trace: Pick<Trace, "align" | "inputs">,
  counters: number[],
): Promise<Map<number, Uint8Array>> {
  const rom_sha = sha256(readFileSync(romPath));
  const dir = join(ratchetCache(), "oracle", rom_sha, traceSha({ rom_sha, align: trace.align, inputs: trace.inputs }));
  const out = new Map<number, Uint8Array>();
  const missing: number[] = [];
  for (const n of counters) {
    const file = join(dir, `${n}.bin`);
    if (existsSync(file)) out.set(n, new Uint8Array(readFileSync(file)));
    else missing.push(n);
  }
  if (missing.length === 0) return out;
  mkdirSync(dir, { recursive: true });
  const oracle = OracleClient.spawn();
  try {
    await oracle.load(romPath, trace.align);
    for (const n of [...missing].sort((a, b) => a - b)) {
      const r = await oracle.runToCounter(n, trace.inputs);
      if (r.stalled) throw new Error(`oracle stalled at counter ${r.counter} before ${n}`);
      const shades = await oracle.frame();
      writeFileSync(join(dir, `${n}.bin`), shades);
      out.set(n, shades);
    }
  } finally {
    await oracle.close();
  }
  return out;
}
