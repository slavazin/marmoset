// The Claude Code runner and consolidator call (S23, D-draft-claude-repairer). A run is all-Muse or all-Claude:
// RATCHET_REPAIRER ("muse", the default, or "claude") and RATCHET_REPAIRER_MODEL pick the runner every spawn site
// uses (loop/campaign.ts fast and slow, loop/slow.ts, loop/vread.ts, loop/once.ts) and the consolidator call
// (loop/consolidate.ts). loop/run-conditions.ts records the choice, so --resume under another runner refuses.
// Offers:
//   repairerChoice(env)   {runner, model} from the environment; throws on an unknown runner;
//   claudeArgs(...)       `claude -p` argv: headless, stream-json, --max-turns MAX_STEPS, Bash/Read/Edit/Write/Glob/Grep
//                         only, no user/project settings, no skills, no MCP, no session persistence, a fresh session id;
//   claudeCli             the MuseRunner over that argv, run in the scratch repo under seatbelt (loop/confine.ts with
//                         the `claude` paths: the owner's real HOME for auth, its ~/.claude history denied);
//   usageFromClaude(out)  steps, tokens and echoed model from the stream-json events;
//   claudeChat            the Llm seam (loop/llm.ts) over `claude -p` with no tools, for the consolidator;
//   selectedRunner(), selectedLlm()  what a spawn site uses.
// Spend: Claude runs on the owner's subscription; loop/llm.ts PRICES prices CLAUDE_MODEL at 0 and spend records carry
// billing "subscription". No Meta key is read by a Claude run.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { confineOn, confinedCommand } from "./confine.ts";
import { MUSE_MODEL, MUSE_PROMPT_FILE, museCli, type MuseRunner } from "./repair.ts";
import { chat, CONSOLIDATOR_MODEL, type Llm, type LlmCall } from "./llm.ts";
import { tlog } from "../src/telemetry.ts";

/** The Claude Code binary; CLAUDE_BIN overrides it. */
export const CLAUDE_BIN = process.env.CLAUDE_BIN ?? join(homedir(), ".local", "bin", "claude");
/**
 * The Claude model for RUN-0005's repairer and consolidator. "claude-sonnet-5-5" is not a model id the CLI knows
 * (v2.1.280 answered unrecognized_model on 2026-11-07); "sonnet" resolved and echoed "claude-sonnet-5", so the id is pinned.
 */
export const CLAUDE_MODEL = "claude-sonnet-5";
/** The tools a Claude repairer has: file read/edit/search and shell; no web, no subagents, no MCP. */
export const CLAUDE_TOOLS = "Bash,Read,Edit,Write,Glob,Grep";

export type RepairerRunner = "muse" | "claude";
export interface RepairerChoice { runner: RepairerRunner; model: string }

/** The run's repairer (see the file header). */
export function repairerChoice(env: NodeJS.ProcessEnv = process.env): RepairerChoice {
  const runner = (env.RATCHET_REPAIRER || "muse") as RepairerRunner;
  if (runner !== "muse" && runner !== "claude") throw new Error(`RATCHET_REPAIRER=${runner}: want muse or claude`);
  if (runner === "muse") return { runner, model: MUSE_MODEL };
  return { runner, model: env.RATCHET_REPAIRER_MODEL || CLAUDE_MODEL };
}

/** `claude` argv for one repairer attempt in its scratch repo (see the file header). */
export function claudeArgs(prompt: string, sessionId: string, maxTurns: number, model: string): string[] {
  return ["-p", prompt, "--output-format", "stream-json", "--verbose", "--model", model, "--max-turns", String(maxTurns),
    "--session-id", sessionId, "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands",
    "--tools", CLAUDE_TOOLS, "--dangerously-skip-permissions"];
}

