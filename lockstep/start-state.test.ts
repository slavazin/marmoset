// Identical starting conditions (S22): a start state built on the oracle loads into the core so both sides read
// the same machine at frame 0, and with no input their first compared frames and mapped RAM stay equal. Read on
// game.gb (always present) and on the owner-supplied Mario & Yoshi ROM (skipped where the ROM is absent; the ROM
// is never committed). Also reads the refusals: a state off the frame boundary, a core whose snapshot layout
// differs, another ROM's state, a tampered start file, and the gate's isolated replay through each.
import { strict as assert } from "node:assert";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

// The Mario & Yoshi ROM is found before the cache is pointed at a temp dir, through its env variable or the user cache.
const { gameById, mappedRam, mapOf, romPathOf } = await import("./games.ts");
const MY = gameById("mario-yoshi-eu");
const myRom = (() => { try { return romPathOf(MY); } catch { return null; } })();
process.env.RATCHET_CACHE = mkdtempSync(join(tmpdir(), "ratchet-start-cache-"));

const { createCore } = await import("../core/index.ts");
const { replayFrames, formatOutcome } = await import("./replay.ts");
const S = await import("./start-state.ts");
const { OracleClient, sha256 } = await import("../oracle/client.ts");
const { frameDiff, GAME_RAM } = await import("./diff.ts");
const { lockstep } = await import("./lockstep.ts");
const { MemoryIncidentSink } = await import("./incidents.ts");
const { isolatedReplay, isolatedReplayer } = await import("../loop/replay-seam.ts");
const { puzzleTrace } = await import("../loop/game-trace.ts");

const REPO = resolve(import.meta.dirname, "..");
const GAME = join(REPO, "game", "game.gb");
const DYLIB = process.env.SAMEBOY_LIBRETRO ?? join(homedir(), ".cache/ratchet/tools/SameBoy/build/bin/sameboy_libretro.dylib");
const skip = !existsSync(DYLIB) ? `SameBoy libretro absent at ${DYLIB}` : false;
const skipMy = skip || (myRom ? false : "Mario & Yoshi ROM absent (RATCHET_ROM_MARIO_YOSHI_EU or $RATCHET_CACHE/games)");
/** game.gb's start: 120 frames from zeroed power-on RAM, no input (past SameBoy's boot ROM, inside the title). */
const GAME_SPEC = { prefix: [{ from_counter: 0, mask: 0 }], frames: 120, ram_init: "zero" as const };

/** Runs both sides `frames` frames with no input from `st`; returns the first frame whose shades (unless ramOnly) or mapped RAM differ, or 0. */
async function firstDiff(romPath: string, st: Awaited<ReturnType<typeof S.buildStartState>>, logic: { addr: number; len: number }[], frames: number, ramOnly = false): Promise<number> {
  const core = S.withStart(createCore, st)(new Uint8Array(readFileSync(romPath)));
  const o = OracleClient.spawn();
  try {
    await o.load(romPath, "frame", "DMG", "zero");
    await o.restore(st.oracle_state_b64, true);
    const map = { counter: null, scene: { addr: logic[0].addr }, logic };
    for (let n = 1; n <= frames; n++) {
      core.setButtons(0);
      core.runFrame();
      await o.runToCounter(n, []);
      if (!ramOnly && frameDiff(core.frame(), await o.frame()).pixels) return n;
      const parts: Uint8Array[] = [];
      for (const r of logic) parts.push(await o.ram(r.addr, r.len));
      if (!Buffer.from(mappedRam(map, (a) => core.read(a))).equals(Buffer.concat(parts))) return n;
    }
    return 0;
  } finally {
    await o.close();
  }
}

