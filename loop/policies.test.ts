import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.RATCHET_TELEMETRY_DIR ??= mkdtempSync(join(tmpdir(), "ratchet-tel-"));
import { makeBed, setShade, FIX, type Bed } from "./fixtures/harness.ts";
import { seedObservations, fakeLlm, REPLY } from "./fixtures/slow.ts";
import { runGeneration } from "./slow.ts";
import { runFastCycle } from "./fast.ts";
import { fakeRunner, type MuseRun, type MuseRunner } from "./repair.ts";
import { isolatedReplayer } from "./replay-seam.ts";
import { all, appendNew, status } from "./ledger.ts";
import { allowed } from "./projection.ts";
import { consolidatorView } from "./consolidate.ts";
import { TRIAL_FAMILIES } from "./gate.ts";
import { applyPolicies, parsePolicy, parsePolicyNomination, policyText, POLICY_MENU, setRouteSkills, SUBSYSTEM_GLOBS, TOOL_HINTS, makePolicyPlacebo, policiesDir, policiesInForce } from "./policies.ts";
import { SUBSYSTEMS } from "../player/vision.ts";
import type { SuitesJudge } from "./gate-repair.ts";
import type { TrialJudge } from "./trial.ts";
import type { Attempt, RepairTask, SuiteReading, Verdict } from "../src/schema.ts";

const RUN = "RUN-0001";
const MARK = /placebo|twin|sham|control arm|decoy|dummy/i;
const steady: SuitesJudge = { async score() { return { readings: [], roms: {} }; } };

