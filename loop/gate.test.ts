import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeBed, makeDiff, setShade, attemptFor, FIX, BREAKS_ADMITTED, type Bed } from "./fixtures/harness.ts";
import { gateAttempt, diffScope, longestLiteral, type SuitesJudge } from "./gate-repair.ts";
import { isolatedReplayer } from "./replay-seam.ts";
import { git } from "./paths.ts";
import { LITERAL_LIMIT, RULE_CONSTANTS } from "./gate.ts";
import * as gateConsts from "./gate.ts";

/** Suites that read the same on every core: base and H never regress. */
const steadySuites: SuitesJudge = { async score() { return { readings: [{ split: "base", family: "f", roms: 1, pass: 1, exact: 1, pixel_match: 1 }], roms: { "f.gb": true } }; } };

async function judge(bed: Bed, diff: string, suites = steadySuites) {
  return gateAttempt({ attempt: attemptFor(bed), diff, incident: bed.incident, paths: bed.paths, replayer: isolatedReplayer(bed.paths.root), suites, quiet: true });
}

test("RULE_CONSTANTS stays exported with its nine names", () => {
  assert.deepEqual(Object.keys(RULE_CONSTANTS).sort(), ["H_TOLERANCE", "K", "LITERAL_LIMIT", "MARGIN_FLOOR", "MAX_ATTEMPTS", "MAX_SHOWN", "MAX_STEPS", "SUITE_MIN_GAIN", "TRIAL_FAMILIES"]);
  assert.equal(gateConsts.LITERAL_LIMIT, 64);
});

test("a diff touching loop/ is REFUSED at diff-scope and its branch stays unmerged", async () => {
  const bed = makeBed();
  const diff = makeDiff((d) => { setShade(d, FIX); mkdirSync(join(d, "loop"), { recursive: true }); writeFileSync(join(d, "loop", "gate.ts"), "export const H_TOLERANCE = 1;\n"); });
  const before = git(bed.paths.live, ["rev-parse", "core-live"]);
  const { verdict } = await judge(bed, diff);
  assert.equal(verdict.decision, "REFUSE");
  assert.deepEqual(verdict.checks.map((c) => [c.name, c.pass]), [["diff-scope", false]]);
  assert.deepEqual((verdict.checks[0].reading as { outside: string[] }).outside, ["loop/gate.ts"]);
  assert.equal(git(bed.paths.live, ["rev-parse", "core-live"]), before);
  assert.ok(git(bed.paths.live, ["branch", "--list", "attempt/ATT-0001"]).includes("attempt/ATT-0001"));
});

test("a fixture diff breaking admitted trace TRC-0001 passes repro and is REFUSED at admitted-traces", async () => {
  const bed = makeBed();
  const before = git(bed.paths.live, ["rev-parse", "core-live"]);
  const { verdict } = await judge(bed, makeDiff((d) => setShade(d, BREAKS_ADMITTED)));
  assert.equal(verdict.decision, "REFUSE");
  assert.deepEqual(verdict.checks.map((c) => [c.name, c.pass]), [["diff-scope", true], ["repro", true], ["admitted-traces", false]]);
  assert.match(verdict.reason, /^admitted-traces failed/);
  assert.equal(git(bed.paths.live, ["rev-parse", "core-live"]), before);
  assert.deepEqual(readdirSync(bed.paths.traces), ["TRC-0001.json"]);
});

test("an unrepaired core is REFUSED at repro", async () => {
  const bed = makeBed();
  const { verdict } = await judge(bed, makeDiff((d) => writeFileSync(join(d, "core", "ppu.ts"), readFileSync(join(d, "core", "ppu.ts"), "utf8") + "// touch\n")));
  assert.deepEqual(verdict.checks.map((c) => [c.name, c.pass]), [["diff-scope", true], ["repro", false]]);
});

test("a base-suite regression is REFUSED at base-suites", async () => {
  const bed = makeBed();
  let n = 0;
  const regress: SuitesJudge = { async score() { n++; return { readings: [{ split: "base", family: "f", roms: 1, pass: n === 1 ? 1 : 0, exact: 0, pixel_match: 1 }], roms: {} }; } };
  const { verdict } = await judge(bed, makeDiff((d) => setShade(d, FIX)), regress);
  assert.equal(verdict.checks.at(-1)!.name, "base-suites");
  assert.equal(verdict.decision, "REFUSE");
});

test("a literal over LITERAL_LIMIT bytes and the incident's trace sha are refused as memorisation", async () => {
  const bed = makeBed();
  const big = makeDiff((d) => { setShade(d, FIX); writeFileSync(join(d, "core", "table.ts"), `export const T = "${"a".repeat(LITERAL_LIMIT + 1)}";\n`); });
  assert.equal(longestLiteral(big).bytes, LITERAL_LIMIT + 1);
  assert.equal(diffScope(big, []).pass, false);
  const memo = makeDiff((d) => { setShade(d, FIX); writeFileSync(join(d, "core", "k.ts"), `export const K = 1; // ${bed.incident.trace_sha}\n`); });
  const v = (await judge(bed, memo)).verdict;
  assert.equal(v.decision, "REFUSE");
  assert.equal((v.checks[0].reading as { memorised: string[] }).memorised.length, 1);
});

test("GRADUATE merges into core-live with trailers, admits TRC-0002, writes a suspected belief and provenance", async () => {
  const bed = makeBed();
  const out = await judge(bed, makeDiff((d) => setShade(d, FIX)));
  assert.equal(out.verdict.decision, "GRADUATE", out.verdict.reason);
  assert.deepEqual(out.verdict.checks.map((c) => c.name), ["diff-scope", "repro", "admitted-traces", "base-suites", "H-no-regress"]);
  const msg = git(bed.paths.live, ["log", "-1", "--format=%B", "core-live"]);
  assert.match(msg, /^Attempt: ATT-0001$/m);
  assert.match(msg, /^Skills: none$/m);
  assert.equal(readFileSync(join(bed.paths.live, "core", "ppu.ts"), "utf8").includes(FIX), true);
  const trc = JSON.parse(readFileSync(join(bed.paths.traces, "TRC-0002.json"), "utf8"));
  assert.equal(trc.incident, "INC-0001");
  assert.deepEqual(trc.window, bed.incident.window);
  const bel = readdirSync(join(bed.paths.ledger, "beliefs"));
  assert.equal(bel.length, 1);
  assert.match(readFileSync(join(bed.paths.ledger, "beliefs", bel[0]), "utf8"), /^mark: suspected$/m);
  const prov = JSON.parse(readFileSync(join(bed.paths.ledger, "provenance.json"), "utf8"));
  assert.deepEqual(prov.find((e: { handler: string }) => e.handler === "ppu.fifo"), { handler: "ppu.fifo", file: "core/ppu.ts", commit: out.verdict && git(bed.paths.live, ["log", "-1", "--format=%H", "core-live", "--", "core/ppu.ts"]), attempt: "ATT-0001" });
  assert.match(out.bundle, /^skipped/);
  assert.ok(existsSync(join(bed.paths.ledger, "verdicts.jsonl")));
});

