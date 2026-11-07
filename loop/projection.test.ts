import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, readdirSync, lstatSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { makeBed, writeSkill } from "./fixtures/harness.ts";
import { repairPacket, allowed, fileList, removeScratch } from "./projection.ts";
import { listSkills, selectShown, hooksFor, SKILL_ARMS } from "./shown.ts";
import { git, pathsFromEnv, scratchRoot, DEFAULT_SCRATCH } from "./paths.ts";
import { MAX_SHOWN } from "./gate.ts";
import type { Arm, RepairTask } from "../src/schema.ts";

const ARMS: Arm[] = ["fast", "candidate", "baseline", "placebo", "vread-baseline", "vread-ratchet"];

for (const arm of ARMS) {
  test(`arm ${arm}: every path of the real scratch file list is on the allowlist, and skills and hooks appear only on skill arms`, () => {
    const bed = makeBed();
    writeSkill(bed, "SKL-0001");
    const base = git(bed.paths.live, ["rev-parse", "core-live"]);
    const task: RepairTask = arm === "fast"
      ? { kind: "incident", incident: "INC-0001", base_commit: base, arm, skills: ["SKL-0001"], budget: { max_steps: 1, wall_s: 1 } }
      : { kind: "family", family: "mealybug:window", base_commit: base, arm, skills: SKILL_ARMS.has(arm) ? ["SKL-0001"] : [], budget: { max_steps: 1, wall_s: 1 } };
    const shown = SKILL_ARMS.has(arm) ? listSkills(bed.paths.skills, "graduated") : [];
    const p = repairPacket(task, { attempt: `ATT-00${ARMS.indexOf(arm) + 1}0`, paths: bed.paths, incident: bed.incident, familyRoms: arm === "fast" ? undefined : [bed.admRom], shown });
    const real = fileList(p.dir, (rel) => rel.startsWith(".git/"));
    const off = real.filter((rel) => !allowed(arm, rel));
    assert.deepEqual(off, []);
    assert.deepEqual(p.files, real);
    for (const must of ["core/index.ts", "core/ppu.ts", "packet/TASK.md", "packet/task.json", "packet/ATTEMPT.json", "packet/roms.json", "tools/replay.mjs", "tools/fire.mjs", ".muse/hooks.json", ".git"]) assert.ok(real.includes(must), must);
    const hooks = JSON.parse(readFileSync(join(p.dir, ".muse", "hooks.json"), "utf8"));
    if (SKILL_ARMS.has(arm)) {
      assert.ok(real.includes(".agents/skills/SKL-0001/SKILL.md"));
      assert.equal(statSync(join(p.dir, ".agents/skills/SKL-0001/SKILL.md")).mode & 0o222, 0);
      assert.deepEqual(hooks, { hooks: { PreToolUse: [{ matcher: "edit_file", hooks: [{ type: "command", command: "node tools/fire.mjs SKL-0001" }] }] } });
    } else {
      assert.equal(real.some((r) => r.startsWith(".agents")), false);
      assert.deepEqual(hooks, { hooks: {} });
    }
    if (arm === "fast") {
      assert.ok(real.includes("packet/incident.json") && real.includes("packet/trace.json") && real.includes("packet/evidence/window.json"));
    }
    // the env ROM path lists only the task's ROM, as a read-only copy
    const romList = fileList(p.env.RATCHET_ROMS).filter((r) => lstatSync(join(p.env.RATCHET_ROMS, r)).isFile());
    assert.deepEqual(romList, [arm === "fast" ? "fixture/inc.gb" : "fixture/adm.gb"]);
    assert.equal(statSync(join(p.env.RATCHET_ROMS, romList[0])).mode & 0o222, 0);
    assert.equal(readdirSync(join(p.env.RATCHET_CACHE, "oracle")).length, arm === "fast" ? 1 : 0);
    removeScratch(p.dir);
  });
}

test("the env oracle cache holds a read-only copy of the incident trace's frames only, never a link into the real cache or a sibling trace", () => {
  const bed = makeBed();
  const romDir = join(bed.paths.cache, "oracle", bed.incident.rom_sha);
  mkdirSync(join(romDir, "f".repeat(64)), { recursive: true });
  writeFileSync(join(romDir, "f".repeat(64), "1.bin"), "sibling trace of the same ROM");
  const base = git(bed.paths.live, ["rev-parse", "core-live"]);
  const p = repairPacket({ kind: "incident", incident: "INC-0001", base_commit: base, arm: "fast", skills: [], budget: { max_steps: 1, wall_s: 1 } }, { attempt: "ATT-0001", paths: bed.paths, incident: bed.incident });
  const envRom = join(p.env.RATCHET_CACHE, "oracle", bed.incident.rom_sha);
  assert.deepEqual(readdirSync(envRom), [bed.incident.trace_sha]);
  for (const rel of fileList(join(p.env.RATCHET_CACHE, "oracle"))) assert.equal(lstatSync(join(p.env.RATCHET_CACHE, "oracle", rel)).isSymbolicLink(), false, rel);
  const f = join(envRom, bed.incident.trace_sha, "1.bin");
  assert.equal(statSync(f).mode & 0o222, 0);
  assert.throws(() => writeFileSync(f, "poison"), /EACCES|EPERM/);
  assert.equal(readFileSync(join(romDir, bed.incident.trace_sha, "1.bin"))[0], 2);
  // the evidence copy points the repairer at its copy, not at the real cache
  assert.equal(JSON.parse(readFileSync(join(p.dir, "packet", "evidence", "window.json"), "utf8")).oracle_dir, join(envRom, bed.incident.trace_sha));
  removeScratch(p.envDir);
  removeScratch(p.dir);
});

