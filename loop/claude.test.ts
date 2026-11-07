// loop/claude.ts: the Claude runner's argv, its usage reading, its seatbelt scope, run-wide selection and pricing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { claudeArgs, claudeEnv, repairerChoice, selectedLlm, selectedRunner, usageFromClaude, CLAUDE_MODEL, CLAUDE_TOOLS } from "./claude.ts";
import { museCli, MUSE_MODEL } from "./repair.ts";
import { claudeCli } from "./claude.ts";
import { chat, CONSOLIDATOR_MODEL, priceUsd } from "./llm.ts";
import { seatbeltProfile, real } from "./confine.ts";
import { MAX_STEPS } from "./gate.ts";
import { git, type LoopPaths } from "./paths.ts";
import { checkConditions, conditionDiffs, openConditions, runConditions, type ConditionsInput } from "./run-conditions.ts";

test("repairerChoice reads muse by default, claude with its pinned model, and refuses another runner name", () => {
  assert.deepEqual(repairerChoice({}), { runner: "muse", model: MUSE_MODEL });
  assert.deepEqual(repairerChoice({ RATCHET_REPAIRER: "claude" }), { runner: "claude", model: CLAUDE_MODEL });
  assert.deepEqual(repairerChoice({ RATCHET_REPAIRER: "claude", RATCHET_REPAIRER_MODEL: "claude-opus-5" }), { runner: "claude", model: "claude-opus-5" });
  assert.throws(() => repairerChoice({ RATCHET_REPAIRER: "gpt" }), /want muse or claude/);
});

test("selectedRunner and selectedLlm pick one side for repairer and consolidator together", () => {
  assert.equal(selectedRunner({}), museCli);
  assert.equal(selectedRunner({ RATCHET_REPAIRER: "claude" }), claudeCli);
  assert.equal(selectedLlm({}).llm, chat);
  assert.equal(selectedLlm({}).model, CONSOLIDATOR_MODEL);
  assert.notEqual(selectedLlm({ RATCHET_REPAIRER: "claude" }).llm, chat);
  assert.equal(selectedLlm({ RATCHET_REPAIRER: "claude" }).model, CLAUDE_MODEL);
});

test("claudeArgs caps turns at the step cap, names only file and shell tools, and loads no settings, skills, MCP or saved session", () => {
  const a = claudeArgs("p", "sid", MAX_STEPS, CLAUDE_MODEL);
  const v = (f: string) => a[a.indexOf(f) + 1];
  assert.equal(v("--max-turns"), String(MAX_STEPS));
  assert.equal(v("--model"), CLAUDE_MODEL);
  assert.equal(v("--session-id"), "sid");
  assert.equal(v("--setting-sources"), "");
  assert.equal(v("--tools"), CLAUDE_TOOLS);
  assert.doesNotMatch(CLAUDE_TOOLS, /Web|Agent|Task/);
  for (const f of ["--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands"]) assert.ok(a.includes(f), f);
  assert.ok(!a.includes("--continue") && !a.includes("--resume"));
});

test("claudeEnv drops the Meta key, restores the owner's HOME and keeps the attempt vars", () => {
  const e = claudeEnv({ HOME: "/tmp/att.home", META_API_KEY: "k", XDG_CONFIG_HOME: "/x", ATTEMPT_ID: "ATT-1", RATCHET_SERVER: "s" });
  assert.equal(e.META_API_KEY, undefined);
  assert.equal(e.XDG_CONFIG_HOME, undefined);
  assert.equal(e.HOME, homedir());
  assert.equal(e.RATCHET_ATTEMPT_HOME, "/tmp/att.home");
  assert.equal(e.ATTEMPT_ID, "ATT-1");
  assert.ok(e.USER);
});

test("usageFromClaude counts assistant turns, takes the result's usage and the echoed model, and survives a cut stream", () => {
  const ev = [
    { type: "system", subtype: "init", model: "claude-sonnet-5" },
    { type: "assistant", message: { model: "claude-sonnet-5", usage: { input_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 5 } } },
    { type: "assistant", message: { model: "claude-sonnet-5", usage: { input_tokens: 1, cache_read_input_tokens: 10, output_tokens: 7 } } },
  ].map((e) => JSON.stringify(e)).join("\n");
  const cut = usageFromClaude(ev + "\n{not json");
  assert.deepEqual({ m: cut.model, s: cut.steps, i: cut.tokens_in, o: cut.tokens_out }, { m: "claude-sonnet-5", s: 2, i: 23, o: 12 });
  const full = usageFromClaude(ev + "\n" + JSON.stringify({ type: "result", num_turns: 3, result: "done", usage: { input_tokens: 4, cache_creation_input_tokens: 10, cache_read_input_tokens: 20, output_tokens: 30 }, modelUsage: { "claude-sonnet-5": {} } }));
  assert.deepEqual({ s: full.steps, i: full.tokens_in, o: full.tokens_out, r: full.result }, { s: 3, i: 34, o: 30, r: "done" });
});

