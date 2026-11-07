import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, cpSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { readHistory, parseFindings, frontmatter } from "./history.ts";
import type { History } from "./history.ts";
import { createServer } from "./index.ts";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fx = join(root, "ui", "fixtures");
const tmp = mkdtempSync(join(tmpdir(), "ratchet-history-"));

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
});

// A temp live clone on core-live: a seed commit, then one gate merge carrying Attempt and Skills trailers.
const live = join(tmp, "live");
mkdirSync(live);
git(live, "init", "-q", "-b", "core-live");
writeFileSync(join(live, "a.txt"), "a");
git(live, "add", "a.txt");
git(live, "commit", "-q", "-m", "seed core-live from main");
writeFileSync(join(live, "a.txt"), "b");
git(live, "commit", "-q", "-am", "gate: graduate ATT-0002\n\nAttempt: ATT-0002\nSkills: SKL-0002, SKL-0005");

// Registers and skills in temp dirs: one decision, a findings table, a graduated skill and a tombstone with a successor.
const reg = join(tmp, "reg");
mkdirSync(join(reg, "decisions"), { recursive: true });
writeFileSync(join(reg, "decisions", "D-0001-x.md"), "---\nid: D-0001\ntitle: A title\nstatus: admitted\nsupersedes: null\n---\n**Decision:** x.\n");
writeFileSync(join(reg, "findings.md"), "# F\n\n| Id | Slice | Claim or property | Reading | Disposition |\n|---|---|---|---|---|\n| S2-F1 | S2 | a claim | a reading | fix: abc |\n");
const skills = join(tmp, "skills");
mkdirSync(join(skills, "graduated", "SKL-0002"), { recursive: true });
writeFileSync(join(skills, "graduated", "SKL-0002", "SKILL.md"), "---\nid: SKL-0002\nname: restart-fetcher\nstatus: graduated   # shadow | graduated\nlifecycle:\n  consumer: repairer\n  successor: null\n---\n**Do:** x\n");
mkdirSync(join(skills, "tombstones"));
writeFileSync(join(skills, "tombstones", "SKL-0001.md"), "---\nid: SKL-0001\nwas: shadow\nverdict: VER-0003\nreason: \"placebo within margin\"\nsuccessor: SKL-0002\n---\n");

const opts = (ledger: string, runs = join(tmp, "no-runs")) => ({ ledger, runs, skills, live, registers: reg, root });
const fixtureMtimes = () => readdirSync(join(fx, "ledger")).map((f) => [f, statSync(join(fx, "ledger", f)).mtimeMs]);
const before = fixtureMtimes();

test("readHistory over the fixture ledger folds status records and carries every fixture verdict, with no V read and no figure for run-null records", async () => {
  const h = await readHistory(opts(join(fx, "ledger")));
  assert.deepEqual(h.verdicts.map((v) => v.id), ["VER-0001", "VER-0002", "VER-0003"]);
  assert.equal(h.incidents.find((i) => i.id === "INC-0001")!.status, "repaired");
  assert.equal(h.attempts.length, 2);
  assert.equal(h.fires.length, 1);
  assert.equal(h.curve.length, 1, "the skill verdict with arms is one generation");
  assert.equal(h.vread, null);
  assert.deepEqual(h.figures, [], "every fixture record carries run: null, so no run figure is computed");
  assert.equal(h.spend!.attempts_n, 2);
  assert.deepEqual(fixtureMtimes(), before, "readHistory writes no ledger file");
});

test("readHistory reads core-live's log with Attempt and Skills trailers, skills with tombstone successors, decisions and findings rows", async () => {
  const h = await readHistory(opts(join(fx, "ledger")));
  assert.equal(h.commits!.length, 2);
  assert.deepEqual(h.commits![0].attempts, ["ATT-0002"]);
  assert.deepEqual(h.commits![0].skills, ["SKL-0002", "SKL-0005"]);
  assert.deepEqual(h.commits![1].attempts, [], "the seed commit has no trailer");
  assert.equal(h.commits![0].subject, "gate: graduate ATT-0002");
  const tomb = h.skills.find((s) => s.id === "SKL-0001")!;
  assert.equal(tomb.status, "tombstoned");
  assert.equal(tomb.successor, "SKL-0002");
  assert.equal(tomb.verdict, "VER-0003");
  assert.equal(h.skills.find((s) => s.id === "SKL-0002")!.status, "graduated", "a trailing YAML comment is stripped");
  assert.deepEqual(h.decisions.map((d) => [d.id, d.title, d.status]), [["D-0001", "A title", "admitted"]]);
  assert.deepEqual(h.findings.map((f) => f.id), ["S2-F1"]);
});

