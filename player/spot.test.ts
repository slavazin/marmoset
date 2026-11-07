// The visual sensor against a fake vision client on lockstep's playback core with a planted PPU band
// (lockstep/fixtures/playback-core-ppu-band: lines 74..77, x 17..44, from counter 300). The fake answers by
// the counter the prompt names, so each outcome is planted and the scorer's reading of it is checked.
import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { PNG } from "pngjs";

process.env.RATCHET_CACHE = mkdtempSync(join(tmpdir(), "ratchet-spot-cache-"));
process.env.RATCHET_TELEMETRY_DIR = mkdtempSync(join(tmpdir(), "ratchet-spot-telemetry-"));

const { COUNTER_ROM } = await import("../oracle/smoke.ts");
const { recordPlayback, createPlaybackCore } = await import("../lockstep/fixtures/playback.ts");
const { MUTATION: BAND } = await import("../lockstep/fixtures/playback-core-ppu-band/index.ts");
const { LedgerIncidentSink } = await import("../loop/incident-sink.ts");
const { read } = await import("../loop/ledger.ts");
const { oracleFrames } = await import("../oracle/client.ts");
const { spotDuring, sampleCounters, toFrameBox } = await import("./spot.ts");
const { scoreAnswer, spotSummary, SPOTS_FILE, iou } = await import("./spot-score.ts");
type VisionRequest = import("./vision.ts").VisionRequest;

const DYLIB = process.env.SAMEBOY_LIBRETRO ?? join(homedir(), ".cache/ratchet/tools/SameBoy/build/bin/sameboy_libretro.dylib");
const skip = !existsSync(DYLIB) ? `SameBoy libretro absent at ${DYLIB}` : false;
const TRACE = { align: "counter" as const, inputs: [{ from_counter: 0, mask: 0 }], counter_end: 600 };
const EVERY = 120;
/** The band's frame box [17,74,45,78] on the 0..1000 grid. */
const BAND_GRID = [17 / 160 * 1000, 74 / 144 * 1000, 45 / 160 * 1000, 78 / 144 * 1000];

const json = (o: unknown) => JSON.stringify(o);
const ok = (glitch: boolean, bbox: number[] | null) => json({ glitch, confidence: 0.8, bbox, subsystem: glitch ? "ppu_fetcher" : "other", why: "fake" });
/** Replies per counter, one per call; the last repeats. */
const SCRIPT: Record<number, string[]> = {
  120: [ok(true, [500, 500, 700, 700])], // flag on a clean frame: fp, sensor-only
  240: ["not json", ok(false, null)], // parse-and-retry, then tn
  300: [ok(true, BAND_GRID)], // the opening: tp
  360: [ok(false, null)], // miss: fn
  480: [ok(true, [900, 900, 1000, 1000])], // flag with the box elsewhere: fn, mislocated
  600: ["nope", "still nope"], // two unparseable replies: failed
};

function fakeClient() {
  const requests: VisionRequest[] = [];
  const calls = new Map<number, number>();
  const client = async (req: VisionRequest) => {
    requests.push(req);
    const n = Number(/frame counter (\d+)/.exec(req.prompt)![1]);
    const k = calls.get(n) ?? 0;
    calls.set(n, k + 1);
    const s = SCRIPT[n] ?? [ok(false, null)];
    return { text: s[Math.min(k, s.length - 1)], model: "fake-vision", tokens_in: 10, tokens_out: 5, ms: 1 };
  };
  return { client, requests };
}

const shadesOf = (b64: string) => {
  const p = PNG.sync.read(Buffer.from(b64, "base64"));
  const s = new Uint8Array(160 * 144), scale = p.width / 160;
  const inv: Record<number, number> = { 0xff: 0, 0xaa: 1, 0x55: 2, 0x00: 3 };
  for (let y = 0; y < 144; y++) for (let x = 0; x < 160; x++) s[y * 160 + x] = inv[p.data[(y * scale * p.width + x * scale) * 4]];
  return s;
};

let ledger = "", res: Awaited<ReturnType<typeof spotDuring>>, requests: VisionRequest[] = [];
before(async () => {
  if (skip) return;
  await recordPlayback(COUNTER_ROM, 720);
  ledger = mkdtempSync(join(tmpdir(), "ratchet-spot-ledger-"));
  const fake = fakeClient();
  requests = fake.requests;
  res = await spotDuring({
    romPath: COUNTER_ROM, trace: TRACE, createCore: (r) => createPlaybackCore(r, BAND), coreCommit: "fixture",
    sink: new LedgerIncidentSink(ledger), evidenceRoot: mkdtempSync(join(tmpdir(), "ratchet-spot-evidence-")),
  }, { every: EVERY, client: fake.client, ledger, seed: 7 });
});

test("the sampler sends the opening 300, every 120th counter and one clean seeded control, each once", { skip }, () => {
  const sent = res.spots.map((s) => s.counter);
  const control = res.spots.filter((s) => s.sampled_by.includes("control"));
  assert.equal(control.length, 1, "matched count: one opening, one control");
  assert.ok(control[0].counter < 300 && control[0].truth.diff === false);
  assert.deepEqual(sent, [...new Set([120, 240, 300, 360, 480, 600, control[0].counter])].sort((a, b) => a - b));
  assert.deepEqual(res.spots.find((s) => s.counter === 300)!.sampled_by, ["opening"]);
});

