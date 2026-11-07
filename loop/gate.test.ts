import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, symlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { append, current, read } from "./ledger.ts";
import type { Incident, Verdict } from "../src/schema.ts";
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

test("a path outside core/ hidden under a space-bearing name or in a headerless hunk is REFUSED at diff-scope and never reaches core-live", async () => {
  const spaced = makeDiff((d) => { setShade(d, FIX); mkdirSync(join(d, "loop")); writeFileSync(join(d, "loop", "a b.ts"), "export const X = 1;\n"); });
  const headerless = makeDiff((d) => setShade(d, FIX)) + "--- a/loop/evil.ts\n+++ b/loop/evil.ts\n@@ -0,0 +1 @@\n+export const E = 1;\n";
  for (const [diff, file] of [[spaced, "a b.ts"], [headerless, "evil.ts"]] as const) {
    const bed = makeBed();
    const before = git(bed.paths.live, ["rev-parse", "core-live"]);
    const { verdict } = await judge(bed, diff);
    assert.equal(verdict.decision, "REFUSE", file);
    assert.deepEqual(verdict.checks.map((c) => [c.name, c.pass]), [["diff-scope", false]]);
    assert.deepEqual((verdict.checks[0].reading as { outside: string[] }).outside, [`loop/${file}`]);
    assert.equal(git(bed.paths.live, ["rev-parse", "core-live"]), before);
    assert.equal(existsSync(join(bed.paths.live, "loop", file)), false);
  }
});

test("a symlink or a binary file under core/ is REFUSED at diff-scope", async () => {
  const link = makeDiff((d) => { setShade(d, FIX); symlinkSync("../../../cache/oracle", join(d, "core", "o")); });
  const bin = makeDiff((d) => { setShade(d, FIX); writeFileSync(join(d, "core", "t.bin"), Buffer.alloc(4096, 7).fill(0, 0, 1)); }, true) + "\n"; // a binary hunk ends with a blank line
  for (const [diff, key] of [[link, "modes"], [bin, "binary"]] as const) {
    const bed = makeBed();
    const { verdict } = await judge(bed, diff);
    assert.equal(verdict.decision, "REFUSE", key);
    assert.deepEqual(verdict.checks.map((c) => [c.name, c.pass]), [["diff-scope", false]]);
    assert.equal(((verdict.checks[0].reading as Record<string, string[]>)[key] ?? []).length, 1, JSON.stringify(verdict.checks[0].reading));
  }
});

test("a check that throws is a REFUSE verdict at that check, not a missing verdict", async () => {
  const bed = makeBed();
  const replayer = { async incident(): Promise<never> { throw new Error("replay tool exploded"); }, async trace(): Promise<never> { throw new Error("unused"); } };
  const { verdict } = await gateAttempt({ attempt: attemptFor(bed), diff: makeDiff((d) => setShade(d, FIX)), incident: bed.incident, paths: bed.paths, replayer, suites: steadySuites, quiet: true });
  assert.equal(verdict.decision, "REFUSE");
  assert.deepEqual(verdict.checks.map((c) => [c.name, c.pass]), [["diff-scope", true], ["repro", false]]);
  assert.match(JSON.stringify(verdict.checks[1].reading), /replay tool exploded/);
});

test("a family or ROM the base reading has and the attempt's reading lacks is a regression, not a pass", async () => {
  for (const split of ["base", "H"] as const) {
    const bed = makeBed();
    const one = (s: "base" | "H", family: string) => ({ split: s, family, roms: 1, pass: 1, exact: 1, pixel_match: 1 });
    const judgeSuites: SuitesJudge = {
      async score(dir, s) {
        const roms: Record<string, boolean> = { "f.gb": true };
        if (s !== split || !dir.endsWith(".base/core")) return { readings: [one(s, "f")], roms };
        return { readings: [one(s, "f"), one(s, "g")], roms: { ...roms, "g.gb": true } };
      },
    };
    const { verdict } = await judge(bed, makeDiff((d) => setShade(d, FIX)), judgeSuites);
    assert.equal(verdict.decision, "REFUSE", split);
    assert.equal(verdict.checks.at(-1)!.name, split === "base" ? "base-suites" : "H-no-regress");
  }
});

