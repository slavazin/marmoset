// Lockstep, incidents and replay against a playback core (lockstep/fixtures/playback.ts): a core that plays
// back the oracle's own recorded frames and RAM, so these tests read lockstep logic, not any emulator.
import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { before, test } from "node:test";

process.env.RATCHET_CACHE = mkdtempSync(join(tmpdir(), "ratchet-lockstep-cache-"));

const { COUNTER_ROM } = await import("../oracle/smoke.ts");
const { MemoryIncidentSink } = await import("./incidents.ts");
const { lockstep } = await import("./lockstep.ts");
const { recordPlayback, createPlaybackCore } = await import("./fixtures/playback.ts");
const { MUTATION: BAND } = await import("./fixtures/playback-core-ppu-band/index.ts");
const { MUTATION: LOGIC } = await import("./fixtures/playback-core-logic/index.ts");
const { suiteIncident } = await import("./suite.ts");
const { bundleReplay, REPLAY_OUT } = await import("./build-replay.ts");
const { romsDir } = await import("../suites/splits.ts");

const REPO = resolve(import.meta.dirname, "..");
const DYLIB = process.env.SAMEBOY_LIBRETRO ?? join(homedir(), ".cache/ratchet/tools/SameBoy/build/bin/sameboy_libretro.dylib");
const skip = !existsSync(DYLIB) ? `SameBoy libretro absent at ${DYLIB}` : false;
const TRACE = { align: "counter" as const, inputs: [{ from_counter: 0, mask: 0 }], counter_end: 600 };
const fixture = (name: string) => join(REPO, "lockstep", "fixtures", name);
const evidence = () => mkdtempSync(join(tmpdir(), "ratchet-evidence-"));

function replay(args: string[]): { out: string; code: number } {
  try {
    return { out: execFileSync(process.execPath, [REPLAY_OUT, ...args], { encoding: "utf8", env: process.env }).trim(), code: 0 };
  } catch (e) {
    const err = e as { stdout: string; status: number };
    return { out: err.stdout.trim(), code: err.status };
  }
}

before(async () => {
  if (!skip) await recordPlayback(COUNTER_ROM, 720);
});

test("lockstep on counter.gb over a 600-frame trace compares 600 frames and opens no incident on the matching playback core", { skip }, async () => {
  const sink = new MemoryIncidentSink();
  const res = await lockstep({ romPath: COUNTER_ROM, trace: TRACE, createCore: (r) => createPlaybackCore(r), coreCommit: "fixture", sink, evidenceRoot: evidence() });
  console.log(`lockstep counter.gb playback: ${res.compared} frames at ${Math.round(res.fps)} fps`);
  assert.equal(res.compared, 600);
  assert.deepEqual(res.opened, []);
  assert.deepEqual(res.known, {});
  assert.equal(res.stopped, null);
});

test("a PPU band flipped from counter 300 opens one frame incident at 300 (band 9, bbox [16,72,48,80]); replay prints 300 on it and clean without it", { skip }, async () => {
  const sink = new MemoryIncidentSink();
  const root = evidence();
  const res = await lockstep({ romPath: COUNTER_ROM, trace: TRACE, createCore: (r) => createPlaybackCore(r, BAND), coreCommit: "fixture", sink, evidenceRoot: root });
  assert.equal(res.compared, 600);
  assert.equal(res.opened.length, 1);
  const inc = res.opened[0];
  assert.equal(inc.id, "INC-0001");
  assert.equal(inc.kind, "frame");
  assert.equal(inc.counter, 300);
  assert.deepEqual(inc.signature, { scene: 0, band: 9, bbox: [16, 72, 48, 80] });
  assert.equal(inc.pixels, 4 * 28);
  assert.deepEqual(inc.window, [240, 420]);
  assert.deepEqual(Object.values(res.known), [300], "counters 301..600 are counted, not re-opened");
  const dir = join(root, inc.id);
  for (const f of ["core.png", "oracle.png", "diff.png", "regwrites.jsonl", "window.json"]) assert.ok(existsSync(join(dir, f)), f);
  const w = JSON.parse(readFileSync(join(dir, "window.json"), "utf8"));
  for (let n = 240; n <= 420; n++) assert.ok(existsSync(join(w.oracle_dir, `${n}.bin`)), `oracle frame ${n} cached`);

  assert.deepEqual(replay(["--incident", inc.id, "--evidence-dir", dir, "--core-dir", fixture("playback-core-ppu-band")]),
    { out: "first mismatch: counter 300 (112 pixels)", code: 1 });
  assert.deepEqual(replay(["--incident", inc.id, "--evidence-dir", dir, "--core-dir", fixture("playback-core")]), { out: "clean", code: 0 });

  const again = await lockstep({ romPath: COUNTER_ROM, trace: TRACE, createCore: (r) => createPlaybackCore(r, BAND), coreCommit: "fixture", sink, evidenceRoot: root });
  assert.deepEqual(again.opened, [], "a signature with an open incident opens nothing on a second run");
  assert.deepEqual(Object.values(again.known), [301]);
});

