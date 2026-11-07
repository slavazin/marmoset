import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
const TEL = mkdtempSync(join(tmpdir(), "ratchet-tel-"));
process.env.RATCHET_TELEMETRY_DIR = TEL;
const { chat, foldSse, priceUsd, PRICES } = await import("./llm.ts");

const sse = (chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";

test("foldSse joins streamed content, keeps the echoed model, finish_reason and usage with reasoning tokens", () => {
  const f = foldSse(sse([
    { model: "muse-wonder-1.0", choices: [{ delta: { reasoning_content: "think" } }] },
    { model: "muse-wonder-1.0", choices: [{ delta: { content: "{\"a\"" } }] },
    { model: "muse-wonder-1.0", choices: [{ delta: { content: ":1}" }, finish_reason: "stop" }] },
    { model: "muse-wonder-1.0", choices: [], usage: { prompt_tokens: 10, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 20 } } },
  ]));
  assert.deepEqual(f, { text: "{\"a\":1}", reasoning: "think", model_echoed: "muse-wonder-1.0", finish_reason: "stop", usage: { prompt: 10, completion: 30, reasoning: 20 }, error: undefined });
});

test("chat streams with a bearer key, records an empty reply as a failed call with one request per call, and logs no key", async () => {
  let hits = 0, auth = "", body: Record<string, unknown> = {};
  const replies = [sse([{ model: "m", choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]), sse([{ model: "m", choices: [{ delta: {}, finish_reason: "stop" }] }])];
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d));
    req.on("end", () => { auth = String(req.headers.authorization); body = JSON.parse(b); res.writeHead(200, { "content-type": "text/event-stream" }); res.end(replies[hits++]); });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    const endpoint = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1/chat/completions`;
    const req = { model: "muse-wonder-1.0", role: "consolidator" as const, max_tokens: 400, messages: [{ role: "user" as const, content: "hi" }] };
    const ok = await chat(req, { endpoint, key: "sk-test-secret" });
    assert.equal(ok.ok, true);
    assert.equal(ok.text, "ok");
    assert.equal(auth, "Bearer sk-test-secret");
    assert.equal(body.stream, true);
    const empty = await chat(req, { endpoint, key: "sk-test-secret" });
    assert.equal(empty.ok, false);
    assert.equal(empty.error, "no usable output");
    assert.equal(hits, 2);
    const log = readFileSync(join(TEL, "llm.jsonl"), "utf8");
    assert.ok(!log.includes("sk-test-secret"));
    assert.match(log, /"outcome":"failed"/);
  } finally { srv.close(); }
});

test("priceUsd prices tokens from PRICES", () => {
  assert.equal(priceUsd("muse-wonder-1.0", 1000, 1000), 1000 * PRICES["muse-wonder-1.0"].in + 1000 * PRICES["muse-wonder-1.0"].out);
});