test("a throwing provenance writer after the merge still leaves one GRADUATE Verdict, with the error in a side_effect_error status record and in loop telemetry, and the later side effects run", async () => {
  const bed = makeBed();
  const tdir = mkdtempSync(join(tmpdir(), "ratchet-tel-"));
  const prev = process.env.RATCHET_TELEMETRY_DIR;
  process.env.RATCHET_TELEMETRY_DIR = tdir;
  try {
    const out = await gateAttempt({
      attempt: attemptFor(bed), diff: makeDiff((d) => setShade(d, FIX)), incident: bed.incident, paths: bed.paths,
      replayer: isolatedReplayer(bed.paths.root), suites: steadySuites, quiet: true,
      effects: { provenance: async () => { throw new Error("provenance writer exploded"); } },
    });
    assert.equal(out.verdict.decision, "GRADUATE");
    const recs = read("verdicts.jsonl", bed.paths.ledger);
    assert.equal(recs.filter((r) => r.t !== "status").length, 1);
    const v = current<Verdict & { side_effect_error?: { effect: string; error: string }[] }>("verdicts.jsonl", out.verdict.id, bed.paths.ledger)!;
    assert.deepEqual(v.side_effect_error, [{ effect: "provenance", error: "provenance writer exploded" }]);
    assert.deepEqual((out.verdict as typeof v).side_effect_error, v.side_effect_error);
    assert.match(git(bed.paths.live, ["log", "-1", "--format=%s", "core-live"]), /^graduate ATT-0001/);
    // the side effects before and after the throwing one ran
    assert.ok(existsSync(join(bed.paths.traces, "TRC-0002.json")));
    assert.match(out.bundle, /^skipped/);
    const tel = readFileSync(join(tdir, "loop.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(tel.filter((r) => r.kind === "side_effect_error").map((r) => [r.data.verdict, r.data.effect]), [[out.verdict.id, "provenance"]]);
  } finally {
    if (prev === undefined) delete process.env.RATCHET_TELEMETRY_DIR; else process.env.RATCHET_TELEMETRY_DIR = prev;
  }
});

test("a merge into core-live that throws writes a REFUSE Verdict naming the error and runs no side effect", async () => {
  const bed = makeBed();
  // an uncommitted edit to ppu.ts in the live clone's working tree makes the merge throw; core-live's head does not move
  const att = attemptFor(bed);
  writeFileSync(join(bed.paths.live, "core", "ppu.ts"), "export function shadeFor(romByte: number): number {\n  return 0;\n}\n");
  const before = git(bed.paths.live, ["rev-parse", "core-live"]);
  const { verdict } = await gateAttempt({ attempt: att, diff: makeDiff((d) => setShade(d, FIX)), incident: bed.incident, paths: bed.paths, replayer: isolatedReplayer(bed.paths.root), suites: steadySuites, quiet: true });
  assert.equal(verdict.decision, "REFUSE");
  assert.match(verdict.reason, /^merge into core-live failed/);
  assert.equal(git(bed.paths.live, ["rev-parse", "core-live"]), before);
  assert.deepEqual(readdirSync(bed.paths.traces), ["TRC-0001.json"]);
});

test("after a GRADUATE merge every other open or unrepaired incident that no longer reproduces on the merged head gets repaired_by <VER> and status repaired, without an attempt; one that still reproduces is left as it was", async () => {
  const bed = makeBed();
  const L = bed.paths.ledger;
  // the dry run's INC-0003 shape: a clone of INC-0001 with its own evidence copy and band
  const clone = (id: string, status: Incident["status"]) => {
    cpSync(join(bed.paths.evidence, "incidents", "INC-0001"), join(bed.paths.evidence, "incidents", id), { recursive: true });
    append("incidents.jsonl", { ...bed.incident, id, status, signature: { ...bed.incident.signature, band: 5 }, files: { dir: `evidence/incidents/${id}` } }, L);
  };
  clone("INC-0002", "open"); clone("INC-0003", "unrepaired"); clone("INC-0004", "open"); clone("INC-0005", "repaired");
  const base = isolatedReplayer(bed.paths.root);
  const replayed: string[] = [];
  // INC-0004 still reproduces on the merged head
  const replayer = { ...base, async incident(a: Parameters<typeof base.incident>[0]) { replayed.push(a.id); const r = await base.incident(a); return a.id === "INC-0004" ? { ...r, clean: false } : r; } };
  const out = await gateAttempt({ attempt: attemptFor(bed), diff: makeDiff((d) => setShade(d, FIX)), incident: bed.incident, paths: bed.paths, replayer, suites: steadySuites, quiet: true });
  assert.equal(out.verdict.decision, "GRADUATE", out.verdict.reason);
  const cur = (id: string) => current<Incident & { repaired_by?: string }>("incidents.jsonl", id, L)!;
  assert.deepEqual(["INC-0002", "INC-0003", "INC-0004", "INC-0005"].map((id) => [id, cur(id).status, cur(id).repaired_by ?? null]),
    [["INC-0002", "repaired", out.verdict.id], ["INC-0003", "repaired", out.verdict.id], ["INC-0004", "open", null], ["INC-0005", "repaired", null]]);
  assert.deepEqual(out.repaired_by, ["INC-0002", "INC-0003"]);
  assert.ok(!replayed.includes("INC-0005"), "a repaired incident is not re-checked");
  assert.equal(read("attempts.jsonl", L).length, 0, "a re-check mints no attempt");
});

type Seen ={ dir: string; split: string; a: boolean; b: boolean };
/** Suites that record, per score call, which marker files (core/a.ts, core/b.ts) the scored core holds. */
function markerSuites(seen: Seen[]): SuitesJudge {
  return { async score(dir, split) { seen.push({ dir, split, a: existsSync(join(dir, "a.ts")), b: existsSync(join(dir, "b.ts")) }); return steadySuites.score(dir, split); } };
}

test("two attempts from one base: the second's checks run on core-live's merged head with its diff rebased onto it, and its base readings are the merged head's", async () => {
  const bed = makeBed();
  // both attempts take their task while core-live is at one commit, as CAMPAIGN_PARALLEL attempts do
  const a = attemptFor(bed, "ATT-0001"), b = attemptFor(bed, "ATT-0002");
  assert.equal(a.task.base_commit, b.task.base_commit);
  const seenA: Seen[] = [], seenB: Seen[] = [];
  const gate = (att: typeof a, diff: string, seen: Seen[]) => gateAttempt({ attempt: att, diff, incident: bed.incident, paths: bed.paths, replayer: isolatedReplayer(bed.paths.root), suites: markerSuites(seen), quiet: true });
  const outA = await gate(a, makeDiff((d) => { setShade(d, FIX); writeFileSync(join(d, "core", "a.ts"), "export const A = 1;\n"); }), seenA);
  assert.equal(outA.verdict.decision, "GRADUATE", outA.verdict.reason);
  const merged = git(bed.paths.live, ["rev-parse", "core-live"]);
  const outB = await gate(b, makeDiff((d) => { setShade(d, FIX); writeFileSync(join(d, "core", "b.ts"), "export const B = 1;\n"); }), seenB);
  assert.equal(outB.verdict.decision, "GRADUATE", outB.verdict.reason);
  assert.deepEqual((outB.verdict.checks[0].reading as { base_moved?: unknown }).base_moved, { from: b.task.base_commit, onto: merged });
  // the candidate B's base-suites and H-no-regress score holds A's merged change and B's own
  assert.deepEqual(seenB.filter((s) => !s.dir.endsWith(".base/core")).map((s) => [s.split, s.a, s.b]), [["base", true, true], ["H", true, true]]);
  // B's base reading is the merged head's (a.ts, no b.ts), not its stale base's
  assert.deepEqual(seenB.filter((s) => s.dir.endsWith(".base/core")).map((s) => [s.split, s.a, s.b]), [["base", true, false], ["H", true, false]]);
  assert.ok(existsSync(join(bed.paths.live, "core", "a.ts")) && existsSync(join(bed.paths.live, "core", "b.ts")));
});

test("an attempt whose diff conflicts with a core-live commit made after its base is REFUSED at merge, naming the moved base, before any later check runs", async () => {
  const bed = makeBed();
  const att = attemptFor(bed);
  writeFileSync(join(bed.paths.live, "core", "ppu.ts"), "export function shadeFor(romByte: number): number {\n  return 0;\n}\n");
  git(bed.paths.live, ["commit", "--quiet", "-am", "conflicting core-live change"]);
  const moved = git(bed.paths.live, ["rev-parse", "core-live"]);
  const { verdict } = await gateAttempt({ attempt: att, diff: makeDiff((d) => setShade(d, FIX)), incident: bed.incident, paths: bed.paths, replayer: isolatedReplayer(bed.paths.root), suites: steadySuites, quiet: true });
  assert.equal(verdict.decision, "REFUSE");
  assert.deepEqual(verdict.checks.map((c) => [c.name, c.pass]), [["diff-scope", true], ["merge", false]]);
  assert.deepEqual((verdict.checks[1].reading as { base_moved: unknown }).base_moved, { from: att.task.base_commit, onto: moved });
  assert.match(verdict.reason, /^merge failed: .*base_moved/);
  assert.equal(git(bed.paths.live, ["rev-parse", "core-live"]), moved);
  assert.deepEqual(readdirSync(bed.paths.traces), ["TRC-0001.json"]);
});

test("an attempt whose change core-live already holds after its base moved is REFUSED at merge as empty", async () => {
  const bed = makeBed();
  const a = attemptFor(bed, "ATT-0001"), b = attemptFor(bed, "ATT-0002");
  const diff = makeDiff((d) => setShade(d, FIX));
  const gate = (att: typeof a) => gateAttempt({ attempt: att, diff, incident: bed.incident, paths: bed.paths, replayer: isolatedReplayer(bed.paths.root), suites: steadySuites, quiet: true });
  assert.equal((await gate(a)).verdict.decision, "GRADUATE");
  const merged = git(bed.paths.live, ["rev-parse", "core-live"]);
  const vb = (await gate(b)).verdict;
  assert.equal(vb.decision, "REFUSE");
  assert.deepEqual(vb.checks.map((c) => [c.name, c.pass]), [["diff-scope", true], ["merge", false]]);
  assert.match(JSON.stringify(vb.checks[1].reading), /empty/);
  assert.equal(git(bed.paths.live, ["rev-parse", "core-live"]), merged);
});