test("readHistory with no live clone returns commits null, and an empty ledger returns empty lists and null spend", async () => {
  const empty = join(tmp, "empty-ledger");
  mkdirSync(empty);
  const h = await readHistory({ ...opts(empty), live: join(tmp, "nowhere") });
  assert.equal(h.commits, null);
  assert.equal(h.spend, null);
  assert.deepEqual([h.incidents, h.attempts, h.verdicts, h.curve, h.figures], [[], [], [], [], []]);
});

test("a sabotage incident and the attempt and verdict tracing to it are marked and excluded from run figures; vread appears once vread.json exists", async () => {
  const led = join(tmp, "run-ledger");
  cpSync(join(fx, "ledger"), led, { recursive: true });
  const rec = ({ file, ...o }: { file: string } & Record<string, unknown>) => appendFileSync(join(led, file), JSON.stringify(o) + "\n");
  rec({ file: "incidents.jsonl", id: "INC-0009", run: "RUN-0001", source: "sabotage", status: "open", files: { dir: "evidence/incidents/INC-0009" } });
  rec({ file: "incidents.jsonl", id: "INC-0010", run: "RUN-0001", source: "play", status: "open", files: { dir: "evidence/incidents/INC-0010" } });
  rec({ file: "attempts.jsonl", id: "ATT-0009", run: "RUN-0001", task: { kind: "incident", incident: "INC-0009", arm: "fast", skills: [] }, spent: { usd: 1 } });
  rec({ file: "verdicts.jsonl", id: "VER-0009", run: "RUN-0001", subject: { kind: "attempt", id: "ATT-0009" }, decision: "GRADUATE", checks: [], reason: "r", residue: [], rule_version: "x" });
  const runs = join(tmp, "runs");
  const before = await readHistory(opts(led, runs));
  assert.equal(before.vread, null);
  assert.equal(before.incidents.find((i) => i.id === "INC-0009")!.sabotage, true);
  assert.equal(before.verdicts.find((v) => v.id === "VER-0009")!.sabotage, true);
  assert.deepEqual(before.figures, [{ run: "RUN-0001", incidents: 1, repaired: 0, repaired_by_graduate: 0, attempts: 0, graduated: 0, refused: 0, skills_graduated: 0, skills_refused: 0, policies_graduated: 0, policies_refused: 0, fires: 0 }]);
  mkdirSync(join(runs, "RUN-0001"), { recursive: true });
  writeFileSync(join(runs, "RUN-0001", "vread.json"), JSON.stringify({ run: "RUN-0001", arms: { baseline: [], ratchet: [] }, n_family_runs_per_arm: 1, residue: [] }));
  assert.equal((await readHistory(opts(led, runs))).vread!.run, "RUN-0001");
});

test("an incident another graduate repaired (repaired_by) counts as repaired in the run figures and adds no attempt", async () => {
  const led = join(tmp, "repaired-ledger");
  mkdirSync(led);
  const rec = (file: string, o: Record<string, unknown>) => appendFileSync(join(led, file), JSON.stringify(o) + "\n");
  rec("incidents.jsonl", { id: "INC-0001", run: "RUN-0001", source: "play", status: "open", files: { dir: "evidence/incidents/INC-0001" } });
  rec("incidents.jsonl", { id: "INC-0003", run: "RUN-0001", source: "play", status: "open", files: { dir: "evidence/incidents/INC-0003" } });
  rec("attempts.jsonl", { id: "ATT-0001", run: "RUN-0001", task: { kind: "incident", incident: "INC-0001", arm: "fast", skills: [] }, spent: { usd: 1 } });
  rec("verdicts.jsonl", { id: "VER-0001", run: "RUN-0001", subject: { kind: "attempt", id: "ATT-0001" }, decision: "GRADUATE", checks: [], reason: "r", residue: [], rule_version: "x" });
  rec("incidents.jsonl", { t: "status", id: "INC-0001", field: "status", value: "repaired", at: "2026-11-07T14:40:00.000Z" });
  rec("incidents.jsonl", { t: "status", id: "INC-0003", field: "repaired_by", value: "VER-0001", at: "2026-11-07T14:40:01.000Z" });
  rec("incidents.jsonl", { t: "status", id: "INC-0003", field: "status", value: "repaired", at: "2026-11-07T14:40:01.000Z" });
  const f = (await readHistory(opts(led))).figures[0];
  assert.deepEqual([f.incidents, f.repaired, f.repaired_by_graduate, f.attempts, f.graduated], [2, 2, 1, 1, 1]);
});