test("a game-state RAM difference from counter 400 opens one logic incident and stops the trace at 400; replay prints 400", { skip }, async () => {
  const sink = new MemoryIncidentSink();
  const root = evidence();
  const res = await lockstep({ romPath: COUNTER_ROM, trace: TRACE, createCore: (r) => createPlaybackCore(r, LOGIC), coreCommit: "fixture", sink, evidenceRoot: root });
  assert.equal(res.compared, 400);
  assert.equal(res.opened.length, 1);
  assert.equal(res.opened[0].kind, "logic");
  assert.equal(res.opened[0].counter, 400);
  assert.deepEqual(res.stopped, { counter: 400, incident: res.opened[0].id });
  const dir = join(root, res.opened[0].id);
  assert.deepEqual(replay(["--incident", res.opened[0].id, "--evidence-dir", dir, "--core-dir", fixture("playback-core-logic")]),
    { out: "first mismatch: counter 400 (game-state RAM)", code: 1 });
  assert.deepEqual(replay(["--incident", res.opened[0].id, "--evidence-dir", dir, "--core-dir", fixture("playback-core")]), { out: "clean", code: 0 });
});

const MEALY = "mealybug-tearoom-tests/ppu/m3_bgp_change.gb";
test("suiteIncident on a failing T-family ROM opens one suite incident with align frame and the ROM's reading as repro, and returns it again while open", { skip: !existsSync(join(romsDir(), MEALY)) && `${MEALY} absent` }, async () => {
  const { createCore } = await import("../suites/fixtures/nop-core/index.ts");
  const sink = new MemoryIncidentSink();
  const root = evidence();
  const caps = { wallMs: 5000, cycles: 4_194_304 };
  const inc = suiteIncident("mealybug:palette-scroll-bg", MEALY, { createCore, coreCommit: "fixture", sink, evidenceRoot: root, caps });
  assert.ok(inc);
  assert.equal(inc.source, "suite");
  assert.equal(inc.align, "frame");
  const w = JSON.parse(readFileSync(join(root, inc.id, "window.json"), "utf8"));
  assert.equal(w.kind, "suite");
  assert.equal(w.repro.pass, false);
  assert.equal(suiteIncident("mealybug:palette-scroll-bg", MEALY, { createCore, coreCommit: "fixture", sink, evidenceRoot: root, caps })?.id, inc.id);
  const r = replay(["--incident", inc.id, "--evidence-dir", join(root, inc.id), "--core-dir", join(REPO, "suites", "fixtures", "nop-core")]);
  assert.equal(r.code, 1);
  assert.match(r.out, /^fail: mealybug-tearoom-tests\/ppu\/m3_bgp_change\.gb pixel match/);
});

