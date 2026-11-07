// The repairer run (SPEC §5 S8 `loop/repair.ts`, G8, D-0011, D-0001). `runRepair(task, packet, opts)` runs one
// repairer session in the scratch repo under a fresh HOME and XDG_CONFIG_HOME (settings from loop/muse-settings.json,
// every bundled and plugin skill off; no auth file copied, the key passes as META_API_KEY), a fresh session id,
// the skills dir made read-only (chmod -R a-w), `muse skills list --enabled-only --json` logged, ATTEMPT_ID and
// RATCHET_SERVER in the environment; it captures the JSONL events, reads packet/RESULT.json and takes the
// scratch repo's diff. Every repairer invocation goes through one MuseRunner: `museCli` runs D-0001's command
// line, `fakeRunner` is the test one, and an API-loop runner plugs in behind the same interface.

import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git } from "./paths.ts";
import type { Packet } from "./projection.ts";
import { tlog } from "../src/telemetry.ts";
import { priceUsd } from "./llm.ts";
import type { Attempt, RepairResult, RepairTask } from "../src/schema.ts";

// ---- Muse Code invocation (D-0001, measured on Muse Code 1.4.14 (1.4.14-R7309.1), 2026-11-07) ----
/** The Muse Code binary; MUSE_BIN overrides it. */
export const MUSE_BIN = process.env.MUSE_BIN ?? "muse";
/** The executor model D-0001 pins. */
export const MUSE_MODEL = "muse-spark-1.3";
/** The prompt file, relative to the scratch repo (D-0001). */
export const MUSE_PROMPT_FILE = "packet/TASK.md";
/** D-0001's argv after `muse`, with the session id and step cap filled in. */
export function museArgs(sessionId: string, maxSteps: number): string[] {
  return ["exec", "--json", "--prompt-file", MUSE_PROMPT_FILE, "--session-id", sessionId, "--max-model-steps", String(maxSteps),
    "--approval-mode", "never", "--disable-approval", "--model", MUSE_MODEL, "--disable-web-tools", "--disable-reminders",
    "-c", "agents.execution_capacity=1", "--trust-workspace"];
}
/** The skills listing every attempt logs (D-0001: G8's "empty" reads on --enabled-only). */
export const MUSE_SKILLS_LIST = ["skills", "list", "--enabled-only", "--json"] as const;
/** The env var Muse reads its key from; .env's `muse_code_key` fills it (D-0001). */
export const MUSE_KEY_VAR = "META_API_KEY";
/** settings.json written into each fresh XDG_CONFIG_HOME/muse/: all 25 bundled skills and 1 plugin skill off (D-0001). */
export const MUSE_SETTINGS_FILE = join(import.meta.dirname, "muse-settings.json");
/** Observers are the reminder agents; --disable-reminders turns them off (D-0001). */
export const OBSERVERS: Attempt["isolation"]["observers"] = "off";
/** --disable-web-tools (D-0001). */
export const WEB_TOOLS: Attempt["isolation"]["web_tools"] = "off";

export interface MuseRun {
  cwd: string; env: Record<string, string>; sessionId: string;
  maxSteps: number; wallS: number; eventsFile: string;
}
export interface MuseOutcome { exitCode: number; model: string; steps: number; tokens_in: number; tokens_out: number; wall_s: number }

/** The one seam every repairer invocation passes through. */
export interface MuseRunner {
  skillsList(cwd: string, env: Record<string, string>): Promise<string>;
  run(r: MuseRun): Promise<MuseOutcome>;
}

function exec(bin: string, args: string[], cwd: string, env: Record<string, string>, outFile?: string, wallS = 60): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    const ch = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }); // stdin < /dev/null
    let out = "";
    const timer = setTimeout(() => ch.kill("SIGTERM"), wallS * 1000);
    ch.stdout.on("data", (d) => { out += d; if (outFile) writeFileSync(outFile, d, { flag: "a" }); });
    ch.stderr.on("data", () => {});
    ch.on("error", () => { clearTimeout(timer); res({ code: 127, out }); });
    ch.on("close", (code) => { clearTimeout(timer); res({ code: code ?? 1, out }); });
  });
}

/**
 * Spend from Muse's --json MSP records `{schema_version, stream, record_type, payload: {kind, …}}` (D-0001):
 * tokens summed over `run_usage` payloads (children not included), model from `run_model_configured.model_id`
 * or a usage payload's `model`, steps as the count of `run_usage` payloads. Usage field names other than kind,
 * model and model_id are unmeasured; both input_tokens/output_tokens and prompt_tokens/completion_tokens read.
 */
