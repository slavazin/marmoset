import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBed, FIXTURE_CORE } from "./fixtures/harness.ts";
import { isolatedReplay, isolatedReplayer, toolReplayer } from "./replay-seam.ts";
import { sha256, traceSha } from "../oracle/client.ts";

test("the isolated replay denies the core under test a read of the oracle cache (S5-F6), so a core copying cached frames is not clean", async () => {
  const bed = makeBed();
  const cheat = mkdtempSync(join(tmpdir(), "ratchet-cheat-"));
  cpSync(FIXTURE_CORE, cheat, { recursive: true });
  const oracleDir = JSON.parse((await import("node:fs")).readFileSync(join(bed.paths.evidence, "incidents", "INC-0001", "window.json"), "utf8")).oracle_dir;
  // shade read from the cached oracle frame: replays clean when the read succeeds
  writeFileSync(join(cheat, "ppu.ts"), `import { readFileSync } from "node:fs";\nexport function shadeFor(_b: number): number { return readFileSync(${JSON.stringify(join(oracleDir, "1.bin"))})[0]; }\n`);
  const r = isolatedReplayer(bed.paths.root);
  const args = { id: "INC-0001", evidenceDir: join(bed.paths.evidence, "incidents", "INC-0001"), rom: bed.incRom, cache: bed.paths.cache };
  const read = await r.incident({ coreDir: cheat, ...args });
  assert.equal(read.clean, false);
  assert.match(read.line, /core child ended after 0 counters: .*(ERR_ACCESS_DENIED|restricted)/i);
  // the same core replays clean through tools/replay.mjs, where it runs in-process with the cache reachable
  const leak = await toolReplayer(bed.paths.root).incident({ coreDir: cheat, ...args });
  assert.equal(leak.clean, true, leak.line);
  // the honest fixture core is read normally: unrepaired, it mismatches at the first window counter
  const honest = await r.incident({ coreDir: FIXTURE_CORE, ...args });
  assert.deepEqual([honest.clean, honest.line], [false, "first mismatch: counter 1 (23040 pixels)"]);
  const trc = await r.trace({ coreDir: FIXTURE_CORE, id: "TRC-0001", tracesDir: bed.paths.traces, rom: bed.admRom, cache: bed.paths.cache });
  assert.deepEqual([trc.clean, trc.line], [true, "clean"]);
});

function frames(dir: string, shades: number[]): void {
  mkdirSync(dir, { recursive: true });
  shades.forEach((s, i) => writeFileSync(join(dir, `${i + 1}.bin`), new Uint8Array(160 * 144).fill(s)));
}

test("a core that prints counter 1's correct line for every counter is not clean: the parent reads counters in order", async () => {
  const bed = makeBed();
  const cheat = mkdtempSync(join(tmpdir(), "ratchet-forge-"));
  cpSync(FIXTURE_CORE, cheat, { recursive: true });
  // the core renders shade 2, right for counters 1-4 of this oracle and wrong for 5-8; at import it prints
  // counter 1's line eight times and exits before the producer runs
  const line = JSON.stringify({ n: 1, ram: "", frame: Buffer.from(new Uint8Array(160 * 144).fill(2)).toString("base64") });
  writeFileSync(join(cheat, "index.ts"), readFileSync(join(cheat, "index.ts"), "utf8") + `\nimport { writeSync } from "node:fs";\nfor (let i = 0; i < 8; i++) writeSync(1, ${JSON.stringify(line + "\n")});\nprocess.exit(0);\n`);
  const oracleDir = join(bed.paths.cache, "forge");
  frames(oracleDir, [2, 2, 2, 2, 0, 0, 0, 0]);
  const w = { rom: bed.incRom, rom_sha: bed.incident.rom_sha, align: "counter" as const, inputs: [{ from_counter: 0, mask: 0 }], from: 1, to: 8, oracleDir, oracleRam: {} };
  const r = await isolatedReplay(cheat, w);
  assert.equal(r.clean, false, r.line);
});

test("a core that writes non-protocol lines to stdout replays normally and cannot crash the gate process", async () => {
  const bed = makeBed();
  const noisy = mkdtempSync(join(tmpdir(), "ratchet-noisy-"));
  cpSync(FIXTURE_CORE, noisy, { recursive: true });
  writeFileSync(join(noisy, "ppu.ts"), `export function shadeFor(b: number): number { console.log("debug: shade", b); console.log('{"n":"x"}'); return b & 3; }\n`);
  const r = await isolatedReplayer(bed.paths.root).incident({ coreDir: noisy, id: "INC-0001", evidenceDir: join(bed.paths.evidence, "incidents", "INC-0001"), rom: bed.incRom, cache: bed.paths.cache });
  assert.deepEqual([r.clean, r.line], [true, "clean"]);
});

test("an admitted trace is compared over its window only, not from counter 1", async () => {
  const bed = makeBed();
  const other = join(bed.paths.roms, "other.gb"); // first byte 3: the fixture core renders shade 3
  const rom_sha = sha256(readFileSync(other));
  const inputs = [{ from_counter: 0, mask: 0 }];
  // the oracle differs at counters 1-4 (another, unrepaired divergence) and matches on the window 5-8
  frames(join(bed.paths.cache, "oracle", rom_sha, traceSha({ rom_sha, align: "counter", inputs })), [0, 0, 0, 0, 3, 3, 3, 3]);
  writeFileSync(join(bed.paths.traces, "TRC-0009.json"), JSON.stringify({ id: "TRC-0009", rom_sha, align: "counter", inputs, counter_end: 8, source: "keyboard", window: [5, 8] }));
  const r = await isolatedReplayer(bed.paths.root).trace({ coreDir: FIXTURE_CORE, id: "TRC-0009", tracesDir: bed.paths.traces, rom: other, cache: bed.paths.cache });
  assert.deepEqual([r.clean, r.line], [true, "clean"]);
});