test("node_modules in the scratch repo is a read-only copy: a write through it cannot reach the repository's node_modules", () => {
  const bed = makeBed();
  mkdirSync(join(bed.paths.root, "node_modules", "pkg"), { recursive: true });
  writeFileSync(join(bed.paths.root, "node_modules", "pkg", "index.js"), "export const ok = 1;\n");
  const base = git(bed.paths.live, ["rev-parse", "core-live"]);
  const p = repairPacket({ kind: "incident", incident: "INC-0001", base_commit: base, arm: "fast", skills: [], budget: { max_steps: 1, wall_s: 1 } }, { attempt: "ATT-0001", paths: bed.paths, incident: bed.incident });
  const nm = join(p.dir, "node_modules");
  assert.equal(lstatSync(nm).isSymbolicLink(), true);
  assert.notEqual(realpathSync(nm), realpathSync(join(bed.paths.root, "node_modules")));
  assert.equal(readFileSync(join(nm, "pkg", "index.js"), "utf8"), "export const ok = 1;\n");
  assert.throws(() => writeFileSync(join(nm, "pkg", "index.js"), "export const ok = 0;\n"), /EACCES|EPERM/);
  assert.equal(readFileSync(join(bed.paths.root, "node_modules", "pkg", "index.js"), "utf8"), "export const ok = 1;\n");
  removeScratch(p.dir);
});

test("the allowlist refuses loop/, suites/, oracle/, splits.json and skills on the baseline arm", () => {
  for (const p of ["loop/gate.ts", "suites/score.ts", "oracle/frontend.py", "splits.json", "tools/replay.ts", ".muse/other.json"]) assert.equal(allowed("fast", p), false, p);
  assert.equal(allowed("baseline", ".agents/skills/SKL-0001/SKILL.md"), false);
  assert.equal(allowed("fast", ".agents/skills/SKL-0001/SKILL.md"), true);
});

test("selectShown keeps MAX_SHOWN skills and evicts the least recently fired, never-fired first", () => {
  const ids = Array.from({ length: MAX_SHOWN + 2 }, (_, i) => `SKL-000${i + 1}`);
  const fires = ids.slice(0, MAX_SHOWN + 1).map((skill, i) => ({ skill, at: `2026-11-07T10:0${i}:00Z` }));
  const kept = selectShown(ids, fires);
  assert.equal(kept.length, MAX_SHOWN);
  assert.equal(kept.includes(ids[MAX_SHOWN + 1]), false); // never fired
  assert.equal(kept.includes(ids[0]), false); // fired longest ago
});

test("hooksFor writes no matcher for baseline and vread-baseline", () => {
  const s = [{ id: "SKL-0001", dir: "", paths: ["core/*.ts"], owed: "x" }];
  assert.deepEqual(hooksFor("baseline", s), { hooks: {} });
  assert.deepEqual(hooksFor("vread-baseline", s), { hooks: {} });
  assert.equal(hooksFor("placebo", s).hooks.PreToolUse?.[0].hooks.length, 1);
});

/** True when `p` is `dir` or lies under it, compared on real paths where they exist. */
function inside(p: string, dir: string): boolean {
  const real = (x: string) => { try { return realpathSync(x); } catch { return resolve(x); } };
  const rel = relative(real(dir), real(p));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

test("no relative hop (../, ../../, ../../../) from a scratch repo resolves into the cache, the repository, the live clone or the ledger", () => {
  const bed = makeBed();
  mkdirSync(join(bed.paths.root, "node_modules", "pkg"), { recursive: true });
  const base = git(bed.paths.live, ["rev-parse", "core-live"]);
  const p = repairPacket({ kind: "incident", incident: "INC-0001", base_commit: base, arm: "fast", skills: [], budget: { max_steps: 1, wall_s: 1 } }, { attempt: "ATT-0001", paths: bed.paths, incident: bed.incident });
  // the bed's paths, and the defaults pathsFromEnv reads with no RATCHET_* variable set
  const defaults = pathsFromEnv({});
  assert.equal(scratchRoot(defaults), DEFAULT_SCRATCH);
  const cases = [
    { dir: p.dir, paths: bed.paths },
    { dir: join(scratchRoot(defaults), "ATT-0001"), paths: defaults },
  ];
  for (const { dir, paths } of cases) {
    for (const hop of ["..", "../..", "../../.."]) {
      const at = resolve(dir, hop);
      for (const [name, guarded] of [["cache", paths.cache], ["repository", paths.root], ["live clone", paths.live], ["ledger", paths.ledger]] as const) {
        assert.equal(inside(at, guarded), false, `${dir}/${hop} -> ${at} lies in the ${name} ${guarded}`);
      }
    }
  }
  // node_modules' read-only copy sits under the scratch root, so a hop through the link stays out of the cache
  const nmUp = resolve(realpathSync(join(p.dir, "node_modules")), "..", "..");
  assert.equal(inside(nmUp, bed.paths.cache), false);
  assert.equal(inside(nmUp, bed.paths.root), false);
  removeScratch(p.envDir);
  removeScratch(p.dir);
});
