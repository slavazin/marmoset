// game2/game2.gb ("HALOGEN", S21): its §6.17 contract, cart header, timer guard, a fresh build, and a boot smoke
// test on the S1 core (core/) and the oracle under an explorer trace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { GAME_RAM } from "../src/schema.ts";
import { GAME_RAM as LOCKSTEP_RAM, SCENE_OFFSET, maskAt } from "../lockstep/diff.ts";
import { counterStepper } from "../lockstep/align.ts";
import { loadCreateCore } from "../lockstep/core-dir.ts";
import { OracleClient, sha256 } from "../oracle/client.ts";
import { explorerTrace } from "../player/explore.ts";

const here = new URL(".", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, here), "utf8");
const ROM = new URL("game2.gb", here).pathname;
const REPO = new URL("..", here).pathname;
const DYLIB = process.env.SAMEBOY_LIBRETRO ?? join(homedir(), ".cache/ratchet/tools/SameBoy/build/bin/sameboy_libretro.dylib");
const LCC = join(process.env.GBDK_HOME ?? join(homedir(), ".cache/ratchet/tools/gbdk"), "bin", "lcc");

/** Smoke budget: counters within which both machines must leave the title, and reach sector 2 (SCENE_FRAMES 900). */
const SMOKE_SCENE1_BY = 60;
const SMOKE_SCENE2_BY = 960;
const SMOKE_SEED = 21;

test("game2/src/contract.h addresses equal GAME_RAM in src/schema.ts", () => {
  const h = read("src/contract.h");
  const addr = (name: string) => {
    const m = h.match(new RegExp(`#define ${name}\\s+(0x[0-9A-Fa-f]+)`));
    assert.ok(m, `${name} defined`);
    return parseInt(m[1], 16);
  };
  assert.equal(addr("RAM_COUNTER_ADDR"), GAME_RAM.counter);
  assert.equal(addr("RAM_SCENE_ADDR"), GAME_RAM.scene);
  assert.equal(addr("RAM_HERO_X_ADDR"), GAME_RAM.heroX);
  assert.equal(addr("RAM_HERO_Y_ADDR"), GAME_RAM.heroY);
  assert.equal(addr("RAM_LIVES_ADDR"), GAME_RAM.lives);
});

test("game2/build.sh links _DATA above the contract bytes 0xC0F0-0xC0F6", () => {
  const m = read("build.sh").match(/-Wl-b_DATA=(0x[0-9A-Fa-f]+)/);
  assert.ok(m);
  assert.ok(parseInt(m[1], 16) > GAME_RAM.lives);
});

test("game2/game2.gb header reads title HALOGEN, ROM-only (0x147 = 0x00), 32 KiB (0x148 = 0x00) and a valid header checksum", () => {
  const rom = readFileSync(ROM);
  assert.equal(rom.length, 32768);
  assert.equal(rom.subarray(0x134, 0x13b).toString("latin1"), "HALOGEN");
  assert.equal(rom[0x147], 0x00);
  assert.equal(rom[0x148], 0x00);
  let x = 0;
  for (let i = 0x134; i <= 0x14c; i++) x = (x - rom[i] - 1) & 0xff;
  assert.equal(rom[0x14d], x);
  assert.notEqual(sha256(rom), sha256(readFileSync(new URL("../game/game.gb", here))));
});

test("game2/src reads neither DIV nor TIMA, writes DIV once before starting the timer, and keeps the beat out of game state", () => {
  const src = read("src/main.c");
  const art = read("src/art.c");
  assert.doesNotMatch(art, /\b(DIV_REG|TIMA_REG|TMA_REG|TAC_REG|rand|arand|initrand|0xFF0[4-7])\b/i);
  assert.doesNotMatch(src, /\b(rand|arand|initrand)\b|0xFF0[4-7]/i);
  assert.doesNotMatch(src, /=\s*\(?\s*(uint8_t\s*\)\s*)?(DIV_REG|TIMA_REG)\b/, "no read of DIV or TIMA");
  assert.equal(src.match(/\bDIV_REG\b/g)?.length, 1);
  const div = src.indexOf("DIV_REG = 0u;");
  assert.ok(div > 0 && div < src.indexOf("TAC_REG = TAC_START;"), "DIV reset precedes the timer start");
  const body = (name: string) => {
    const at = src.indexOf(`static void ${name}(`);
    assert.ok(at >= 0, name);
    return src.slice(at, src.indexOf("\n}\n", at));
  };
  for (const f of ["vbl_isr", "publish", "update_play", "update_title", "update_bolts", "update_sparks", "update_sprites", "enter_scene"])
    assert.doesNotMatch(body(f), /\bbeat\b|music_step/, f);
});

test("a fresh game2/build.sh build equals the committed game2/game2.gb", { skip: !existsSync(LCC) && `lcc absent at ${LCC}` }, () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-game2-"));
  try {
    cpSync(new URL("src", here).pathname, join(dir, "src"), { recursive: true });
    cpSync(new URL("build.sh", here).pathname, join(dir, "build.sh"));
    execFileSync("sh", [join(dir, "build.sh")], { stdio: "ignore" });
    assert.equal(sha256(readFileSync(join(dir, "game2.gb"))), sha256(readFileSync(ROM)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the S1 core and the oracle both boot game2.gb, leave the title by counter 60 and reach sector 2 by counter 960 under explorer seed 21, with equal contract RAM there", { skip: !existsSync(DYLIB) && `SameBoy libretro absent at ${DYLIB}` }, async () => {
  const rom = new Uint8Array(readFileSync(ROM));
  const trace = explorerTrace({ rom_sha: sha256(rom), frames: SMOKE_SCENE2_BY, seed: SMOKE_SEED });
  const core = (await loadCreateCore(join(REPO, "core")))(rom);
  const stepper = counterStepper(core, LOCKSTEP_RAM.addr);
  const coreRam = () => Uint8Array.from({ length: LOCKSTEP_RAM.len }, (_, i) => core.read(LOCKSTEP_RAM.addr + i) & 0xff);
  const coreAt = new Map<number, Uint8Array>();
  for (let n = 1; n <= SMOKE_SCENE2_BY; n++) {
    core.setButtons(maskAt(trace.inputs, n - 1));
    assert.ok(stepper.to(n), `core reached counter ${n}`);
    if (n === SMOKE_SCENE1_BY || n === SMOKE_SCENE2_BY) coreAt.set(n, coreRam());
  }
  const o = OracleClient.spawn();
  try {
    await o.load(ROM, "counter");
    for (const [n, want] of [[SMOKE_SCENE1_BY, 1], [SMOKE_SCENE2_BY, 2]] as const) {
      const r = await o.runToCounter(n, trace.inputs);
      assert.equal(r.stalled, false);
      const ram = await o.ram(LOCKSTEP_RAM.addr, LOCKSTEP_RAM.len);
      assert.equal(ram[SCENE_OFFSET], want, `oracle scene at ${n}`);
      assert.equal(coreAt.get(n)![SCENE_OFFSET], want, `core scene at ${n}`);
      assert.deepEqual([...coreAt.get(n)!], [...ram], `contract RAM at ${n}`);
    }
  } finally {
    await o.close();
  }
});