const T_ROM = "mealybug-tearoom-tests/ppu/m3_bgp_change.gb";
const V_ROM = "mooneye-test-suite/acceptance/timer/div_write.gb";
test("tools/replay.mjs copied alone into a directory with no splits.json scores a T ROM with --family and still refuses a V ROM", { skip: !(existsSync(join(romsDir(), T_ROM)) && existsSync(join(romsDir(), V_ROM))) && "ROMs absent" }, () => {
  const scratch = mkdtempSync(join(tmpdir(), "ratchet-scratch-"));
  mkdirSync(join(scratch, "tools"));
  copyFileSync(REPLAY_OUT, join(scratch, "tools", "replay.mjs"));
  const run = (rom: string) => {
    writeFileSync(join(scratch, "roms.json"), JSON.stringify([rom]));
    const r = spawnSync(process.execPath, [join(scratch, "tools", "replay.mjs"), "--family", "x", "--core-dir", join(REPO, "suites", "fixtures", "nop-core"), "--roms", join(scratch, "roms.json")],
      { encoding: "utf8", cwd: scratch, env: { ...process.env, RATCHET_VREAD_TOKEN: "" } });
    return { code: r.status, out: r.stdout.trim(), err: r.stderr };
  };
  const t = run(T_ROM);
  assert.equal(t.code, 0, t.err);
  assert.equal(JSON.parse(t.out).roms, 1);
  const v = run(V_ROM);
  assert.equal(v.code, 2);
  assert.match(v.err, /split V refused/);
});

test("CGB suite incident: suiteIncident on a CGB T family runs the ROM with model CGB, writes window.model CGB and a colour oracle.png, and tools/replay.mjs replays it on CGB (a DMG-only core reads no CGB support)", { skip: !existsSync(join(romsDir(), MEALY)) && `${MEALY} absent` }, async () => {
  const { createCore } = await import("../suites/fixtures/cgb-nop-core/index.ts");
  const { loadSplits, SPLITS_CGB_PATH } = await import("../suites/splits.ts");
  const { PNG } = await import("pngjs");
  const models: (string | undefined)[] = [];
  const spy: typeof createCore = (rom, opts) => { models.push(opts?.model); return createCore(rom, opts); };
  const sink = new MemoryIncidentSink();
  const root = evidence();
  const inc = suiteIncident("cgb:mealybug:palette-scroll-bg", MEALY, { createCore: spy, coreCommit: "fixture", sink, evidenceRoot: root, splits: loadSplits(SPLITS_CGB_PATH), caps: { wallMs: 5000, cycles: 4_194_304 } });
  assert.ok(inc);
  assert.deepEqual(models, ["CGB"]);
  const w = JSON.parse(readFileSync(join(root, inc.id, "window.json"), "utf8"));
  assert.equal(w.model, "CGB");
  assert.equal(w.family, "cgb:mealybug:palette-scroll-bg");
  assert.ok(inc.pixels > 0, "the black frame differs from the CGB reference");
  const ref = PNG.sync.read(readFileSync(join(root, inc.id, "oracle.png")));
  let colour = false;
  for (let i = 0; i < ref.data.length; i += 4) if (ref.data[i] !== ref.data[i + 1] || ref.data[i + 1] !== ref.data[i + 2]) { colour = true; break; }
  assert.ok(colour, "oracle.png carries a non-grey pixel of the CGB reference");
  const cgb = replay(["--incident", inc.id, "--evidence-dir", join(root, inc.id), "--core-dir", join(REPO, "suites", "fixtures", "cgb-nop-core")]);
  assert.equal(cgb.code, 1);
  assert.match(cgb.out, /^fail: mealybug-tearoom-tests\/ppu\/m3_bgp_change\.gb pixel match/);
  const dmg = replay(["--incident", inc.id, "--evidence-dir", join(root, inc.id), "--core-dir", join(REPO, "suites", "fixtures", "nop-core")]);
  assert.equal(dmg.code, 1);
  assert.match(dmg.out, /no CGB support/);
});

test("tools/replay.mjs equals a fresh esbuild bundle of tools/replay.ts", async () => {
  assert.equal(readFileSync(REPLAY_OUT, "utf8"), await bundleReplay(false));
});