// game.gb's frames are not asserted equal: the S0 core differs from SameBoy on game.gb's mid-frame effects from
// power-on as well (bands 2, 10 and 16 in a 200-frame counter-align reading, evidence/s22/README.md), and those
// differences are the incidents RUN-0001 repairs.
test("game.gb: the start state loads into the core with equal registers, WRAM, VRAM, OAM, HRAM and IO at frame 0, and GAME_RAM stays equal over 60 no-input frames", { skip }, async () => {
  const st = await S.buildStartState(GAME, GAME_SPEC);
  S.loadIntoCore(createCore(new Uint8Array(readFileSync(GAME))), st.machine); // throws on any frame-0 difference
  assert.equal(await firstDiff(GAME, st, [{ addr: GAME_RAM.addr, len: GAME_RAM.len }], 60, true), 0);
});

test("Mario & Yoshi: the registry start state (level 1, start of play) loads into the core at frame 0, and 120 no-input frames and the mapped RAM match", { skip: skipMy }, async () => {
  const st = await S.buildStartState(myRom!, { ...MY.start!, ram_init: "zero" });
  const core = createCore(new Uint8Array(readFileSync(myRom!)));
  S.loadIntoCore(core, st.machine);
  assert.equal(core.read(0xc029), 52, "mode byte reads play (evidence/s22/ram-map.md)");
  assert.equal(core.read(0xc6b3), 0, "level byte reads level 1");
  assert.equal(await firstDiff(myRom!, st, mapOf(MY).logic, 120), 0);
});

test("Mario & Yoshi: lockstep from the registry selects frame align, the start state and the mapped RAM, and a 300-frame puzzle trace opens no incident on the S0 core; the gate's admitted-trace replay of it reads clean", { skip: skipMy }, async () => {
  const trace = puzzleTrace({ rom_sha: MY.rom.sha256, frames: 300, seed: 7 });
  const sink = new MemoryIncidentSink();
  const res = await lockstep({ romPath: myRom!, trace, createCore, coreCommit: "test", sink, evidenceRoot: mkdtempSync(join(tmpdir(), "ratchet-ev-")) });
  assert.equal(res.compared, 300);
  assert.deepEqual(res.opened, []);
  // the gate's admitted-trace replay finds the registry start state and the start-keyed oracle frames: clean
  const tracesDir = mkdtempSync(join(tmpdir(), "ratchet-traces-"));
  writeFileSync(join(tracesDir, "TRC-9001.json"), JSON.stringify({ ...trace, id: "TRC-9001", window: [1, 300] }));
  const r = await isolatedReplayer(REPO).trace({ coreDir: join(REPO, "core"), id: "TRC-9001", tracesDir, rom: myRom!, cache: process.env.RATCHET_CACHE! });
  assert.equal(r.line, "clean");
});

test("coreSnapshotOf refuses a machine off the LY 144 frame boundary", { skip }, async () => {
  const st = await S.buildStartState(GAME, GAME_SPEC);
  const io = Buffer.from(st.machine.io_b64, "base64");
  io[0x44] = 10;
  assert.throws(() => S.coreSnapshotOf({ ...st.machine, io_b64: io.toString("base64") }), /not at a frame boundary/);
});

test("loadIntoCore refuses a core whose restore does not take the snapshot layout, and withStart refuses another ROM", { skip }, async () => {
  const st = await S.buildStartState(GAME, GAME_SPEC);
  const rom = new Uint8Array(readFileSync(GAME));
  const deaf = createCore(rom);
  deaf.restore = () => {};
  assert.throws(() => S.loadIntoCore(deaf, st.machine), /start state: core/);
  const other = rom.slice(); other[0x150] ^= 0xff;
  assert.throws(() => S.withStart(createCore, st)(other), /another ROM/);
});

test("readStartState refuses a start file for another ROM sha and one whose key does not match its spec", { skip }, async () => {
  const st = await S.buildStartState(GAME, GAME_SPEC);
  const file = S.startPath(st.spec);
  assert.throws(() => S.readStartState(file, "0".repeat(64)), /is for ROM/);
  const bad = join(mkdtempSync(join(tmpdir(), "ratchet-st-")), "x.json");
  writeFileSync(bad, JSON.stringify({ ...st, spec: { ...st.spec, frames: 121 } }));
  assert.throws(() => S.readStartState(bad, st.spec.rom_sha), /key does not match/);
});

