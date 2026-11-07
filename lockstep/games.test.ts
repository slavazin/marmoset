// The games registry (games.json, lockstep/games.ts) and the no-ROM-in-git rule (AGENTS.md rule 8).
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { CONTRACT_MAP, gameById, gameBySha, mapOf, mappedRam, readRegistry, REGISTRY, romPathOf, sceneOffset } from "./games.ts";
import { GAME_RAM, SCENE_OFFSET } from "./diff.ts";

const REPO = resolve(import.meta.dirname, "..");
const GAME = join(REPO, "game", "game.gb");
/** The Nintendo logo's first 8 bytes, which every Game Boy cartridge header carries at 0x104. */
const LOGO = Buffer.from([0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b]);
/** Tracked files allowed to carry a Game Boy header: Ratchet's own games (game/, game2/ HALOGEN) and its own RGBDS fixtures. */
const ALLOWED = [/^game\/[^/]+\.gb$/, /^game2\/[^/]+\.gb$/, /^oracle\/fixtures\/[^/]+\.gb$/];

test("no tracked file carries a Game Boy cartridge header (Nintendo logo at 0x104) except game/*.gb, game2/*.gb and oracle/fixtures/*.gb", () => {
  const files = execFileSync("git", ["-C", REPO, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const hits: string[] = [];
  for (const f of files) {
    let b: Buffer;
    try { b = readFileSync(join(REPO, f)); } catch { continue; }
    if (b.length >= 0x10c && b.subarray(0x104, 0x10c).equals(LOGO)) hits.push(f);
  }
  const bad = hits.filter((f) => !ALLOWED.some((r) => r.test(f)));
  assert.deepEqual(bad, []);
  assert.ok(hits.includes("game/game.gb"), "the scan reads headers: game/game.gb is found");
});

test(".gitignore ignores a .gb or .gbc file outside game/ and oracle/fixtures/", () => {
  const ignored = (p: string) => { try { execFileSync("git", ["-C", REPO, "check-ignore", "-q", "--no-index", p]); return true; } catch { return false; } };
  assert.ok(ignored("games/mario-yoshi-eu.gb"));
  assert.ok(ignored("evidence/s22/x.GBC") || ignored("evidence/s22/x.gbc"));
  assert.ok(ignored("x.gbc"));
  assert.ok(!ignored("game/game.gb"));
  assert.ok(!ignored("oracle/fixtures/counter.gb"));
});

test("game.gb's entry keeps RUN-0001's comparison: contract s6.17, align counter, seeded RAM, no start, and SPEC §6.17's map", () => {
  const g = gameById("game");
  assert.equal(g.contract, "s6.17");
  assert.equal(g.align, "counter");
  assert.equal(g.ram_init, "seeded");
  assert.equal(g.start, null);
  assert.deepEqual(mapOf(g), CONTRACT_MAP);
  assert.deepEqual(CONTRACT_MAP.logic, [{ addr: GAME_RAM.addr, len: GAME_RAM.len }]);
  assert.equal(sceneOffset(CONTRACT_MAP), SCENE_OFFSET);
  assert.equal(gameBySha(new Uint8Array(readFileSync(GAME)))?.id, "game");
});

test("gameBySha selects by the ROM's bytes: a copy under another name, a ./ path and a symlink select the entry; one changed byte selects none", () => {
  const dir = mkdtempSync(join(tmpdir(), "ratchet-games-"));
  const copy = join(dir, "Some Other Name.GB");
  copyFileSync(GAME, copy);
  symlinkSync(copy, join(dir, "link.gb"));
  for (const p of [copy, join(dir, "link.gb"), "./" + join("game", "game.gb")]) {
    assert.equal(gameBySha(new Uint8Array(readFileSync(p.startsWith("./") ? join(REPO, p) : p)))?.id, "game", p);
  }
  const bytes = new Uint8Array(readFileSync(GAME));
  bytes[0x200] ^= 1;
  assert.equal(gameBySha(bytes), null);
});

test("romPathOf refuses a file at the entry's env path whose bytes do not hash to the entry's sha", () => {
  const g = gameById("mario-yoshi-eu");
  const dir = mkdtempSync(join(tmpdir(), "ratchet-games-"));
  const fake = join(dir, "mario-yoshi-eu.gb");
  copyFileSync(GAME, fake);
  const was = process.env[g.rom.env!];
  process.env[g.rom.env!] = fake;
  try {
    assert.throws(() => romPathOf(g), /does not hash/);
  } finally {
    if (was === undefined) delete process.env[g.rom.env!]; else process.env[g.rom.env!] = was;
  }
});

test("readRegistry refuses a start state on seeded RAM, a scene byte outside the logic ranges, an address outside WRAM, an align that disagrees with the counter, and a duplicate sha", () => {
  const base = JSON.parse(readFileSync(REGISTRY, "utf8"));
  const my = base.games.find((g: { id: string }) => g.id === "mario-yoshi-eu");
  const variants: [string, object][] = [
    ["ram_init", { ...my, ram_init: "seeded" }],
    ["scene byte", { ...my, map: { ...my.map, scene: { addr: 0xc100 } } }],
    ["outside WRAM", { ...my, map: { ...my.map, logic: [...my.map.logic, { addr: 0xff80, len: 1 }] } }],
    ["disagrees", { ...my, align: "counter" }],
    ["duplicate", { ...my, id: "again" }],
  ];
  for (const [why, v] of variants) {
    const f = join(mkdtempSync(join(tmpdir(), "ratchet-reg-")), "games.json");
    const games = why === "duplicate" ? [...base.games, v] : base.games.map((g: { id: string }) => (g.id === "mario-yoshi-eu" ? v : g));
    writeFileSync(f, JSON.stringify({ games }));
    assert.throws(() => readRegistry(f), new RegExp(why === "duplicate" ? "duplicate" : why === "ram_init" ? "ram_init" : why === "disagrees" ? "disagrees" : why === "scene byte" ? "scene byte" : "outside WRAM"), why);
  }
});

test("mappedRam concatenates the logic ranges in order", () => {
  const map = { counter: null, scene: { addr: 0xc000 }, logic: [{ addr: 0xc010, len: 2 }, { addr: 0xc000, len: 1 }] };
  assert.deepEqual([...mappedRam(map, (a) => a & 0xff)], [0x10, 0x11, 0x00]);
});
