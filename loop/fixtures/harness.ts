// Test bed for loop/ tests: a temp main repo holding loop/fixtures/core as core/, a live clone on core-live, a
// root with ledger/, traces/, skills/, evidence/ and the repository's tools/replay.mjs and tools/fire.mjs, two
// fixture ROMs, and cached oracle frames. The incident ROM (first byte 2) diverges on the fixture core (shade 3
// against the oracle's 2); the admitted trace TRC-0001 runs the other ROM (first byte 1), which is clean.

import { cpSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { git, type LoopPaths } from "../paths.ts";
import { append } from "../ledger.ts";
import { sha256, traceSha } from "../../oracle/client.ts";
import type { Attempt, Incident, RepairTask, TraceInput } from "../../src/schema.ts";

const REPO = resolve(import.meta.dirname, "..", "..");
export const FIXTURE_CORE = join(REPO, "loop", "fixtures", "core");
/** The fixture incident's window [n-60, n+120] shrunk to counters 1…8 so a test replays 8 frames. */
export const WINDOW: [number, number] = [1, 8];

export interface Bed { paths: LoopPaths; main: string; incident: Incident; incRom: string; admRom: string }

function rom(byte: number): Uint8Array {
  const r = new Uint8Array(32);
  r[0] = byte;
  r[1] = 0x5a;
  return r;
}

function cacheFrames(cache: string, r: Uint8Array, inputs: TraceInput[], shade: number, to: number): string {
  const rom_sha = sha256(r);
  const dir = join(cache, "oracle", rom_sha, traceSha({ rom_sha, align: "counter", inputs }));
  mkdirSync(dir, { recursive: true });
  for (let n = 1; n <= to; n++) writeFileSync(join(dir, `${n}.bin`), new Uint8Array(160 * 144).fill(shade));
  return dir;
}

export function makeBed(): Bed {
  const t = mkdtempSync(join(tmpdir(), "ratchet-loop-"));
  const main = join(t, "main"), live = join(t, "live"), root = join(t, "root"), cache = join(t, "cache"), roms = join(t, "roms");
  mkdirSync(main, { recursive: true });
  cpSync(FIXTURE_CORE, join(main, "core"), { recursive: true });
  writeFileSync(join(main, "README"), "fixture main\n");
  git(main, ["init", "--quiet", "-b", "main"]);
  git(main, ["add", "core", "README"]);
  git(main, ["commit", "--quiet", "-m", "fixture core"]);
  git(t, ["clone", "--quiet", main, live]);
  git(live, ["checkout", "--quiet", "-b", "core-live"]);
  for (const d of ["ledger", "traces", "skills/graduated", "skills/shadow", "evidence/incidents", "tools", "game"]) mkdirSync(join(root, d), { recursive: true });
  for (const f of ["replay.mjs", "fire.mjs"]) cpSync(join(REPO, "tools", f), join(root, "tools", f));
  mkdirSync(roms, { recursive: true });
  const inc = rom(2), adm = rom(1);
  const incRom = join(roms, "fixture", "inc.gb"), admRom = join(roms, "fixture", "adm.gb");
  mkdirSync(join(roms, "fixture"), { recursive: true });
  writeFileSync(incRom, inc);
  writeFileSync(admRom, adm);
  writeFileSync(join(roms, "other.gb"), rom(3));

  const inputs: TraceInput[] = [{ from_counter: 0, mask: 0 }];
  const oracleDir = cacheFrames(cache, inc, inputs, 2, WINDOW[1]);
  const admInputs: TraceInput[] = [{ from_counter: 1, mask: 0 }];
  cacheFrames(cache, adm, admInputs, 1, WINDOW[1]);
  writeFileSync(join(root, "traces", "TRC-0001.json"), JSON.stringify({ id: "TRC-0001", rom_sha: sha256(adm), align: "counter", inputs: admInputs, counter_end: WINDOW[1], source: "explorer", window: WINDOW }));

  // the scratch root is its own temp dir, as DEFAULT_SCRATCH is: under none of the bed's cache, root or live clone
  const scratch = mkdtempSync(join(tmpdir(), "ratchet-scratch-"));
  const paths: LoopPaths = { root, ledger: join(root, "ledger"), traces: join(root, "traces"), skills: join(root, "skills"), evidence: join(root, "evidence"), live, cache, roms, server: "http://127.0.0.1:9", scratch };
  const incident: Incident = {
    id: "INC-0001", at: "2026-11-07T00:00:00.000Z", run: null, kind: "frame", align: "counter",
    signature: { scene: 1, band: 2, bbox: [0, 0, 159, 143] }, rom_sha: sha256(inc), trace_sha: traceSha({ rom_sha: sha256(inc), align: "counter", inputs }),
    window: WINDOW, core_commit: git(live, ["rev-parse", "HEAD"]), counter: 4, pixels: 23040,
    files: { dir: "evidence/incidents/INC-0001" }, source: "play", status: "open",
  };
  const ev = join(root, "evidence", "incidents", "INC-0001");
  mkdirSync(ev, { recursive: true });
  writeFileSync(join(ev, "window.json"), JSON.stringify({ kind: "frames", incident, rom: { path: incRom, sha: incident.rom_sha }, trace: { align: "counter", inputs, counter_end: WINDOW[1] }, oracle_dir: oracleDir, oracle_ram: {} }));
  append("incidents.jsonl", incident, paths.ledger);
  return { paths, main, incident, incRom, admRom };
}

/** Sets ppu.ts in a core dir to `body` (the shadeFor function body). */
export function setShade(dir: string, body: string): void {
  writeFileSync(join(dir, "core", "ppu.ts"), `export function shadeFor(romByte: number): number {\n  ${body}\n}\n`);
}

/** The fix: every ROM renders its first byte's shade. */
export const FIX = "return romByte & 3;";
/** Fixes the incident ROM (2 → 2) and breaks the admitted trace's ROM (1 → 0). */
export const BREAKS_ADMITTED = "return romByte === 2 ? 2 : 0;";

/** A diff against the fixture core produced by real git: `edit` runs in a copy of the core's repo; `binary` adds --binary as loop/repair.ts scratchDiff does. */
export function makeDiff(edit: (dir: string) => void, binary = false): string {
  const d = mkdtempSync(join(tmpdir(), "ratchet-diff-"));
  cpSync(FIXTURE_CORE, join(d, "core"), { recursive: true });
  git(d, ["init", "--quiet"]);
  git(d, ["add", "core"]);
  git(d, ["commit", "--quiet", "-m", "base"]);
  edit(d);
  git(d, ["add", "-A", "."]);
  return git(d, ["diff", "--cached", ...(binary ? ["--binary"] : []), "HEAD"]) + "\n";
}

export function attemptFor(bed: Bed, id = "ATT-0001", skills: string[] = []): Attempt {
  const task: RepairTask = { kind: "incident", incident: bed.incident.id, base_commit: git(bed.paths.live, ["rev-parse", "core-live"]), arm: "fast", skills, budget: { max_steps: 1, wall_s: 10 } };
  return {
    id, at: "2026-11-07T00:00:00.000Z", run: null, task, branch: `attempt/${id}`, model: "fake", fires: [],
    result: { dispositions: {}, off_map: null, beliefs: [{ claim: "The fixture PPU renders a ROM's first byte as the frame shade.", false_if: "a ROM with first byte 2 renders shade 3 on the oracle." }], summary: "Renders every ROM's first byte as its shade." },
    spent: { steps: 0, wall_s: 0, tokens_in: 0, tokens_out: 0, usd: 0 }, scratch_files: [],
    isolation: { home: "", skills_list: "", observers: "on-identical", web_tools: "on" },
  };
}

/** A SKILL.md under skills/graduated/<id>/ with activation paths and owed (SPEC §6.9 frontmatter, flow form). */
export function writeSkill(bed: Bed, id: string, paths = ["core/ppu*.ts"], owed = "name the PPU dot the fix keys on"): void {
  const d = join(bed.paths.skills, "graduated", id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\nid: ${id}\nname: fixture-skill\nstatus: graduated\nactivation:\n  fires-when: a PPU file is edited\n  not-this: CPU timing\n  paths: [${paths.join(", ")}]\n  owed: ${owed}\n---\n**Do:** fixture.\n**Don't:** fixture.\n`);
}

export function readJson(p: string): unknown { return JSON.parse(readFileSync(p, "utf8")); }
