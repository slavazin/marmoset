import { test } from "node:test";
import assert from "node:assert/strict";
import { decideSkill, marginFor, unitValue } from "./gate-skill.ts";
import { MARGIN_FLOOR, TRIAL_FAMILIES } from "./gate.ts";
import type { SuiteReading } from "../src/schema.ts";

const mb = (pm: number): SuiteReading => ({ split: "H", family: "mealybug:window", roms: 10, pass: 0, exact: 0, pixel_match: pm });
const mo = (pass: number): SuiteReading => ({ split: "H", family: "mooneye:ppu", roms: 12, pass, exact: pass, pixel_match: 0 });
const base = [{ split: "base" as const, family: "blargg", roms: 15, pass: 15, exact: 15, pixel_match: 1 }];
const margin = { "mealybug:window": 1.0, "mooneye:ppu": 1 };
const armBase = { candidate: [base], baseline: [base], placebo: [base] };

test("units: Mealybug reads points of mean pixel match, Mooneye reads ROMs passed; margin is max(MARGIN_FLOOR, 2 × spread)", () => {
  assert.equal(unitValue(mb(0.875)), 87.5);
  assert.equal(unitValue(mo(4)), 4);
  const m = marginFor("mealybug:window", mb(0.80), mb(0.82));
  assert.ok(Math.abs(m.spread - 2) < 1e-9 && Math.abs(m.margin - 4) < 1e-9, JSON.stringify(m));
  assert.equal(marginFor("mooneye:ppu", mo(3), mo(3)).margin, MARGIN_FLOOR["mooneye:ppu"]);
});

test("decideSkill graduates only when candidate − max(baseline, placebo) >= margin on every trial family and no arm regresses base", () => {
  const g = decideSkill({ families: TRIAL_FAMILIES, readings: { candidate: [mb(0.9), mo(8)], baseline: [mb(0.5), mo(3)], placebo: [mb(0.6), mo(4)] }, margin, baseRef: base, armBase });
  assert.equal(g.decision, "GRADUATE");
  assert.match(g.reason, /\+30 pts .* mealybug:window/);
  const p = decideSkill({ families: TRIAL_FAMILIES, readings: { candidate: [mb(0.9), mo(4)], baseline: [mb(0.5), mo(3)], placebo: [mb(0.6), mo(4)] }, margin, baseRef: base, armBase });
  assert.equal(p.decision, "REFUSE");
  assert.match(p.reason, /^trial-margin: placebo within margin on mooneye:ppu/);
  const drop = [{ ...base[0], pass: 14 }];
  const r = decideSkill({ families: TRIAL_FAMILIES, readings: { candidate: [mb(0.9), mo(8)], baseline: [mb(0.5), mo(3)], placebo: [mb(0.6), mo(4)] }, margin, baseRef: base, armBase: { ...armBase, placebo: [drop] } });
  assert.equal(r.decision, "REFUSE");
  assert.match(r.reason, /^base-suites: the placebo arm drops blargg from 15 to 14/);
});

test("an arm whose base readings lack a base family the base commit scored regresses the base suites", () => {
  const r = decideSkill({ families: TRIAL_FAMILIES, readings: { candidate: [mb(0.9), mo(8)], baseline: [mb(0.5), mo(3)], placebo: [mb(0.6), mo(4)] }, margin, baseRef: base, armBase: { ...armBase, candidate: [[]] } });
  assert.equal(r.decision, "REFUSE");
  assert.match(r.reason, /^base-suites: the candidate arm drops blargg from 15 to no reading/);
});
