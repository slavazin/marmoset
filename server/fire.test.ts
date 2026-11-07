import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { createServer } from "./index.ts";
import { read } from "../loop/ledger.ts";

const FIRE = resolve(import.meta.dirname, "..", "tools", "fire.mjs");

function hook(cwd: string, payload: unknown): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    // a cleared environment, as Muse runs hook commands (D-0001)
    const ch = spawn(process.execPath, [FIRE, "SKL-0001"], { cwd, env: { PATH: process.env.PATH ?? "" }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    ch.stdout.on("data", (d) => (out += d));
    ch.on("close", (code) => res({ code: code ?? 1, out }));
    ch.stdin.end(JSON.stringify(payload));
  });
}

test("tools/fire.mjs under a cleared env posts a matching edit to POST /fire, which appends one Fire; a non-matching path appends none", async () => {
  const t = mkdtempSync(join(tmpdir(), "ratchet-fire-"));
  const ledger = join(t, "ledger");
  mkdirSync(ledger);
  const { server } = createServer({ ledger, runs: join(t, "runs"), evidence: join(t, "ev"), game: join(t, "game"), cache: join(t, "cache") });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as AddressInfo).port;
    const scratch = join(t, "scratch");
    mkdirSync(join(scratch, "packet"), { recursive: true });
    mkdirSync(join(scratch, ".agents", "skills", "SKL-0001"), { recursive: true });
    writeFileSync(join(scratch, "packet", "ATTEMPT.json"), JSON.stringify({ attempt: "ATT-0003", server: `http://127.0.0.1:${port}` }));
    writeFileSync(join(scratch, ".agents", "skills", "SKL-0001", "SKILL.md"), "---\nid: SKL-0001\nactivation:\n  paths: [core/ppu*.ts]\n  owed: name the dot the write lands on\n---\n");
    const hit = await hook(scratch, { hook_event_name: "PreToolUse", tool_name: "edit_file", tool_input: { path: join(scratch, "core", "ppu.ts") }, session_id: "s", cwd: scratch });
    assert.equal(hit.code, 0);
    assert.match(hit.out, /SKL-0001 owes: name the dot the write lands on/);
    const miss = await hook(scratch, { tool_name: "edit_file", tool_input: { path: "core/cpu.ts" }, session_id: "s", cwd: scratch });
    assert.equal(miss.code, 0);
    assert.equal(miss.out, "");
    const fires = read("fires.jsonl", ledger);
    assert.equal(fires.length, 1);
    assert.deepEqual({ ...fires[0], at: undefined, run: undefined }, { id: "FIR-0001", at: undefined, run: undefined, skill: "SKL-0001", attempt: "ATT-0003", path: "core/ppu.ts", owed: "name the dot the write lands on" });
    const bad = await fetch(`http://127.0.0.1:${port}/fire`, { method: "POST", body: JSON.stringify({ skill: "x" }) });
    assert.equal(bad.status, 400);
  } finally { server.close(); }
});