export function usageFromEvents(lines: string): { model: string; steps: number; tokens_in: number; tokens_out: number } {
  let model = "", steps = 0, tokens_in = 0, tokens_out = 0;
  for (const l of lines.split("\n")) {
    if (!l.trim()) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(l); } catch { continue; }
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (p.kind === "run_model_configured" && typeof p.model_id === "string") model = p.model_id;
    if (p.kind === "run_usage") {
      steps++;
      if (typeof p.model === "string") model = p.model;
      const u = (p.usage ?? p) as Record<string, unknown>;
      tokens_in += Number(u.input_tokens ?? u.prompt_tokens ?? 0) || 0;
      tokens_out += Number(u.output_tokens ?? u.completion_tokens ?? 0) || 0;
    }
  }
  return { model, steps, tokens_in, tokens_out };
}

/** The real runner: D-0001's command line, cwd the scratch repo, stdin /dev/null. */
export const museCli: MuseRunner = {
  async skillsList(cwd, env) {
    const r = await exec(MUSE_BIN, [...MUSE_SKILLS_LIST], cwd, env);
    return r.code === 127 ? `(${MUSE_BIN} not found)` : r.out.trim();
  },
  async run(r) {
    const t0 = Date.now();
    const x = await exec(MUSE_BIN, museArgs(r.sessionId, r.maxSteps), r.cwd, r.env, r.eventsFile, r.wallS);
    const ev = usageFromEvents(x.out);
    // the session journal holds every model call's usage, including calls before a wall kill (run_usage is lost)
    const js = r.env.HOME ? usageFromSession(r.env.HOME, r.sessionId) : null;
    const u = js && js.tokens_in >= ev.tokens_in ? js : ev;
    if (js) tlog("loop", "muse-usage", { session: r.sessionId, exit: x.code, ...js });
    return { exitCode: x.code, model: u.model || ev.model || `${MUSE_MODEL} (not echoed)`, steps: u.steps, tokens_in: u.tokens_in, tokens_out: u.tokens_out, wall_s: (Date.now() - t0) / 1000 };
  },
};

/**
 * Usage from Muse's session journal under the isolated HOME, `.local/share/muse/sessions/<y>/<m>/<d>/<sessionId>/
 * session.jsonl` (layout read on Muse Code 1.4.14, 2026-11-07): one `model_completed` run event per model call
 * with `usage` {input_tokens, output_tokens, cached_tokens} and `duration_ms`. Steps are the model calls; null
 * when no journal for the session exists.
 */
export function usageFromSession(home: string, sessionId: string): { model: string; steps: number; tokens_in: number; tokens_out: number; cached_tokens: number; model_ms: number } | null {
  const root = join(home, ".local", "share", "muse", "sessions");
  if (!existsSync(root)) return null;
  const hit = readdirSync(root, { recursive: true, encoding: "utf8" }).find((p) => p.endsWith(join(sessionId, "session.jsonl")) && !p.includes(".msp-view"));
  if (!hit) return null;
  const out = { model: "", steps: 0, tokens_in: 0, tokens_out: 0, cached_tokens: 0, model_ms: 0 };
  for (const l of readFileSync(join(root, hit), "utf8").split("\n")) {
    if (!l.includes("model_completed")) continue;
    let e: { payload?: { event?: { kind?: string; usage?: Record<string, number>; duration_ms?: number; model?: string } } };
    try { e = JSON.parse(l); } catch { continue; }
    const ev = e.payload?.event;
    if (ev?.kind !== "model_completed") continue;
    const u = ev.usage ?? {};
    out.steps++;
    out.tokens_in += Number(u.input_tokens ?? 0) || 0;
    out.tokens_out += Number(u.output_tokens ?? 0) || 0;
    out.cached_tokens += Number(u.cached_tokens ?? u.cache_read_tokens ?? 0) || 0;
    out.model_ms += Number(ev.duration_ms ?? 0) || 0;
    if (typeof ev.model === "string") out.model = ev.model;
  }
  return out;
}

