// replayFrames and tools/replay.mjs against synthetic oracle caches: no oracle process and no SameBoy needed.
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Core, HandlerId } from "../src/schema.ts";
import { sha256 } from "../oracle/client.ts";
import { REPLAY_OUT } from "./build-replay.ts";
import { replayFrames } from "./replay.ts";

const WHITE = new Uint8Array(160 * 144);

/** A core whose frame is always white and whose counter stops advancing after `last`. */
function stallingCore(last: number): Core {
  return {
    cpu: { a: 0, b: 0, c: 0, d: 0, e: 0, f: 0, h: 0, l: 0, sp: 0xfffe, pc: 0x100 }, serial: "", cycles: 0,
    step() {}, runFrame() {},
    runToCounter(n) { return n <= last; },
    read() { return 0; }, frame() { return WHITE; }, setButtons() {}, snapshot() { return new Uint8Array(0); }, restore() {},
    tap: { handlerHits() { return {} as Record<HandlerId, number>; }, ppu() { return { ly: 0, mode: 0, dot: 0, stat: 0, lcdc: 0 }; } },
  };
}

test("a core that stalls inside the window on a static scene replays as a stall at its first missed counter, not clean", () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-oracle-"));
  for (let n = 1; n <= 20; n++) writeFileSync(join(dir, `${n}.bin`), WHITE);
  const out = replayFrames(() => stallingCore(12), { rom: new Uint8Array(0x8000), align: "counter", inputs: [], window: [5, 20], oracleDir: dir });
  assert.deepEqual(out, { clean: false, counter: 13, reason: "stall", pixels: 0 });
});

test("replay --incident refuses a --rom whose sha is not the incident's, before scoring it against another ROM's cached frames", () => {
  const root = mkdtempSync(join(tmpdir(), "ratchet-evidence-"));
  const oracleDir = join(root, "oracle");
  mkdirSync(oracleDir);
  for (let n = 1; n <= 3; n++) writeFileSync(join(oracleDir, `${n}.bin`), WHITE);
  const recorded = new Uint8Array(0x8000).fill(1);
  const other = new Uint8Array(0x8000).fill(2);
  writeFileSync(join(root, "other.gb"), other);
  const incident = { id: "INC-0001", rom_sha: sha256(recorded), window: [1, 3] };
  writeFileSync(join(root, "window.json"), JSON.stringify({
    kind: "frames", incident, rom: { path: join(root, "other.gb"), sha: sha256(recorded) },
    trace: { align: "frame", inputs: [], counter_end: 3 }, oracle_dir: oracleDir, oracle_ram: {},
  }));
  const r = spawnSync(process.execPath, [REPLAY_OUT, "--incident", "INC-0001", "--evidence-dir", root, "--core-dir", join(import.meta.dirname, "..", "suites", "fixtures", "nop-core")], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /is not the incident's ROM/);
});
