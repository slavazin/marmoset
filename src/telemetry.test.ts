import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tlog, redact } from "./telemetry.ts";

test("tlog appends one redacted JSONL record per call to <dir>/<stream>.jsonl", () => {
  const dir = mkdtempSync(join(tmpdir(), "tel-"));
  process.env.RATCHET_TELEMETRY_DIR = dir;
  tlog("llm", "call", { model: "m", headers: { Authorization: "Bearer x" }, api_key: "k" });
  tlog("llm", "call", { model: "n" });
  delete process.env.RATCHET_TELEMETRY_DIR;
  const lines = readFileSync(join(dir, "llm.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].data.headers.Authorization, "[redacted]");
  assert.equal(lines[0].data.api_key, "[redacted]");
  assert.ok(lines[1].seq > lines[0].seq);
});

test("redact leaves non-secret fields unchanged", () => {
  assert.deepEqual(redact({ a: 1, b: [{ c: "x" }] }), { a: 1, b: [{ c: "x" }] });
});

test("redact keeps token usage counts and blanks credential fields", () => {
  assert.deepEqual(redact({ tokens_in: 5, usage: { prompt_tokens: 3 }, access_token: "t", gemini_api_key: "g" }),
    { tokens_in: 5, usage: { prompt_tokens: 3 }, access_token: "[redacted]", gemini_api_key: "[redacted]" });
});