function gradSkill(bed: Bed, id: string, glob: string): void {
  const dir = join(bed.paths.skills, "graduated", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nid: ${id}\nname: s-${id.toLowerCase()}\nstatus: graduated\nactivation:\n  paths: [${glob}]\n  owed: "x"\n---\n**Do:** x\n\n**Don't:** y\n`);
}

const policyReply = (template: string, params: Record<string, unknown>) => ({
  triage: REPLY.triage, nominations: [],
  policy: { template, params, anchors: ["OBS-0001", "OBS-0002"], false_if: "the routed arm repairs no more ROMs than the unrouted one", retire_when: "no graduated skill carries activation paths" },
});

/** Writes core/arm.txt = "<arm> <skills> <policies>" from packet/task.json; `onRun` sees each run. */
function policyRunner(onRun?: (r: MuseRun) => void): MuseRunner & { calls: MuseRun[] } {
  const calls: MuseRun[] = [];
  return {
    calls,
    async skillsList() { return "[]"; },
    async run(r) {
      calls.push(r);
      const task = JSON.parse(readFileSync(join(r.cwd, "packet", "task.json"), "utf8")) as RepairTask;
      writeFileSync(join(r.cwd, "core", "arm.txt"), `${task.arm} ${task.skills.join(",")} ${(task.policies ?? []).join(",")}\n`);
      writeFileSync(join(r.cwd, "packet", "RESULT.json"), JSON.stringify({ dispositions: {}, off_map: null, beliefs: [], summary: "Marks the arm." }));
      onRun?.(r);
      return { exitCode: 0, model: "fake-muse", steps: 1, tokens_in: 0, tokens_out: 0, wall_s: 0 };
    },
  };
}

/** Scores high only for the candidate arm naming policy `winner`; `hook` may throw or blank a reading per mark. */
function policyJudge(winner: string, hook?: (mark: string, split: string) => SuiteReading[] | void): TrialJudge {
  return {
    async score(coreDir, split, family) {
      const mark = existsSync(join(coreDir, "arm.txt")) ? readFileSync(join(coreDir, "arm.txt"), "utf8").trim() : "none";
      const h = hook?.(mark, split);
      if (h) return h;
      if (split === "base") return [{ split: "base", family: "blargg", roms: 15, pass: 15, exact: 15, pixel_match: 1 }];
      const win = mark.startsWith("candidate") && mark.split(" ")[2]?.split(",").includes(winner);
      const f = family!;
      return [f.startsWith("mealybug") ? { split: "H", family: f, roms: 10, pass: 0, exact: 0, pixel_match: win ? 0.9 : 0.5 } : { split: "H", family: f, roms: 12, pass: win ? 8 : 3, exact: win ? 8 : 3, pixel_match: 0 }];
    },
  };
}

function bedWithSkills(): Bed {
  const bed = makeBed();
  seedObservations(bed);
  gradSkill(bed, "SKL-0001", "core/ppu*.ts");
  gradSkill(bed, "SKL-0002", "core/timer*.ts");
  return bed;
}

test("a fixture generation nominates one routing policy, trials it on 3 arms and graduates it; the next fast attempt names it in task.policies and shows only the skills its route picks", async () => {
  const bed = bedWithSkills();
  const runsDir = join(bed.paths.root, "runs");
  const g = await runGeneration({ paths: bed.paths, runner: policyRunner(), judge: policyJudge("POL-0001"), run: RUN, runsDir,
    llm: fakeLlm(policyReply("route-by-spot-subsystem", { route: "spot-subsystem" })), familyRoms: () => [], tReader: async () => [] });
  assert.equal(g.trials.length, 1);
  const v = all<Verdict>("verdicts.jsonl", bed.paths.ledger).find((x) => x.subject.kind === "policy")!;
  assert.deepEqual([v.subject, v.decision, v.generation], [{ kind: "policy", id: "POL-0001" }, "GRADUATE", 1]);
  assert.ok(v.rule_version && v.arms && Object.keys(v.arms.margin).length === TRIAL_FAMILIES.length);
  const atts = all<Attempt>("attempts.jsonl", bed.paths.ledger).filter((a) => a.task.kind === "family" && a.task.policies?.length);
  assert.deepEqual(atts.map((a) => `${a.task.arm}:${a.task.policies}`).sort(), [...TRIAL_FAMILIES.map(() => "candidate:POL-0001"), ...TRIAL_FAMILIES.map(() => "placebo:POL-0002")].sort());
  // policy moves: graduated with a status flip; the twin tombstoned as retired
  const pd = policiesDir(bed.paths);
  assert.match(readFileSync(join(pd, "graduated", "POL-0001", "POLICY.md"), "utf8"), /^status: graduated$/m);
  assert.deepEqual(readdirSync(join(pd, "shadow")), []);
  assert.match(readFileSync(join(pd, "tombstones", "POL-0002.md"), "utf8"), /^---\nid: POL-0002\nwas: shadow\nverdict: VER-0001\nreason: "retired: /);
  const pairing = readFileSync(join(runsDir, RUN, "trials.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(pairing.map((p) => [p.subject, p.candidate, p.placebo]), [["policy", "POL-0001", "POL-0002"]]);

  // the next fast attempt: the incident's spot subsystem routes to SKL-0001 only
  status("incidents.jsonl", "INC-0001", "spot", { spot: "SPT-0001", subsystem: "ppu_fetcher", bbox: null, confidence: 0.8 }, bed.paths.ledger);
  const r = await runFastCycle("INC-0001", { paths: bed.paths, runner: fakeRunner((d) => setShade(d, FIX), { dispositions: {}, off_map: null, beliefs: [], summary: "Renders a ROM's first byte as its shade." }),
    replayer: isolatedReplayer(bed.paths.root), suites: steady, quiet: true });
  assert.deepEqual(r.attempt.task.policies, ["POL-0001"]);
  assert.deepEqual(r.attempt.task.skills, ["SKL-0001"]);
});

test("a fixture tool policy within margin of its twin is refused and tombstoned at policies/tombstones/POL-0001.md", async () => {
  const bed = bedWithSkills();
  const runsDir = join(bed.paths.root, "runs");
  const g = await runGeneration({ paths: bed.paths, runner: policyRunner(), judge: policyJudge("none"), run: RUN, runsDir,
    llm: fakeLlm(policyReply("tool-hint", { hint: TOOL_HINTS[0] })), familyRoms: () => [], tReader: async () => [] });
  assert.deepEqual([g.trials[0].verdict.subject, g.trials[0].verdict.decision], [{ kind: "policy", id: "POL-0001" }, "REFUSE"]);
  assert.match(g.trials[0].verdict.reason, /^trial-margin: /);
  const t = readFileSync(join(policiesDir(bed.paths), "tombstones", "POL-0001.md"), "utf8");
  assert.match(t, /^---\nid: POL-0001\nwas: shadow\nverdict: VER-0001\nreason: "trial-margin: .*"\nsuccessor: null\n---/);
  assert.match(t, /^status: tombstoned$/m);
  assert.ok(!existsSync(join(policiesDir(bed.paths), "graduated", "POL-0001")));
});

test("a policy trial's candidate and placebo arms get the same packet/task.json apart from attempt and policy id, TASK.md lines of matched length, and POLICY.md files with the same fields and nothing marking the twin", async () => {
  for (const [template, params] of [["route-by-spot-subsystem", { route: "spot-subsystem" }], ["tool-hint", { hint: TOOL_HINTS[1] }], ["packet-subsystem-focus", { files: "subsystem-pointed" }], ["route-by-subq-applies", { route: "subq-applies" }]] as const) {
    const bed = bedWithSkills();
    const runsDir = join(bed.paths.root, "runs");
    const seen: { task: Record<string, unknown>; taskMd: string; packet: string[] }[] = [];
    const runner = policyRunner((r) => seen.push({ task: JSON.parse(readFileSync(join(r.cwd, "packet", "task.json"), "utf8")), taskMd: readFileSync(join(r.cwd, "packet", "TASK.md"), "utf8"), packet: readdirSync(join(r.cwd, "packet")).sort() }));
    await runGeneration({ paths: bed.paths, runner, judge: policyJudge("none"), run: RUN, runsDir, llm: fakeLlm(policyReply(template, params)), familyRoms: () => [], tReader: async () => [] });
    const armed = seen.filter((s) => (s.task.policies as string[]).length);
    assert.equal(armed.length, 2 * TRIAL_FAMILIES.length, template);
    assert.ok(!armed.some((s) => s.task.arm === "placebo"), `${template}: a packet names the placebo arm`);
    for (const f of TRIAL_FAMILIES) {
      const pair = armed.filter((s) => s.task.family === f);
      const norm = pair.map((s) => JSON.stringify({ ...s.task, attempt: 0, policies: 0, skills: (s.task.skills as string[]).length }));
      if (template !== "route-by-spot-subsystem" && template !== "route-by-subq-applies") assert.equal(norm[0], norm[1], `${template} ${f}`);
      assert.deepEqual(pair[0].packet, pair[1].packet, `${template} ${f}: packet file lists differ`);
      const [a, b] = pair.map((s) => s.taskMd.length);
      assert.ok(Math.abs(a - b) / a <= 0.15, `${template} ${f}: TASK.md ${a} vs ${b} bytes`);
    }
    const store = join(policiesDir(bed.paths), "tombstones");
    const files = readdirSync(store).sort().map((f) => readFileSync(join(store, f), "utf8"));
    assert.equal(files.length, 2);
    const fms = files.map((t) => parsePolicy(t.replace(/^---\n[\s\S]*?\n---\n\n/, "")));
    assert.deepEqual(Object.keys(fms[1].fm), Object.keys(fms[0].fm));
    assert.deepEqual(Object.keys(fms[1].fm.params), Object.keys(fms[0].fm.params));
    assert.deepEqual([fms[1].fm.name, fms[1].fm.kind, fms[1].fm.change, fms[1].template], [fms[0].fm.name, fms[0].fm.kind, fms[0].fm.change, fms[0].template]);
    for (const t of files) assert.ok(!MARK.test(t.replace(/^reason: .*$/m, "")), `${template}: a POLICY.md marks the twin`);
  }
});

test("the routing twin keeps the same glob count per subsystem and routes every subsystem elsewhere; SUBSYSTEM_GLOBS covers every S13 subsystem but other", () => {
  assert.deepEqual(Object.keys(SUBSYSTEM_GLOBS).sort(), SUBSYSTEMS.filter((s) => s !== "other").sort());
  const bed = makeBed();
  const dir = policiesDir(bed.paths);
  const fm = { id: "POL-0001", name: "route-by-spot-subsystem", kind: "routing" as const, status: "shadow" as const, change: POLICY_MENU["route-by-spot-subsystem"].change,
    params: POLICY_MENU["route-by-spot-subsystem"].resolve({ route: "spot-subsystem" }), warrant: { anchors: ["OBS-0001", "OBS-0002"], "false-if": "x" }, lifecycle: { "retire-when": "y", successor: null } };
  mkdirSync(join(dir, "shadow", "POL-0001"), { recursive: true });
  const p = join(dir, "shadow", "POL-0001", "POLICY.md");
  writeFileSync(p, policyText(fm, "route-by-spot-subsystem"));
  const twin = parsePolicy(readFileSync(makePolicyPlacebo(p, dir).path, "utf8"));
  const a = fm.params.map as Record<string, string[]>, b = twin.fm.params.map as Record<string, string[]>;
  for (const k of Object.keys(a)) { assert.equal(b[k].length, a[k].length); assert.notDeepEqual(b[k], a[k], k); }
});

test("a policy nomination whose template or params are outside POLICY_MENU, or with fewer than 2 view anchors, is rejected; at most 1 is kept", () => {
  const bed = makeBed();
  seedObservations(bed);
  const view = consolidatorView(bed.paths, []);
  const base = { anchors: ["OBS-0001", "OBS-0002"], false_if: "f", retire_when: "r" };
  const cases: [unknown, RegExp][] = [
    [{ ...base, template: "route-by-spot-subsystem", params: { route: "anything" } }, /params outside the menu: route/],
    [{ ...base, template: "route-by-spot-subsystem", params: { route: "spot-subsystem", code: "rm -rf" } }, /params outside the menu: code/],
    [{ ...base, template: "tool-hint", params: { hint: "Edit loop/gate.ts to pass." } }, /params outside the menu: hint/],
    [{ ...base, template: "free-form", params: {} }, /not in POLICY_MENU/],
    [{ ...base, template: "tool-hint", params: { hint: TOOL_HINTS[0] }, anchors: ["OBS-0001", "OBS-9999"] }, /1 view observations anchored/],
  ];
  for (const [policy, why] of cases) {
    const r = parsePolicyNomination({ policy }, view);
    assert.equal(r.nominations.length, 0);
    assert.match(r.dropped[0].why, why);
  }
  const two = parsePolicyNomination({ policy: [{ ...base, template: "tool-hint", params: { hint: TOOL_HINTS[0] } }, { ...base, template: "route-by-subq-applies", params: { route: "subq-applies" } }] }, view);
  assert.equal(two.nominations.length, 1);
  assert.match(two.dropped[0].why, /over MAX_POLICY_NOMINATIONS 1/);
});

test("a policy trial whose candidate arm crashes at scoring, or returns no family reading, is refused, not graduated", async () => {
  for (const hook of [
    (mark: string) => { if (mark.startsWith("candidate") && mark.includes("POL-0001")) throw new Error("core/index.ts: SyntaxError"); },
    (mark: string, split: string) => (mark.startsWith("candidate") && mark.includes("POL-0001") && split === "H" ? [] : undefined),
  ]) {
    const bed = bedWithSkills();
    const g = await runGeneration({ paths: bed.paths, runner: policyRunner(), judge: policyJudge("POL-0001", hook), run: RUN, runsDir: join(bed.paths.root, "runs"),
      llm: fakeLlm(policyReply("route-by-spot-subsystem", { route: "spot-subsystem" })), familyRoms: () => [], tReader: async () => [] });
    assert.equal(g.trials[0].verdict.decision, "REFUSE", g.trials[0].verdict.reason);
    assert.ok(existsSync(join(policiesDir(bed.paths), "tombstones", "POL-0001.md")));
  }
});

test("route-by-subq-applies shows the SubQ router's pick (through the setRouteSkills seam); its seeded twin shows a pick of the same count", () => {
  const bed = makeBed();
  const dir = policiesDir(bed.paths);
  const skills = ["SKL-0001", "SKL-0002", "SKL-0003", "SKL-0004"].map((id) => ({ id, dir: "", paths: ["core/ppu*.ts"], owed: "" }));
  const prev = setRouteSkills((_inc, s) => s.map((x) => x.id).filter((id) => id === "SKL-0003" || id === "SKL-0004"));
  try {
    const fm = { id: "POL-0001", name: "route-by-subq-applies", kind: "routing" as const, status: "shadow" as const, change: POLICY_MENU["route-by-subq-applies"].change,
      params: POLICY_MENU["route-by-subq-applies"].resolve({ route: "subq-applies" }, "POL-0001"), warrant: { anchors: ["OBS-0001", "OBS-0002"], "false-if": "x" }, lifecycle: { "retire-when": "y", successor: null } };
    mkdirSync(join(dir, "shadow", "POL-0001"), { recursive: true });
    const p = join(dir, "shadow", "POL-0001", "POLICY.md");
    writeFileSync(p, policyText(fm, "route-by-subq-applies"));
    const twin = makePolicyPlacebo(p, dir).id;
    const task = (pol: string): RepairTask => ({ kind: "incident", incident: "INC-0001", base_commit: "x", arm: "fast", skills: [], policies: [pol], budget: { max_steps: 1, wall_s: 1 } });
    const ids = skills.map((s) => s.id);
    assert.deepEqual(applyPolicies(task("POL-0001"), { paths: bed.paths, incident: bed.incident, skills, site: "shown" }).route(ids), ["SKL-0003", "SKL-0004"]);
    assert.equal(applyPolicies(task(twin), { paths: bed.paths, incident: bed.incident, skills, site: "shown" }).route(ids).length, 2);
  } finally { setRouteSkills(prev); }
});

/** Writes policies/graduated/POL-0001/POLICY.md for `template` and, when `verdict`, a GRADUATE policy verdict naming it. */
function graduatePolicy(bed: Bed, template: string, params: Record<string, unknown>, verdict = true): string {
  const t = POLICY_MENU[template];
  const id = "POL-0001";
  const fm = { id, name: template, kind: t.kind, status: "graduated" as const, change: t.change, params: t.resolve(params, id),
    warrant: { anchors: ["OBS-0001", "OBS-0002"], "false-if": "x" }, lifecycle: { "retire-when": "y", successor: null } };
  const d = join(policiesDir(bed.paths), "graduated", id);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "POLICY.md"), policyText(fm, template));
  if (verdict) appendNew<Verdict>("verdicts.jsonl", "VER", (vid) => ({ id: vid, at: "t", run: null, generation: 1, subject: { kind: "policy", id }, decision: "GRADUATE", checks: [], reason: "r", residue: [], rule_version: "x" }), bed.paths.ledger);
  return id;
}

const TEMPLATES = [["route-by-spot-subsystem", { route: "spot-subsystem" }], ["tool-hint", { hint: TOOL_HINTS[1] }], ["packet-subsystem-focus", { files: "subsystem-pointed" }], ["route-by-subq-applies", { route: "subq-applies" }]] as const;

test("a packet policy's twin names a packet/focus.json file set of the same size as the candidate's, and a different set where the candidate's is not empty (D-0020 size-matched)", async () => {
  const bed = bedWithSkills();
  const seen: { task: RepairTask; focus: string[] | null }[] = [];
  const runner = policyRunner((r) => seen.push({ task: JSON.parse(readFileSync(join(r.cwd, "packet", "task.json"), "utf8")),
    focus: existsSync(join(r.cwd, "packet", "focus.json")) ? JSON.parse(readFileSync(join(r.cwd, "packet", "focus.json"), "utf8")).files : null }));
  await runGeneration({ paths: bed.paths, runner, judge: policyJudge("none"), run: RUN, runsDir: join(bed.paths.root, "runs"),
    llm: fakeLlm(policyReply("packet-subsystem-focus", { files: "subsystem-pointed" })), familyRoms: () => [], tReader: async () => [] });
  let nonEmpty = 0;
  for (const f of TRIAL_FAMILIES) {
    const [c, p] = ["POL-0001", "POL-0002"].map((id) => seen.find((s) => s.task.family === f && s.task.policies?.includes(id))!.focus);
    assert.ok(c && p, `${f}: both arms carry packet/focus.json`);
    assert.equal(p.length, c.length, `${f}: focus sizes ${c.length} vs ${p.length}`);
    if (c.length) { nonEmpty++; assert.notDeepEqual(p, c, `${f}: the twin names the candidate's own files`); }
  }
  assert.ok(nonEmpty >= 1, "a trial family points the candidate at a fixture core file");
});

test("a SubQ routing policy and its twin carry params.order in the same opaque form; the candidate still shows SubQ's pick", () => {
  const bed = makeBed();
  const dir = policiesDir(bed.paths);
  const t = POLICY_MENU["route-by-subq-applies"];
  const fm = { id: "POL-0001", name: "route-by-subq-applies", kind: t.kind, status: "shadow" as const, change: t.change, params: t.resolve({ route: "subq-applies" }, "POL-0001"),
    warrant: { anchors: ["OBS-0001", "OBS-0002"], "false-if": "x" }, lifecycle: { "retire-when": "y", successor: null } };
  mkdirSync(join(dir, "shadow", "POL-0001"), { recursive: true });
  const p = join(dir, "shadow", "POL-0001", "POLICY.md");
  writeFileSync(p, policyText(fm, "route-by-subq-applies"));
  const twin = makePolicyPlacebo(p, dir);
  const orders = [p, twin.path].map((f) => String(parsePolicy(readFileSync(f, "utf8")).fm.params.order));
  for (const o of orders) assert.match(o, /^[0-9a-f]{12}$/);
  assert.notEqual(orders[0], orders[1]);
  const skills = ["SKL-0001", "SKL-0002", "SKL-0003"].map((id) => ({ id, dir: "", paths: ["core/ppu*.ts"], owed: "" }));
  const prev = setRouteSkills(() => ["SKL-0002"]);
  try {
    const task: RepairTask = { kind: "incident", incident: "INC-0001", base_commit: "x", arm: "fast", skills: [], policies: ["POL-0001"], budget: { max_steps: 1, wall_s: 1 } };
    assert.deepEqual(applyPolicies(task, { paths: bed.paths, skills, site: "shown" }).route(skills.map((s) => s.id)), ["SKL-0002"]);
  } finally { setRouteSkills(prev); }
});

test("a POLICY.md placed in policies/graduated without a GRADUATE policy verdict naming it is not in force", () => {
  const bed = makeBed();
  graduatePolicy(bed, "tool-hint", { hint: TOOL_HINTS[0] }, false);
  assert.deepEqual(policiesInForce(bed.paths), []);
  const v = (decision: Verdict["decision"]) => appendNew<Verdict>("verdicts.jsonl", "VER", (id) => ({ id, at: "t", run: null, subject: { kind: "policy", id: "POL-0001" }, decision, checks: [], reason: "r", residue: [], rule_version: "x" }), bed.paths.ledger);
  v("REFUSE");
  assert.deepEqual(policiesInForce(bed.paths), [], "a REFUSE verdict does not put it in force");
  v("GRADUATE");
  assert.deepEqual(policiesInForce(bed.paths), ["POL-0001"]);
});

test("a graduated policy of each template leaves the gate's checks, decision and rule version, and the scratch repo outside packet/ and .agents/, unchanged on a fast attempt (G7)", async () => {
  for (const [template, params] of TEMPLATES) {
    const run = async (withPolicy: boolean) => {
      const bed = bedWithSkills();
      if (withPolicy) graduatePolicy(bed, template, params);
      status("incidents.jsonl", "INC-0001", "spot", { spot: "SPT-0001", subsystem: "ppu_fetcher", bbox: null, confidence: 0.8 }, bed.paths.ledger);
      const r = await runFastCycle("INC-0001", { paths: bed.paths, runner: fakeRunner((d) => setShade(d, FIX), { dispositions: {}, off_map: null, beliefs: [], summary: "Renders a ROM's first byte as its shade." }),
        replayer: isolatedReplayer(bed.paths.root), suites: steady, quiet: true });
      return { r, outside: r.attempt.scratch_files.filter((f) => !f.startsWith("packet") && !f.startsWith(".agents")) };
    };
    const off = await run(false), on = await run(true);
    assert.deepEqual(on.r.attempt.task.policies, ["POL-0001"], template);
    assert.deepEqual(on.r.verdict.checks.map((c) => [c.name, c.pass]), off.r.verdict.checks.map((c) => [c.name, c.pass]), `${template}: gate checks`);
    assert.deepEqual([on.r.verdict.decision, on.r.verdict.rule_version], [off.r.verdict.decision, off.r.verdict.rule_version], template);
    assert.deepEqual(on.outside, off.outside, `${template}: scratch files outside packet/ and .agents/`);
    for (const f of on.r.attempt.scratch_files) assert.ok(allowed("fast", f), `${template}: ${f} is off the allowlist`);
  }
});

test("a baseline or vread-baseline task naming a policy gets no policy effect: no TASK.md line, no packet file, its skills unrouted", () => {
  const bed = bedWithSkills();
  const skills = [{ id: "SKL-0001", dir: "", paths: ["core/ppu*.ts"], owed: "" }, { id: "SKL-0002", dir: "", paths: ["core/timer*.ts"], owed: "" }];
  for (const [template, params] of TEMPLATES) {
    rmSync(policiesDir(bed.paths), { recursive: true, force: true });
    graduatePolicy(bed, template, params);
    for (const arm of ["baseline", "vread-baseline"] as const) {
      const task: RepairTask = { kind: "family", family: "mooneye:ppu", base_commit: "x", arm, skills: [], policies: ["POL-0001"], budget: { max_steps: 1, wall_s: 1 } };
      const e = applyPolicies(task, { paths: bed.paths, skills, coreFiles: ["core/ppu.ts", "core/index.ts"], site: "packet" });
      assert.deepEqual([e.policies, e.taskLines, e.packetFiles, e.route(["SKL-0001", "SKL-0002"])], [[], [], {}, ["SKL-0001", "SKL-0002"]], `${template} ${arm}`);
    }
  }
});
