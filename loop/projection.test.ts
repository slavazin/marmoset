import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { makeBed, writeSkill } from "./fixtures/harness.ts";
import { repairPacket, allowed, fileList, removeScratch } from "./projection.ts";
import { listSkills, selectShown, hooksFor, SKILL_ARMS } from "./shown.ts";
import { git } from "./paths.ts";
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
    // the env ROM path lists only the task's ROM
    const romList = fileList(p.env.RATCHET_ROMS).filter((r) => lstatSync(join(p.env.RATCHET_ROMS, r)).isSymbolicLink());
    assert.deepEqual(romList, [arm === "fast" ? "fixture/inc.gb" : "fixture/adm.gb"]);
    assert.equal(readdirSync(join(p.env.RATCHET_CACHE, "oracle")).length, arm === "fast" ? 1 : 0);
    removeScratch(p.dir);
  });
}

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