/** A test runner: applies `edit(scratchDir)` and writes `result` to packet/RESULT.json, emitting MSP-shaped events. */
export function fakeRunner(edit: (dir: string) => void, result: RepairResult | null, model = "fake-muse"): MuseRunner & { calls: MuseRun[] } {
  const calls: MuseRun[] = [];
  return {
    calls,
    async skillsList() { return "[]"; },
    async run(r) {
      calls.push(r);
      edit(r.cwd);
      if (result) writeFileSync(join(r.cwd, "packet", "RESULT.json"), JSON.stringify(result));
      writeFileSync(r.eventsFile, JSON.stringify({ schema_version: 1, stream: r.sessionId, record_type: "event", payload: { kind: "run_usage", model, input_tokens: 0, output_tokens: 0 } }) + "\n");
      return { exitCode: 0, model, steps: 1, tokens_in: 0, tokens_out: 0, wall_s: 0 };
    },
  };
}

/** Reads .env lines KEY=VALUE without printing them (SPEC §7.4); a missing file reads empty. */
export function readDotEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const l of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(l);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

export interface RepairOutput {
  result: RepairResult | null;
  diff: string;
  model: string;
  spent: Attempt["spent"];
  isolation: Attempt["isolation"];
  eventsFile: string;
  exitCode: number;
}

export interface RepairOptions { attempt: string; server: string; runner: MuseRunner; dotEnv?: string }

/** The scratch repo's diff against its projection commit, every path but packet/RESULT.json and node_modules. */
export function scratchDiff(dir: string): string {
  git(dir, ["add", "-A", "--", ".", ":!packet/RESULT.json", ":!node_modules"]);
  return git(dir, ["diff", "--cached", "--no-color", "--binary", "HEAD"]) + "\n";
}

/**
 * The repairer's environment: D-0001's PATH, fresh HOME and XDG_CONFIG_HOME, META_API_KEY, MUSE_NO_AUTO_UPDATE=1,
 * TERM=dumb, plus SPEC §5 S8's ATTEMPT_ID and RATCHET_SERVER and the packet's RATCHET_ROMS and RATCHET_CACHE.
 */
export function repairEnv(home: string, xdg: string, key: string | undefined, attempt: string, server: string, packetEnv: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, XDG_CONFIG_HOME: xdg, MUSE_NO_AUTO_UPDATE: "1", TERM: "dumb",
    ATTEMPT_ID: attempt, RATCHET_SERVER: server, ...packetEnv,
  };
  if (key) env[MUSE_KEY_VAR] = key;
  return env;
}

/** Runs the repairer for `task` in `packet.dir` (see the file header). */
export async function runRepair(task: RepairTask, packet: Packet, o: RepairOptions): Promise<RepairOutput> {
  const home = `${packet.dir}.home`;
  rmSync(home, { recursive: true, force: true });
  const xdg = join(home, ".config");
  mkdirSync(join(xdg, "muse"), { recursive: true });
  copyFileSync(MUSE_SETTINGS_FILE, join(xdg, "muse", "settings.json"));
  const dot = readDotEnv(o.dotEnv ?? join(import.meta.dirname, "..", ".env"));
  const key = process.env[MUSE_KEY_VAR] ?? dot[MUSE_KEY_VAR] ?? dot.muse_code_key;
  const env = repairEnv(home, xdg, key, o.attempt, o.server, packet.env);
  const skillsDir = join(packet.dir, ".agents", "skills");
  if (existsSync(skillsDir)) execFileSync("chmod", ["-R", "a-w", skillsDir]);
  const skills_list = (await o.runner.skillsList(packet.dir, env)).slice(0, 1500);
  const eventsFile = join(home, "events.jsonl");
  writeFileSync(eventsFile, "");
  const out = await o.runner.run({ cwd: packet.dir, env, sessionId: randomUUID(), maxSteps: task.budget.max_steps, wallS: task.budget.wall_s, eventsFile });
  for (const l of readFileSync(eventsFile, "utf8").split("\n")) if (l.trim()) { let r: unknown; try { r = JSON.parse(l); } catch { r = { unparsed: l.slice(0, 4096) }; } tlog("muse", "msp", { attempt: o.attempt, record: r }); }
  let result: RepairResult | null = null;
  const rp = join(packet.dir, "packet", "RESULT.json");
  if (existsSync(rp)) { try { result = JSON.parse(readFileSync(rp, "utf8")); } catch { result = null; } }
  return {
    result, diff: scratchDiff(packet.dir), model: out.model, eventsFile, exitCode: out.exitCode,
    spent: { steps: out.steps, wall_s: out.wall_s, tokens_in: out.tokens_in, tokens_out: out.tokens_out, usd: priceUsd(out.model, out.tokens_in, out.tokens_out) },
    isolation: { home, skills_list, observers: OBSERVERS, web_tools: WEB_TOOLS },
  };
}
