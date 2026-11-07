// The S0 Wiggle repairer (ledger/decisions/D-0016.md): a minimal edit loop over the streaming
// Meta API, for when Muse Code cannot run isolated (D-0011). Each round sends the task, every file under the
// writable prefix and the previous check output; the model answers with whole files; the loop writes only files
// under the prefix, runs the check commands, and stops on a passing check or after MAX_ROUNDS.
//
//   node scripts/api-loop.ts --task <prompt.md> --dir <repo> [--prefix core/] [--model muse-spark-1.3]
//        [--log <rounds.jsonl>] [--rounds 4] [--check "<cmd>"]...
//
// Offers a caller (S8 fallback): runApiLoop(opts) → RoundRecord[]; streamChat(...) for one streamed call.
// The key comes from $muse_code_key, else the file $RATCHET_ENV_FILE (default <dir>/.env); it is never printed, and no log carries a header.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

/** Rounds before the loop stops without a passing check (SPEC §5 S0 Wiggle: "repeat ≤ 4"). */
export const MAX_ROUNDS = 4;
/** Meta's OpenAI-compatible chat endpoint; GET /v1/models listed muse-spark-1.3 and muse-wonder-1.0 on 2026-11-07. */
export const META_CHAT_URL = "https://api.meta.ai/v1/chat/completions";
/** Bytes of check output fed back to the model per round (the tail is kept). */
export const CHECK_TAIL_BYTES = 24_000;
/** Wall cap per check command, in milliseconds; a hung core must not hang the loop. */
export const CHECK_TIMEOUT_MS = 8 * 60_000;
/**
 * max_tokens per call. Meta's cap counts reasoning tokens too, so a low cap returns empty content (D-0001);
 * without it, a muse-spark-1.3 call stopped at 12,276 completion tokens (evidence/s1-core/rounds.jsonl, round 1).
 */
export const MAX_TOKENS = 64_000;

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
export interface StreamResult { content: string; finish_reason: string | null; usage: Record<string, unknown> | null; ms: number; model: string | null }

function apiKey(repo: string): string {
  if (process.env.muse_code_key) return process.env.muse_code_key;
  const env = process.env.RATCHET_ENV_FILE ?? join(repo, ".env");
  const m = existsSync(env) ? readFileSync(env, "utf8").match(/^muse_code_key=(.*)$/m) : null;
  if (!m || !m[1].trim()) throw new Error("muse_code_key is absent from the environment and .env");
  return m[1].trim();
}

/**
 * One streamed chat call with no idle timeout (SPEC §1.4 F4: long calls reason silently for minutes).
 * Resolves with the concatenated content; an empty content is a result, not a throw.
 */