test("readHistory lists policies beside skills, with graduated and tombstoned status, and counts policy verdicts per run apart from skill verdicts", async () => {
  const led = join(tmp, "policy-ledger");
  mkdirSync(led);
  const rec = (o: Record<string, unknown>) => appendFileSync(join(led, "verdicts.jsonl"), JSON.stringify(o) + "\n");
  rec({ id: "VER-0001", run: "RUN-0001", generation: 1, subject: { kind: "policy", id: "POL-0001" }, decision: "GRADUATE", checks: [], reason: "r", residue: [], rule_version: "x",
    arms: { candidate: [], baseline: [], placebo: [], margin: {}, n_family_runs_per_arm: 1 } });
  rec({ id: "VER-0002", run: "RUN-0001", generation: 2, subject: { kind: "policy", id: "POL-0003" }, decision: "REFUSE", checks: [], reason: "r", residue: [], rule_version: "x" });
  const pol = join(tmp, "policies");
  mkdirSync(join(pol, "graduated", "POL-0001"), { recursive: true });
  writeFileSync(join(pol, "graduated", "POL-0001", "POLICY.md"), "---\nid: POL-0001\nname: route-by-spot-subsystem\nkind: routing\nstatus: graduated\nlifecycle:\n  retire-when: \"r\"\n  successor: null\n---\n");
  mkdirSync(join(pol, "tombstones"));
  writeFileSync(join(pol, "tombstones", "POL-0003.md"), "---\nid: POL-0003\nwas: shadow\nverdict: VER-0002\nreason: \"trial-margin: x\"\nsuccessor: null\n---\n");
  const h = await readHistory({ ...opts(led), policies: pol });
  assert.deepEqual(h.policies.map((p) => [p.id, p.status, p.verdict ?? null]), [["POL-0001", "graduated", null], ["POL-0003", "tombstoned", "VER-0002"]]);
  assert.ok(!h.skills.some((s) => s.id.startsWith("POL-")), "policies are not mixed into skills");
  const f = h.figures[0];
  assert.deepEqual([f.policies_graduated, f.policies_refused, f.skills_graduated, f.skills_refused], [1, 1, 0, 0]);
  assert.deepEqual(h.curve.map((e) => e.t === "curve" && e.generation), [1], "a policy verdict with trial arms is a point on the generation curve");
});

test("parseFindings skips header and rule rows; frontmatter unquotes values", () => {
  assert.deepEqual(parseFindings("| Id | a | b | c | d |\n|---|---|---|---|---|\n| X-1 | S | c | r | fix | more |\n").map((f) => [f.id, f.disposition]), [["X-1", "fix | more"]]);
  assert.equal(frontmatter("---\nreason: \"a: b\"\n---\nbody").fm.reason, "a: b");
});

test("GET /api/history serves the fixture ledger with the live clone named by RATCHET_LIVE", async () => {
  const prev = { ...process.env };
  Object.assign(process.env, { RATCHET_LIVE: live, RATCHET_SKILLS: skills, RATCHET_REGISTERS: reg });
  const { server } = createServer({ ledger: join(fx, "ledger"), runs: join(fx, "runs"), evidence: join(fx, "evidence"), game: join(root, "game"), cache: join(tmp, "cache") });
  await new Promise<void>((r) => server.listen(0, r));
  after(() => { server.closeAllConnections(); server.close(); process.env = prev; });
  const h = (await (await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/history`)).json()) as History;
  assert.equal(h.verdicts.length, 3);
  assert.deepEqual(h.commits![0].attempts, ["ATT-0002"]);
  assert.equal(h.vread, null);
});