/** The task prompt: read packet/TASK.md and do it (the same prompt file museArgs names). */
export const CLAUDE_PROMPT = `Read ${MUSE_PROMPT_FILE} in the current directory and carry out the task it describes, working only inside the current directory. Write packet/RESULT.json as the task file says before you stop.`;

/** Steps (assistant messages, or the result's num_turns), tokens and the echoed model from stream-json lines. */
export function usageFromClaude(lines: string): { model: string; steps: number; tokens_in: number; tokens_out: number; cached_tokens: number; result?: string } {
  let model = "", steps = 0, tokens_in = 0, tokens_out = 0, cached = 0, result: string | undefined, fromResult = false;
  for (const l of lines.split("\n")) {
    if (!l.trim()) continue;
    let e: Record<string, any>;
    try { e = JSON.parse(l); } catch { continue; }
    if (e.type === "system" && e.subtype === "init" && typeof e.model === "string") model ||= e.model;
    if (e.type === "assistant" && e.message) {
      steps++;
      if (typeof e.message.model === "string") model = e.message.model;
      const u = e.message.usage ?? {};
      if (!fromResult) {
        tokens_in += (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0);
        tokens_out += Number(u.output_tokens) || 0;
        cached += Number(u.cache_read_input_tokens) || 0;
      }
    }
    if (e.type === "result") {
      if (typeof e.result === "string") result = e.result;
      if (typeof e.num_turns === "number") steps = Math.max(steps, e.num_turns);
      const mu = e.modelUsage && typeof e.modelUsage === "object" ? Object.keys(e.modelUsage) : [];
      if (mu.length && !model) model = mu[0];
      const u = e.usage ?? {};
      const ti = (Number(u.input_tokens) || 0) + (Number(u.cache_creation_input_tokens) || 0) + (Number(u.cache_read_input_tokens) || 0);
      if (ti) { tokens_in = ti; tokens_out = Number(u.output_tokens) || 0; cached = Number(u.cache_read_input_tokens) || 0; fromResult = true; }
    }
  }
  return { model, steps, tokens_in, tokens_out, cached_tokens: cached, result };
}

