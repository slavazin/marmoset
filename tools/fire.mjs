#!/usr/bin/env node
// The hook command a shown skill compiles into (SPEC §6.12, D-0001): `node tools/fire.mjs SKL-NNNN`.
// Muse runs it on PreToolUse with a cleared environment and the hook payload on stdin
// ({hook_event_name, tool_name, tool_input: {path, …}, session_id, cwd, …}). It reads the skill's activation
// `paths` and `owed` from .agents/skills/<id>/SKILL.md, and when tool_input.path matches one of the paths it
// POSTs {skill, attempt, path, owed} to <server>/fire, with attempt and server read from packet/ATTEMPT.json in
// the scratch repo, and prints the owed line. Exits 0 on every path, so a lost fire never blocks the tool call.
// Dependency-free, so it runs from the scratch repo.
import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute, relative } from "node:path";

const skill = process.argv[2] ?? "";

function readStdin() {
  if (process.stdin.isTTY) return "";
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

function json(p, dflt) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return dflt; }
}

/** A glob (`*` within a segment, `**` across segments) as a RegExp over posix paths. */
export function globRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

function activation(root, id) {
  const f = join(root, ".agents", "skills", id, "SKILL.md");
  if (!existsSync(f)) return { paths: [], owed: "" };
  const fm = /^---\n([\s\S]*?)\n---/.exec(readFileSync(f, "utf8"))?.[1] ?? "";
  const unq = (s) => s.trim().replace(/^["']|["']$/g, "");
  const paths = (/^\s*paths:\s*\[(.*)\]\s*$/m.exec(fm)?.[1] ?? "").split(",").map(unq).filter(Boolean);
  return { paths, owed: unq(/^\s*owed:\s*(.*)$/m.exec(fm)?.[1] ?? "") };
}

let payload = {};
try { payload = JSON.parse(readStdin() || "{}"); } catch { /* no payload: no path, no fire */ }
const root = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();
let path = String(payload.tool_input?.path ?? payload.tool_input?.file_path ?? "");
if (path && isAbsolute(path)) path = relative(root, path);
path = path.split("\\").join("/").replace(/^\.\//, "");
const { paths, owed } = activation(root, skill);
const meta = json(join(root, "packet", "ATTEMPT.json"), {});
const server = meta.server ?? process.env.RATCHET_SERVER ?? "http://localhost:8787";
const attempt = meta.attempt ?? process.env.ATTEMPT_ID ?? "";

if (path && paths.some((g) => globRe(g).test(path))) {
  try {
    await fetch(`${server}/fire`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ skill, attempt, path, owed }), signal: AbortSignal.timeout(2000),
    });
  } catch { /* server down: the fire is lost, the tool call proceeds */ }
  if (owed) console.log(`${skill} owes: ${owed}`);
}
process.exit(0);