test("planted answers score tp 1, fp 1, fn 2 (one mislocated), tn 2, failed 1; precision 0.5, recall 1/3", { skip }, () => {
  const by = (n: number) => res.spots.find((s) => s.counter === n)!;
  assert.equal(by(300).score.outcome, "tp");
  assert.ok(by(300).score.iou! > 0.9);
  assert.equal(by(120).score.outcome, "fp");
  assert.equal(by(360).score.outcome, "fn");
  assert.deepEqual([by(480).score.outcome, by(480).score.mislocated], ["fn", true]);
  assert.equal(by(240).score.outcome, "tn");
  assert.equal(by(240).calls, 2, "one parse-and-retry");
  assert.deepEqual([by(600).kind, by(600).score.outcome, by(600).calls, by(600).answer], ["failed", "failed", 2, null]);
  const sum = spotSummary(ledger);
  assert.deepEqual({ ...sum, subsystem: undefined }, { n: 6, tp: 1, fp: 1, fn: 2, tn: 2, failed: 1, precision: 0.5, recall: 1 / 3, subsystem: undefined });
  assert.deepEqual(sum.subsystem, { agree: 0, disagree: 0, unknown: 1 });
  const lines = read(SPOTS_FILE, ledger);
  assert.equal(lines.length, res.spots.length);
  assert.ok(lines.every((l) => /^SPT-\d{4}$/.test(String(l.id))));
});

test("a sensor-only flag opens no incident; the tp on the opening appends one spot status record on INC-0001", { skip }, () => {
  const fp = res.spots.find((s) => s.counter === 120)!;
  assert.equal(fp.kind, "sensor-only");
  assert.equal(fp.incident, undefined);
  const inc = read("incidents.jsonl", ledger);
  const records = inc.filter((r) => r.t !== "status");
  assert.deepEqual(records.map((r) => r.id), ["INC-0001"], "only lockstep's one incident");
  const st = inc.filter((r) => r.t === "status");
  assert.equal(st.length, 1);
  assert.deepEqual([st[0].id, st[0].field], ["INC-0001", "spot"]);
  const v = st[0].value as { spot: string; subsystem: string; bbox: number[] };
  assert.equal(v.spot, res.spots.find((s) => s.counter === 300)!.id);
  assert.equal(v.subsystem, "ppu_fetcher");
  assert.equal(res.spots.find((s) => s.counter === 480)!.incident, "INC-0001", "a later diff frame is matched to the open incident by signature");
});

test("every vision request carries the core's frame and never the oracle's (band counters differ from the oracle)", { skip }, async () => {
  const rom = new Uint8Array(readFileSync(COUNTER_ROM));
  const counters = [...new Set(requests.map((r) => Number(/frame counter (\d+)/.exec(r.prompt)![1])))];
  const oracle = await oracleFrames(COUNTER_ROM, TRACE, counters);
  for (const req of requests) {
    const n = Number(/frame counter (\d+)/.exec(req.prompt)![1]);
    const { counterStepper } = await import("../lockstep/align.ts");
    const compared = counterStepper(createPlaybackCore(rom, BAND)).to(n);
    const sent = shadesOf(req.image.data);
    assert.deepEqual(sent, compared, `counter ${n}: request image is the core's compared frame`);
    if (n >= 300) assert.notDeepEqual(sent, oracle.get(n), `counter ${n}: request image is not the oracle frame`);
    assert.doesNotMatch(req.prompt, /oracle|sameboy/i);
  }
});

test("scoreAnswer and the sampler hold without the oracle: IoU threshold, null answer, matched controls", () => {
  const truth = { diff: true, pixels: 10, box: [10, 10, 20, 20] as [number, number, number, number] };
  const a = (bbox: [number, number, number, number] | null, glitch = true) => ({ glitch, confidence: 1, bbox, subsystem: "other" as const, why: "" });
  assert.equal(scoreAnswer(a([10, 10, 20, 20]), truth).outcome, "tp");
  assert.equal(scoreAnswer(a([30, 30, 40, 40]), truth).outcome, "fn");
  assert.equal(scoreAnswer(a(null), truth).outcome, "fn");
  assert.equal(scoreAnswer(null, truth).outcome, "failed");
  assert.equal(scoreAnswer(a(null, false), { diff: false, pixels: 0, box: null }).outcome, "tn");
  assert.equal(iou([0, 0, 10, 10], [5, 0, 15, 10]), 1 / 3);
  assert.deepEqual(toFrameBox([0, 0, 1000, 1000]), [0, 0, 160, 144]);
  const plan = sampleCounters({ counters: [1, 2, 3, 4, 5, 6], openings: [5, 6], clean: new Set([1, 2, 3, 4]), every: 4, seed: 1 });
  assert.equal([...plan.values()].filter((v) => v.includes("control")).length, 2);
  assert.deepEqual(plan.get(4), ["every"]);
});