test("priceUsd prices Claude models at 0 (subscription) and Muse models above 0", () => {
  assert.equal(priceUsd("claude-sonnet-5", 1e6, 1e6), 0);
  assert.equal(priceUsd("claude-sonnet-5 (not echoed)", 1e6, 1e6), 0);
  assert.ok(priceUsd("muse-spark-1.3", 1000, 1000) > 0);
  assert.ok(priceUsd("unknown-model", 1000, 1000) > 0);
});

test("a Claude seatbelt profile denies the repositories' parent and ~/.claude's history dirs, and keeps the attempt dirs readable and writable", () => {
  const base = mkdtempSync(join(tmpdir(), "ratchet-claude-sb-"));
  const repo = join(base, "GenDev", "marmoset");
  mkdirSync(repo, { recursive: true });
  const home = join(base, "u");
  mkdirSync(join(home, ".claude", "projects"), { recursive: true });
  const att = join(base, "scratch", "ATT-1");
  const p = seatbeltProfile({ attemptDir: att, home: `${att}.home`, envDir: `${att}.env`, scratchRoot: join(base, "scratch"), repos: [repo], cache: join(base, "cache"), lives: [join(base, "GenDev", "ratchet-live")], claude: { realHome: home } });
  const lines = p.split("\n");
  const denyRead = lines.find((l) => l.startsWith("(deny file-read*"))!;
  for (const d of [join(real(base), "GenDev"), join(real(home), ".claude", "projects"), join(real(home), ".claude", "history.jsonl"), join(real(home), ".claude", "skills"), join(real(home), ".cache")]) assert.ok(denyRead.includes(JSON.stringify(d)), d);
  const last = lines.filter((l) => l.startsWith("(allow file-write*")).pop()!;
  assert.ok(last.includes(JSON.stringify(real(att))));
  // the history dirs are denied for writes after ~/.claude is opened for the CLI
  const iOpen = lines.findIndex((l) => l.includes(`(subpath ${JSON.stringify(join(real(home), ".claude"))})`) && l.startsWith("(allow file-write*"));
  const iDeny = lines.findIndex((l, i) => i > iOpen && l.startsWith("(deny file-write*") && l.includes(join(real(home), ".claude", "projects")));
  assert.ok(iOpen > 0 && iDeny > iOpen);
  // a Muse profile carries none of it
  const m = seatbeltProfile({ attemptDir: att, home: `${att}.home`, envDir: `${att}.env`, scratchRoot: join(base, "scratch"), repos: [repo], cache: join(base, "cache"), lives: [] });
  assert.ok(!m.includes(".claude"));
});

function bed() {
  const root = mkdtempSync(join(tmpdir(), "ratchet-claude-cond-"));
  const live = join(root, "live");
  mkdirSync(join(live, "core"), { recursive: true });
  writeFileSync(join(live, "core", "index.ts"), "export {};\n");
  git(live, ["init", "--quiet", "-b", "core-claude"]);
  git(live, ["add", "core"]);
  git(live, ["commit", "--quiet", "-m", "s0"]);
  const rom = join(root, "game.gb"); writeFileSync(rom, "rom");
  const splits = join(root, "splits.json"); writeFileSync(splits, "{}");
  const runs = join(root, "repo", "runs"); mkdirSync(runs, { recursive: true });
  const d = (n: string) => join(root, "run5", n);
  const paths: LoopPaths = { root: join(root, "repo"), ledger: d("ledger"), traces: d("traces"), skills: d("skills"), evidence: d("evidence"), live, cache: d("cache"), roms: join(root, "roms"), server: "http://localhost:1", scratch: d("scratch") };
  const env = { RATCHET_TELEMETRY_DIR: d("telemetry"), RATCHET_SUBQ_CACHE: d("subq") };
  const input: ConditionsInput = { run: "RUN-0005", paths, runsDir: runs, rom, source: "play", seed0: 1001, liveBranch: "core-claude", splits: [splits], ruleVersion: "rv", env };
  return input;
}

test("conditions.json records a Claude runner, and --resume refuses a runner change either way", () => {
  const claude = { runner: "claude" as const, model: CLAUDE_MODEL };
  const muse = { runner: "muse" as const, model: MUSE_MODEL };
  const i = bed();
  const c = openConditions(runConditions({ ...i, repairer: claude }));
  assert.deepEqual(c.repairer, claude);
  assert.doesNotThrow(() => checkConditions(runConditions({ ...i, repairer: claude })));
  assert.throws(() => checkConditions(runConditions({ ...i, repairer: muse })), /repairer/);
  assert.throws(() => checkConditions(runConditions({ ...i, repairer: { runner: "claude", model: "claude-opus-5" } })), /repairer/);
  // a Muse run records Muse by omission and refuses a Claude resume
  const j = bed();
  const m = openConditions(runConditions({ ...j, repairer: muse }));
  assert.equal(m.repairer, undefined);
  assert.doesNotThrow(() => checkConditions(runConditions({ ...j, repairer: muse })));
  assert.throws(() => checkConditions(runConditions({ ...j, repairer: claude })), /repairer: declared muse/);
  assert.deepEqual(conditionDiffs(m, runConditions({ ...j })), []);
});
