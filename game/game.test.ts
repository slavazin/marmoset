import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GAME_RAM } from "../src/schema.ts";

const here = new URL(".", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, here), "utf8");

test("game/src/contract.h addresses equal GAME_RAM in src/schema.ts", () => {
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

test("game/build.sh links _DATA above the contract bytes 0xC0F0-0xC0F6", () => {
  const m = read("build.sh").match(/-Wl-b_DATA=(0x[0-9A-Fa-f]+)/);
  assert.ok(m);
  assert.ok(parseInt(m[1], 16) > GAME_RAM.lives);
});

test("game/game.gb header reads MBC1 (0x147 = 0x01), 64 KiB (0x148 = 0x01) and a valid header checksum", () => {
  const rom = readFileSync(new URL("game.gb", here));
  assert.equal(rom.length, 65536);
  assert.equal(rom[0x147], 0x01);
  assert.equal(rom[0x148], 0x01);
  let x = 0;
  for (let i = 0x134; i <= 0x14c; i++) x = (x - rom[i] - 1) & 0xff;
  assert.equal(rom[0x14d], x);
});

test("every level map row in game/src/level{1,2,3}.c is 64 cells of the levels.h legend", () => {
  for (const n of [1, 2, 3]) {
    const src = read(`src/level${n}.c`);
    assert.match(src, new RegExp(`#pragma bank ${n}\\b`));
    const rows = [...src.matchAll(/^\s*"([^"]*)",\s*$/gm)].map((m) => m[1]);
    assert.equal(rows.length, 10, `level ${n} rows`);
    for (const r of rows) assert.match(r, /^[.#=fG]{64}$/, `level ${n} row`);
    assert.ok(rows.some((r) => r.includes("G")), `level ${n} has a goal`);
  }
});

test("game/src reads neither DIV nor the timer registers (D-0007)", () => {
  for (const f of ["main.c", "art.c", "level1.c", "level2.c", "level3.c"]) {
    const src = read(`src/${f}`);
    assert.doesNotMatch(src, /\b(DIV_REG|TIMA_REG|TMA_REG|TAC_REG|rand|arand|initrand|0xFF0[4-7])\b/i, f);
  }
});