test("the gate's isolated replay restores the start state in the child: its reading equals in-process replayFrames from the start state and differs from power-on; a start file of another sha or a tampered one is not clean", { skip }, async () => {
  const st = await S.buildStartState(GAME, GAME_SPEC);
  const file = S.startPath(st.spec);
  const oracleDir = mkdtempSync(join(tmpdir(), "ratchet-oframes-"));
  const o = OracleClient.spawn();
  const oracleRam: Record<string, string> = {};
  try {
    await o.load(GAME, "frame", "DMG", "zero");
    await o.restore(st.oracle_state_b64, true);
    for (let n = 1; n <= 20; n++) {
      await o.runToCounter(n, []);
      writeFileSync(join(oracleDir, `${n}.bin`), await o.frame());
      oracleRam[n] = Buffer.from(await o.ram(GAME_RAM.addr, GAME_RAM.len)).toString("hex");
    }
  } finally {
    await o.close();
  }
  const w = { rom: GAME, rom_sha: sha256(readFileSync(GAME)), align: "frame" as const, inputs: [{ from_counter: 0, mask: 0 }], from: 1, to: 20, oracleDir, oracleRam };
  const coreDir = join(REPO, "core");
  const sha = sha256(readFileSync(file));
  const fromStart = await isolatedReplay(coreDir, { ...w, start: { file, sha }, logic: [{ addr: GAME_RAM.addr, len: GAME_RAM.len }] });
  const inProcess = formatOutcome(replayFrames(createCore, { rom: new Uint8Array(readFileSync(GAME)), align: "frame", inputs: w.inputs, window: [1, 20], oracleDir, oracleRam, start: st }));
  assert.equal(fromStart.line, inProcess);
  const powerOn = await isolatedReplay(coreDir, w);
  assert.notEqual(powerOn.line, fromStart.line);
  const wrong = await isolatedReplay(coreDir, { ...w, start: { file, sha: "0".repeat(64) } });
  assert.equal(wrong.clean, false);
  assert.equal(wrong.exit, 2);
  const tampered = join(mkdtempSync(join(tmpdir(), "ratchet-st-")), "t.json");
  copyFileSync(file, tampered);
  writeFileSync(tampered, readFileSync(tampered, "utf8").replace('"frames":120', '"frames":121'));
  const t = await isolatedReplay(coreDir, { ...w, start: { file: tampered, sha: sha256(readFileSync(tampered)) } });
  assert.equal(t.clean, false);
});

test("oracle load ram_init zero starts WRAM all zero; the default load starts it with SameBoy's seeded noise", { skip }, async () => {
  const o = OracleClient.spawn();
  try {
    await o.load(GAME, "frame", "DMG", "zero");
    assert.ok((await o.ram(0xc000, 0x2000)).every((b) => b === 0));
    await o.load(GAME, "frame");
    assert.ok((await o.ram(0xc000, 0x2000)).some((b) => b !== 0));
  } finally {
    await o.close();
  }
});

test("puzzleTrace is frame-aligned, deterministic per seed, and presses only left, right or A", () => {
  const a = puzzleTrace({ rom_sha: "x", frames: 2000, seed: 3 });
  assert.deepEqual(a, puzzleTrace({ rom_sha: "x", frames: 2000, seed: 3 }));
  assert.notDeepEqual(a.inputs, puzzleTrace({ rom_sha: "x", frames: 2000, seed: 4 }).inputs);
  assert.equal(a.align, "frame");
  assert.ok(a.inputs.length > 50);
  for (const i of a.inputs) assert.ok([0, 1, 2, 16].includes(i.mask), `mask ${i.mask}`);
});

void mkdirSync;
