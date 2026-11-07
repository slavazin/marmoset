// The gate's skill rule (SPEC G4 second paragraph, §5 S9), beside the rule constants in loop/gate.ts and the repair
// logic in loop/gate-repair.ts. Offers:
//   unitValue(reading)       a family reading in its unit: Mealybug points of mean pixel match (0..100), else ROMs passed;
//   marginFor(family, a, b)  max(MARGIN_FLOOR[family], 2 × |a − b|) over two baseline readings, in that unit;
//   decideSkill(input)       GRADUATE iff on every trial family candidate − max(baseline, placebo) >= the family's
//                            margin and no arm's base-suite pass count drops below the base commit's; else REFUSE,
//                            naming the deciding check and its reading (gate-skill.test.ts);
//   graduateSkill / tombstoneSkill   the skill's move: skills/shadow/<id>/ → skills/graduated/<id>/ with a status
//                            flip, or → skills/tombstones/<id>.md (SPEC §6.10 frontmatter, then the skill's text with
//                            status tombstoned). A move keeps every byte of the skill; nothing is deleted outright.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MARGIN_FLOOR } from "./gate.ts";
import type { CheckName, SkillStatus, SuiteReading, TombstoneFrontmatter } from "../src/schema.ts";

/** A family's unit: "pts" (mean pixel match × 100) for Mealybug families, "roms" (ROMs passed) for every other family. */
export function familyUnit(family: string): "pts" | "roms" {
  return family.startsWith("mealybug") ? "pts" : "roms";
}

export function unitValue(r: SuiteReading): number {
  return familyUnit(r.family) === "pts" ? r.pixel_match * 100 : r.pass;
}

export function marginFor(family: string, a: SuiteReading, b: SuiteReading): { spread: number; margin: number } {
  const spread = Math.abs(unitValue(a) - unitValue(b));
  return { spread, margin: Math.max(MARGIN_FLOOR[family] ?? 0, 2 * spread) };
}

export type TrialArm = "candidate" | "baseline" | "placebo";
export interface SkillDecisionInput {
  families: readonly string[];
  readings: Record<TrialArm, SuiteReading[]>;
  margin: Record<string, number>;
  /** The base suites at the trial's base commit, and each arm's base suites after its diff. */
  baseRef: SuiteReading[];
  armBase: Record<TrialArm, SuiteReading[][]>;
}
export interface SkillDecision { decision: "GRADUATE" | "REFUSE"; checks: { name: CheckName; pass: boolean; reading: unknown }[]; reason: string }

const fmt = (x: number) => (Math.round(x * 100) / 100).toString();
const signed = (x: number) => (x >= 0 ? "+" : "") + fmt(x);

/** The skill rule (see the file header). */
export function decideSkill(i: SkillDecisionInput): SkillDecision {
  const ref = new Map(i.baseRef.map((r) => [r.family, r.pass]));
  const regressions: { arm: TrialArm; family: string; pass: number; base: number }[] = [];
  for (const arm of ["candidate", "baseline", "placebo"] as TrialArm[])
    for (const run of i.armBase[arm]) for (const r of run) { const b = ref.get(r.family); if (b !== undefined && r.pass < b) regressions.push({ arm, family: r.family, pass: r.pass, base: b }); }
  const baseCheck = { name: "base-suites" as CheckName, pass: regressions.length === 0, reading: { regressions } };

  const per = i.families.map((f) => {
    const v = (arm: TrialArm) => { const r = i.readings[arm].find((x) => x.family === f); return r ? unitValue(r) : NaN; };
    const c = v("candidate"), b = v("baseline"), p = v("placebo");
    const gap = c - Math.max(b, p);
    return { family: f, unit: familyUnit(f), candidate: c, baseline: b, placebo: p, margin: i.margin[f], gap, pass: Number.isFinite(gap) && gap >= i.margin[f] };
  });
  const marginCheck = { name: "trial-margin" as CheckName, pass: per.every((x) => x.pass), reading: per };

  const checks = [baseCheck, marginCheck];
  if (!baseCheck.pass) {
    const r = regressions[0];
    return { decision: "REFUSE", checks, reason: `base-suites: the ${r.arm} arm drops ${r.family} from ${r.base} to ${r.pass} ROMs passed` };
  }
  const fail = per.find((x) => !x.pass);
  if (fail) {
    const rival = fail.placebo >= fail.baseline ? "placebo" : "baseline";
    return { decision: "REFUSE", checks, reason: `trial-margin: ${rival} within margin on ${fail.family}: candidate ${fmt(fail.candidate)}, baseline ${fmt(fail.baseline)}, placebo ${fmt(fail.placebo)}, gap ${signed(fail.gap)}, margin ${fmt(fail.margin)} (${fail.unit})` };
  }
  return { decision: "GRADUATE", checks, reason: `trial-margin: ${per.map((x) => `${signed(x.gap)} ${x.unit} over max(baseline, placebo) on ${x.family} (margin ${fmt(x.margin)})`).join("; ")}; 1 family-run per arm per family` };
}

function flipStatus(text: string, to: SkillStatus): string {
  return text.replace(/^status:\s*\S+$/m, `status: ${to}`);
}

/** Moves skills/shadow/<id>/ to skills/graduated/<id>/ with status graduated; returns the SKILL.md path. */
export function graduateSkill(skillsDir: string, id: string): string {
  const from = join(skillsDir, "shadow", id), to = join(skillsDir, "graduated", id);
  mkdirSync(join(skillsDir, "graduated"), { recursive: true });
  renameSync(from, to);
  const p = join(to, "SKILL.md");
  writeFileSync(p, flipStatus(readFileSync(p, "utf8"), "graduated"));
  return p;
}

/** Moves skills/<was>/<id>/SKILL.md into skills/tombstones/<id>.md under a §6.10 frontmatter; returns its path. */
export function tombstoneSkill(skillsDir: string, id: string, t: Omit<TombstoneFrontmatter, "id">): string {
  const from = join(skillsDir, t.was, id);
  const skill = existsSync(join(from, "SKILL.md")) ? readFileSync(join(from, "SKILL.md"), "utf8") : "";
  mkdirSync(join(skillsDir, "tombstones"), { recursive: true });
  const p = join(skillsDir, "tombstones", `${id}.md`);
  writeFileSync(p, [
    "---", `id: ${id}`, `was: ${t.was}`, `verdict: ${t.verdict}`, `reason: ${JSON.stringify(t.reason)}`, `successor: ${t.successor ?? "null"}`, "---", "",
    flipStatus(skill, "tombstoned"),
  ].join("\n"));
  rmSync(from, { recursive: true, force: true }); // its bytes are in the tombstone above
  return p;
}
