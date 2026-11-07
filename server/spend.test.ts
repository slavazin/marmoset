// combinedMeter: the one Meta account's guard over several runs (server/spend.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { combinedMeter, parseMeterPart, spendGate, spendMeter, SPEND_ASK_USD } from "./spend.ts";

const AT = "2026-11-07T20:35:00.000Z";
const later = "2026-11-07T21:00:00.000Z";

function bed() {
  const root = mkdtempSync(join(tmpdir(), "ratchet-spend-"));
  const l1 = join(root, "ledger"), l2 = join(root, "runs", "RUN-0002", "ledger"), runs = join(root, "runs");
  for (const d of [l1, l2, join(runs, "RUN-0001"), join(runs, "RUN-0002")]) mkdirSync(d, { recursive: true });
  // pre-run: $100 priced before the reading, which the owner read as $5 on the console: ratio 0.05
  writeFileSync(join(l1, "attempts.jsonl"), JSON.stringify({ id: "ATT-0001", at: "2026-11-07T19:00:00.000Z", run: null, spent: { usd: 100 } }) + "\n"
    + JSON.stringify({ id: "ATT-0002", at: later, run: "RUN-0001", spent: { usd: 200 } }) + "\n");
  writeFileSync(join(l2, "attempts.jsonl"), JSON.stringify({ id: "ATT-0001", at: later, run: "RUN-0002", spent: { usd: 400 } }) + "\n");
  const ov = JSON.stringify({ usd: 5, at: AT, pre_run_usd: 5 });
  for (const r of ["RUN-0001", "RUN-0002"]) {
    const p = join(runs, r, "spend-override.json");
    writeFileSync(p, ov);
    utimesSync(p, new Date(AT), new Date(AT));
  }
  return { l1, l2, runs };
}

test("combined meter: a run on its own fresh ledger prices at the ratio of the ledger the owner's reading stands against, and the guard reads both runs' spend summed", () => {
  const { l1, l2, runs } = bed();
  const alone = spendMeter({ ledger: l2, runsDir: runs, run: "RUN-0002" });
  assert.equal(alone.ratio, 1, "alone, RUN-0002's ledger holds nothing before the reading");
  const m = combinedMeter([{ ledger: l2, runsDir: runs, run: "RUN-0002" }, { ledger: l1, runsDir: runs, run: "RUN-0001" }]);
  assert.equal(m.parts[0].ratio, 0.05);
  assert.equal(m.parts[1].ratio, 0.05);
  assert.equal(m.parts[0].usd, 20); // 400 × 0.05
  assert.equal(m.parts[1].usd, 10); // 200 × 0.05, what RUN-0001's own guard reads
  assert.equal(m.parts[1].usd, spendMeter({ ledger: l1, runsDir: runs, run: "RUN-0001" }).usd);
  assert.equal(m.usd, 30);
  assert.equal(m.priced_usd, 700);
});

test("combined meter: a run's extra jsonl (muse-native.jsonl readings with spent) counts at the ratio, and the sum trips the ask where neither run alone does", () => {
  const { l1, l2, runs } = bed();
  const native = join(runs, "RUN-0001", "muse-native.jsonl");
  writeFileSync(native, JSON.stringify({ at: later, run: "RUN-0001", generation: 1, spent: { usd: 400 } }) + "\n" + "{partial\n");
  const parts = [{ ledger: l2, runsDir: runs, run: "RUN-0002" }, parseMeterPart(`${l1},${runs},RUN-0001,${native}`)];
  // RUN-0001: (200 + 400) × 0.05 = 30; RUN-0002: 400 × 0.05 = 20
  assert.equal(combinedMeter(parts).usd, 50);
  writeFileSync(join(l2, "spend.jsonl"), JSON.stringify({ at: later, run: "RUN-0002", role: "router", usd: 300 }) + "\n");
  const m = combinedMeter(parts);
  assert.equal(m.usd, 65);
  assert.ok(m.parts.every((p) => p.usd < SPEND_ASK_USD));
  assert.equal(spendGate(m.usd), "ask");
});

test("parseMeterPart refuses a part without ledger, runs dir and run", () => {
  assert.throws(() => parseMeterPart("/a,/b"), /want <ledger>,<runsDir>,<run>/);
  assert.deepEqual(parseMeterPart("/a,/b,RUN-0001"), { ledger: "/a", runsDir: "/b", run: "RUN-0001", extraFiles: [] });
});