export function streamChat(key: string, model: string, messages: ChatMessage[], effort?: string, onDelta?: (n: number) => void): Promise<StreamResult> {
  const t0 = Date.now();
  const body = JSON.stringify({ model, stream: true, stream_options: { include_usage: true }, max_tokens: MAX_TOKENS, ...(effort ? { reasoning_effort: effort } : {}), messages });
  return new Promise((resolveP, reject) => {
    const req = request(META_CHAT_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      timeout: 0,
      // A fresh connection per call: a reused keep-alive socket that the gateway closed ended calls with
      // "socket hang up" in rounds 2–4 (evidence/s1-core/rounds.jsonl).
      agent: false,
    }, (res) => {
      if (res.statusCode !== 200) {
        let err = "";
        res.on("data", (d) => { err += d; });
        res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${err.slice(0, 500)}`)));
        return;
      }
      res.setEncoding("utf8");
      let buf = ""; let content = ""; let finish: string | null = null; let usage: Record<string, unknown> | null = null; let echoed: string | null = null;
      res.on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") continue;
          try {
            const j = JSON.parse(data);
            echoed ??= j.model ?? null;
            const d = j.choices?.[0]?.delta?.content;
            if (d) { content += d; onDelta?.(content.length); }
            if (j.choices?.[0]?.finish_reason) finish = j.choices[0].finish_reason;
            if (j.usage) usage = j.usage;
          } catch { /* a partial or non-JSON line carries no delta */ }
        }
      });
      res.on("end", () => resolveP({ content, finish_reason: finish, usage, ms: Date.now() - t0, model: echoed }));
      res.on("error", reject);
    });
    req.setTimeout(0);
    req.on("error", reject);
    req.end(body);
  });
}

const FILE_RE = /=== FILE: (\S+) ===\n([\s\S]*?)\n=== END FILE ===/g;

/** The whole files in a reply, keyed by repository-relative path. */
export function parseFiles(reply: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of reply.matchAll(FILE_RE)) out.set(m[1], m[2].replace(/^```[a-z]*\n/, "").replace(/\n```\s*$/, "") + "\n");
  return out;
}

function listFiles(root: string, sub: string): string[] {
  const dir = join(root, sub);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const rel = join(sub, name);
    if (statSync(join(root, rel)).isDirectory()) out.push(...listFiles(root, rel));
    else if (/\.(ts|md|json)$/.test(name)) out.push(rel);
  }
  return out.sort();
}

function runChecks(dir: string, checks: string[]): { ok: boolean; output: string } {
  let out = ""; let ok = true;
  for (const cmd of checks) {
    const r = spawnSync("sh", ["-c", cmd], { cwd: dir, encoding: "utf8", timeout: CHECK_TIMEOUT_MS, maxBuffer: 64 << 20 });
    const code = r.status ?? (r.signal ? `signal ${r.signal}` : "?");
    if (r.status !== 0) ok = false;
    out += `$ ${cmd}\n(exit ${code})\n${r.stdout ?? ""}${r.stderr ?? ""}\n`;
  }
  return { ok, output: out };
}

export interface RoundRecord {
  round: number; calls: number; model: string; echoed_model: string | null; ms: number; finish_reason: string | null;
  usage: Record<string, unknown> | null; files_written: string[]; files_refused: string[]; check_ok: boolean; check_tail: string;
}

export interface LoopOpts { task: string; dir: string; prefix: string; model: string; checks: string[]; rounds: number; log?: string; startRound?: number; previousOutput?: string; files?: string[]; effort?: string }

const FORMAT = [
  "Answer with whole files only, each in exactly this form, with nothing between blocks:",
  "=== FILE: <repository-relative path> ===",
  "<the complete file content>",
  "=== END FILE ===",
  "Send every file you create or change in full; omit unchanged files. Write only paths under the writable prefix.",
  "If your reply runs long, stop after any END FILE line; you will be asked to continue.",
  "After the last file, write the line === DONE ===.",
].join("\n");
/** The line that ends a round's reply. */
const DONE_MARK = "=== DONE ===";
/** Calls per round: the first plus continuations, each bounded by the model's output budget. */
export const MAX_CALLS_PER_ROUND = 8;
const CONTINUE = "Continue with the next file in the same format, starting at a new === FILE: line. Do not repeat a file already sent. End with === DONE === after the last file.";

/** Runs up to opts.rounds rounds; returns one record per round and appends each to opts.log. */
export async function runApiLoop(opts: LoopOpts): Promise<RoundRecord[]> {
  const key = apiKey(opts.dir);
  const records: RoundRecord[] = [];
  let lastOutput = opts.previousOutput ?? "";
  const first = opts.startRound ?? 1;
  for (let round = first; round < first + opts.rounds; round++) {
    const prompt = (only: string | null): string => {
      const files = listFiles(opts.dir, opts.prefix).map((p) => `=== FILE: ${p} ===\n${readFileSync(join(opts.dir, p), "utf8").replace(/\n$/, "")}\n=== END FILE ===`);
      return [
        opts.task,
        `\n## Writable prefix\n${opts.prefix}`,
        `\n## Current files under ${opts.prefix}\n${files.length ? files.join("\n\n") : "(none)"}`,
        lastOutput ? `\n## Output of the checks on the current files (tail)\n${lastOutput.slice(-CHECK_TAIL_BYTES)}\nFix what fails.` : "",
        `\n## Reply format\n${FORMAT}`,
        only ? `\n## This call\nWrite only ${only} now, complete, consistent with the current files; the other files come in their own calls.` : "",
      ].join("\n");
    };
    // Per-file mode (opts.files): one fresh call per named file, each seeing the files written so far.
    // Otherwise: one conversation, continued until the reply carries DONE_MARK or MAX_CALLS_PER_ROUND calls are spent.
    const targets: (string | null)[] = opts.files?.length ? opts.files : [null];
    const res: StreamResult = { content: "", finish_reason: null, usage: {}, ms: 0, model: null };
    const written: string[] = []; const refused: string[] = [];
    let calls = 0;
    const apply = (reply: string): void => {
      for (const [p, text] of parseFiles(reply)) {
        const rel = normalize(p);
        const abs = resolve(opts.dir, rel);
        if (!rel.startsWith(opts.prefix) || rel.endsWith(".test.ts") || relative(resolve(opts.dir, opts.prefix), abs).startsWith("..")) { refused.push(p); continue; }
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, text);
        if (!written.includes(rel)) written.push(rel);
      }
    };
    for (const only of targets) {
      const messages: ChatMessage[] = [{ role: "user", content: prompt(only) }];
      process.stderr.write(`[api-loop] round ${round}${only ? ` ${only}` : ""}: sending ${messages[0].content.length} chars to ${opts.model}\n`);
      for (let c = 0; c < (only ? 1 : MAX_CALLS_PER_ROUND); c++) {
        calls++;
        let lastTick = 0;
        let r: StreamResult;
        try {
          r = await streamChat(key, opts.model, messages, opts.effort, (n) => {
            if (n - lastTick > 20_000) { lastTick = n; process.stderr.write(`[api-loop] round ${round} call ${calls}: ${n} chars received\n`); }
          });
        } catch (e) {
          // A dropped stream ends this target's calls; files already received still apply (SPEC §1.4 F4: no silent retry).
          process.stderr.write(`[api-loop] round ${round} call ${calls}: failed: ${String(e)}\n`);
          res.finish_reason = `error: ${String(e)}`;
          break;
        }
        res.content += r.content; res.ms += r.ms; res.finish_reason = r.finish_reason; res.model ??= r.model;
        for (const k of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
          (res.usage as Record<string, number>)[k] = ((res.usage as Record<string, number>)[k] ?? 0) + Number(r.usage?.[k] ?? 0);
        }
        apply(r.content);
        // Replay log: the request messages, the full reply, tokens, wall time and finish reason of every call.
        if (opts.log) appendFileSync(join(dirname(opts.log), "calls.jsonl"), JSON.stringify({ round, call: calls, only, model: opts.model, effort: opts.effort ?? null, messages, reply: r.content, usage: r.usage, ms: r.ms, finish_reason: r.finish_reason, echoed_model: r.model }) + "\n");
        process.stderr.write(`[api-loop] round ${round} call ${calls}: ${r.ms} ms, ${r.content.length} chars, ${Number(r.usage?.completion_tokens ?? 0)} completion tokens, finish ${r.finish_reason}\n`);
        if (r.content.includes(DONE_MARK) || !r.content.trim()) break;
        messages.push({ role: "assistant", content: r.content }, { role: "user", content: CONTINUE });
      }
    }
    if (opts.log) { mkdirSync(dirname(opts.log), { recursive: true }); writeFileSync(join(dirname(opts.log), `round-${round}.reply.txt`), res.content); }
    const check = runChecks(opts.dir, opts.checks);
    lastOutput = check.output;
    const rec: RoundRecord = {
      round, calls, model: opts.model, echoed_model: res.model, ms: res.ms, finish_reason: res.finish_reason, usage: res.usage,
      files_written: written, files_refused: refused, check_ok: check.ok, check_tail: check.output.slice(-4000),
    };
    records.push(rec);
    if (opts.log) { mkdirSync(dirname(opts.log), { recursive: true }); appendFileSync(opts.log, JSON.stringify(rec) + "\n"); }
    process.stderr.write(`[api-loop] round ${round}: ${res.ms} ms, finish ${res.finish_reason}, ${written.length} files, check ${check.ok ? "ok" : "fail"}\n`);
    if (check.ok) break;
  }
  return records;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      task: { type: "string" }, files: { type: "string" }, effort: { type: "string" }, dir: { type: "string", default: "." }, prefix: { type: "string", default: "core/" },
      model: { type: "string", default: "muse-spark-1.3" }, log: { type: "string" }, rounds: { type: "string", default: String(MAX_ROUNDS) },
      check: { type: "string", multiple: true, default: [] }, "start-round": { type: "string", default: "1" }, "previous-output": { type: "string" },
    },
  });
  if (!values.task) { console.error("usage: scripts/api-loop.ts --task <prompt.md> [--dir .] [--prefix core/] [--check cmd]..."); process.exit(1); }
  const dir = resolve(values.dir!);
  const recs = await runApiLoop({
    task: readFileSync(values.task, "utf8"), dir, prefix: values.prefix!, model: values.model!, checks: values.check as string[],
    files: values.files ? values.files.split(",") : undefined, effort: values.effort,
    rounds: Math.min(Number(values.rounds), MAX_ROUNDS), log: values.log, startRound: Number(values["start-round"]),
    previousOutput: values["previous-output"] ? readFileSync(values["previous-output"], "utf8") : undefined,
  });
  console.log(JSON.stringify(recs.map(({ check_tail: _t, ...r }) => r), null, 2));
}
