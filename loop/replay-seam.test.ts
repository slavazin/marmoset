import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeBed, FIXTURE_CORE } from "./fixtures/harness.ts";
import { isolatedReplayer, toolReplayer } from "./replay-seam.ts";

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