function run(cmd: string, argv: string[], cwd: string, env: Record<string, string>, wallS: number, outFile?: string, stdin?: string): Promise<{ code: number; out: string; killed: boolean }> {
  return new Promise((res) => {
    const ch = spawn(cmd, argv, { cwd, env, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    if (stdin !== undefined) ch.stdin!.end(stdin);
    let out = "", killed = false;
    const timer = setTimeout(() => { killed = true; ch.kill("SIGTERM"); setTimeout(() => ch.kill("SIGKILL"), 5000); }, wallS * 1000);
    ch.stdout!.on("data", (d) => { out += d; if (outFile) writeFileSync(outFile, d, { flag: "a" }); });
    ch.stderr!.on("data", () => {});
    ch.on("error", () => { clearTimeout(timer); res({ code: 127, out, killed }); });
    ch.on("close", (code) => { clearTimeout(timer); res({ code: code ?? 1, out, killed }); });
  });
}

/**
 * The child environment: the repairer env with HOME set back to the owner's (the CLI's keychain auth needs it; the
 * fresh attempt HOME stays as RATCHET_ATTEMPT_HOME) and no Meta key. CLAUDE_CODE_DISABLE_AUTO_MEMORY keeps memory off.
 */
export function claudeEnv(env: Record<string, string>): Record<string, string> {
  const { META_API_KEY: _k, XDG_CONFIG_HOME: _x, ...rest } = env;
  // USER and LOGNAME: without them the CLI finds no keychain login ("Not logged in", read 2026-11-07)
  return { ...rest, HOME: homedir(), USER: userInfo().username, LOGNAME: userInfo().username, RATCHET_ATTEMPT_HOME: env.HOME ?? "", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", DISABLE_AUTOUPDATER: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
}

/** The Claude Code runner (see the file header). */
export const claudeCli: MuseRunner = {
  async skillsList() { return "[] (claude: --disable-slash-commands, --setting-sources \"\")"; },
  async run(r) {
    const t0 = Date.now();
    const { model } = repairerChoice();
    const on = confineOn();
    const c = confinedCommand(CLAUDE_BIN, claudeArgs(CLAUDE_PROMPT, r.sessionId, r.maxSteps, model), r.cwd, r.env.HOME, on, { realHome: homedir() });
    tlog("loop", "confine", { attempt: r.env.ATTEMPT_ID, runner: "claude", confine: c.confine, profile: c.profile ?? null, sha256: c.sha256 ?? null });
    const x = await run(c.cmd, c.argv, r.cwd, claudeEnv(r.env), r.wallS, r.eventsFile);
    const u = usageFromClaude(x.out);
    tlog("loop", "claude-usage", { session: r.sessionId, exit: x.code, wall_killed: x.killed, model: u.model, steps: u.steps, n_in: u.tokens_in, n_out: u.tokens_out, n_cached: u.cached_tokens });
    return { exitCode: x.code, model: u.model || `${model} (not echoed)`, steps: u.steps, tokens_in: u.tokens_in, tokens_out: u.tokens_out, wall_s: (Date.now() - t0) / 1000, confine: c.confine };
  },
};

/** Wall of one consolidator call through the CLI, in seconds. */
export const CLAUDE_CHAT_WALL_S = 900;

/** The Llm seam over `claude -p` with no tools (see the file header): system message in --system-prompt, the rest on stdin. */
export const claudeChat: Llm = async (req) => {
  const { model } = repairerChoice();
  const sys = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const user = req.messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n\n");
  const dir = mkdtempSync(join(tmpdir(), "ratchet-claude-chat-"));
  // the user message goes on stdin: a consolidator view can exceed argv's size limit
  const argv = ["-p", "--output-format", "stream-json", "--verbose", "--model", model, "--max-turns", "1",
    "--no-session-persistence", "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--tools", "", "--system-prompt", sys];
  const t0 = Date.now();
  tlog("llm", "request", { role: req.role, model_requested: model, runner: "claude", messages: req.messages });
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir(), USER: userInfo().username, LOGNAME: userInfo().username, TERM: "dumb", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", DISABLE_AUTOUPDATER: "1" };
  const x = await run(CLAUDE_BIN, argv, dir, env, CLAUDE_CHAT_WALL_S, undefined, user);
  const u = usageFromClaude(x.out);
  const text = u.result ?? "";
  const error = x.killed ? `wall ${CLAUDE_CHAT_WALL_S}s` : x.code !== 0 ? `claude exit ${x.code}: ${text.slice(0, 300)}` : !text.trim() ? "no usable output" : undefined;
  const call: LlmCall = { ok: !error, text, reasoning: "", model_echoed: u.model, finish_reason: x.code === 0 ? "stop" : null,
    usage: { prompt: u.tokens_in, completion: u.tokens_out, reasoning: 0 }, wall_ms: Date.now() - t0, http_status: 0, error };
  tlog("llm", "response", { role: req.role, model_requested: model, model_echoed: call.model_echoed, runner: "claude", outcome: call.ok ? "ok" : "failed", error: call.error ?? null,
    n_prompt: call.usage.prompt, n_completion: call.usage.completion, wall_ms: call.wall_ms, text });
  return call;
};

/** The repairer runner this process's run uses. */
export function selectedRunner(env: NodeJS.ProcessEnv = process.env): MuseRunner {
  return repairerChoice(env).runner === "claude" ? claudeCli : museCli;
}
/** The consolidator call and the model it requests for this process's run. */
export function selectedLlm(env: NodeJS.ProcessEnv = process.env): { llm: Llm; model: string } {
  const c = repairerChoice(env);
  return c.runner === "claude" ? { llm: claudeChat, model: c.model } : { llm: chat, model: CONSOLIDATOR_MODEL };
}
