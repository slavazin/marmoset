// cgb-suite play (loop/campaign.ts cgbSuitePlay) and the run-id parameter (campaignRun).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { git, type LoopPaths } from "./paths.ts";
import { all, status } from "./ledger.ts";
import { campaignRun, cgbSuitePlay, CGB_QUEUE_DEPTH } from "./campaign.ts";
import { romsDir } from "../suites/splits.ts";
import type { Incident } from "../src/schema.ts";

const REPO = resolve(import.meta.dirname, "..");
const MEALY = "mealybug-tearoom-tests/ppu/m3_bgp_change.gb";
const skip = !existsSync(join(romsDir(), MEALY)) && `${MEALY} absent`;

function bed(): LoopPaths {
  const t = mkdtempSync(join(tmpdir(), "ratchet-cgbplay-"));
  const live = join(t, "live");
  mkdirSync(join(live, "core"), { recursive: true });
  writeFileSync(join(live, "core", "index.ts"), `export { createCore } from ${JSON.stringify(join(REPO, "suites", "fixtures", "cgb-nop-core", "index.ts"))};\n`);
  git(live, ["init", "--quiet", "-b", "core-live"]);
  git(live, ["add", "core"]);
  git(live, ["commit", "--quiet", "-m", "cgb nop core"]);
  return { root: join(t, "root"), ledger: join(t, "ledger"), traces: join(t, "traces"), skills: join(t, "skills"), evidence: join(t, "evidence"), live, cache: join(t, "cache"), roms: romsDir(), server: "http://127.0.0.1:9", scratch: join(t, "scratch") };
}

test("cgb-suite play: opens one CGB suite incident per segment while fewer than CGB_QUEUE_DEPTH are open, never reopens a ROM that had one, and carries the run", { skip }, async () => {
  const before = process.env.RATCHET_SPLITS;
  process.env.RATCHET_SPLITS = "splits.json,splits-cgb.json";
  try {
    const paths = bed();
    const play = cgbSuitePlay(paths, { idleMs: 0, run: "RUN-0002", families: ["cgb:mealybug:palette-scroll-bg"] });
    const opened: Incident[] = [];
    for (let i = 0; i < CGB_QUEUE_DEPTH + 1; i++) opened.push(...(await play(1001 + i)).opened);
    assert.equal(opened.length, CGB_QUEUE_DEPTH, "the queue holds at CGB_QUEUE_DEPTH open incidents");
    for (const inc of opened) {
      assert.equal(inc.source, "suite");
      assert.equal(inc.run, "RUN-0002");
      const w = JSON.parse(readFileSync(join(paths.evidence, "incidents", inc.id, "window.json"), "utf8"));
      assert.equal(w.model, "CGB");
    }
    status("incidents.jsonl", opened[0].id, "status", "unrepaired", paths.ledger);
    const next = (await play(2001)).opened;
    assert.equal(next.length, 1);
    const shas = all<Incident>("incidents.jsonl", paths.ledger).map((i) => i.rom_sha);
    assert.equal(new Set(shas).size, shas.length, "no ROM opens a second incident");
  } finally {
    if (before === undefined) delete process.env.RATCHET_SPLITS; else process.env.RATCHET_SPLITS = before;
  }
});

test("romDirs: an incident ROM is found in the run's game directory (RATCHET_GAME) as well as the suite ROMs and <root>/game, each once; the default game is <root>/game/game.gb", async () => {
  const { romDirs } = await import("./roms.ts");
  const { pathsFromEnv, gamePath } = await import("./paths.ts");
  const p = pathsFromEnv({ RATCHET_GAME: "~/.cache/ratchet/games/owner.gb" }, "/repo");
  assert.deepEqual(romDirs(p), [p.roms, "/repo/game", join(process.env.HOME ?? "", ".cache/ratchet/games")]);
  const d = pathsFromEnv({}, "/repo");
  assert.equal(gamePath(d), "/repo/game/game.gb");
  assert.deepEqual(romDirs(d), [d.roms, "/repo/game"]);
  assert.equal(gamePath({ ...d, game: undefined }), "/repo/game/game.gb");
});

test("RATCHET_SPLITS merges splits.json and splits-cgb.json: every family of each, CGB ones with model CGB; a family in two files throws", async () => {
  const { loadSplits, mergeSplits, splitsPaths, SPLITS_PATH, SPLITS_CGB_PATH } = await import("../suites/splits.ts");
  assert.deepEqual(splitsPaths({}), [SPLITS_PATH]);
  assert.deepEqual(splitsPaths({ RATCHET_SPLITS: "splits.json, splits-cgb.json" }), [SPLITS_PATH, SPLITS_CGB_PATH]);
  const a = loadSplits(SPLITS_PATH), b = loadSplits(SPLITS_CGB_PATH);
  const m = mergeSplits([a, b]);
  assert.deepEqual(Object.keys(m.families).sort(), [...Object.keys(a.families), ...Object.keys(b.families)].sort());
  assert.equal(m.families["cgb:mealybug:palette-scroll-bg"].model, "CGB");
  assert.equal(m.excluded.length, a.excluded.length + b.excluded.length);
  assert.throws(() => mergeSplits([a, a]), /in two splits files/);
});

test("campaignRun: --run wins over RATCHET_RUN, RATCHET_RUN over RUN-0001, and a name that is not RUN-NNNN is refused", () => {
  assert.equal(campaignRun(undefined, {}), "RUN-0001");
  assert.equal(campaignRun(undefined, { RATCHET_RUN: "RUN-0003" }), "RUN-0003");
  assert.equal(campaignRun("RUN-0004", { RATCHET_RUN: "RUN-0003" }), "RUN-0004");
  assert.throws(() => campaignRun("run-2", {}), /not RUN-NNNN/);
  assert.throws(() => campaignRun("../RUN-0001", {}), /not RUN-NNNN/);
});
