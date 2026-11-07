import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { currentRun, tlog, redact } from "./telemetry.ts";

test("currentRun reads RATCHET_RUN, else the highest runs/RUN-NNNN holding a manifest.json; a RUN dir without one (RUN-0001 with only spend-override.json) is no run", () => {
  const runs = mkdtempSync(join(tmpdir(), "runs-"));
  mkdirSync(join(runs, "RUN-0001"));
  writeFileSync(join(runs, "RUN-0001", "spend-override.json"), "{}");
  mkdirSync(join(runs, "prerun"));
  assert.equal(currentRun(runs, {}), null);
  writeFileSync(join(runs, "RUN-0001", "manifest.json"), "{}");
  assert.equal(currentRun(runs, {}), "RUN-0001");
  mkdirSync(join(runs, "RUN-0002"));
  assert.equal(currentRun(runs, {}), "RUN-0001");
  assert.equal(currentRun(runs, { RATCHET_RUN: "RUN-0009" }), "RUN-0009");
  assert.equal(currentRun(join(runs, "absent"), {}), null);
});

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

test("redact keeps token counts and redacts token credentials", () => {
  assert.deepEqual(redact({ tokens: { in: 4 }, input_tokens: 9, tokens_in: 1, max_tokens: 2, token: "t", access_token: "a", refresh_token: "r" }),
    { tokens: { in: 4 }, input_tokens: 9, tokens_in: 1, max_tokens: 2, token: "[redacted]", access_token: "[redacted]", refresh_token: "[redacted]" });
});

test("redact leaves non-secret fields unchanged", () => {
  assert.deepEqual(redact({ a: 1, b: [{ c: "x" }] }), { a: 1, b: [{ c: "x" }] });
});

test("redact keeps token usage counts and blanks credential fields", () => {
  assert.deepEqual(redact({ tokens_in: 5, usage: { prompt_tokens: 3 }, access_token: "t", gemini_api_key: "g" }),
    { tokens_in: 5, usage: { prompt_tokens: 3 }, access_token: "[redacted]", gemini_api_key: "[redacted]" });
});
