// GET /api/history (S14): the presentation UI's History tab, read entirely from files at request time (SPEC G9).
// `readHistory(opts)` returns the folded ledger (incidents, attempts, verdicts, fires, steers, observations count),
// the skills under skills/{shadow,graduated} and skills/tombstones, the policies (D-0020) the same way under policies/,
// the generation curve, the SubQ router's calibration (loop/route.ts routeCalibrationOf), the decisions under
// <registers>/decisions, the rows of <registers>/findings.md, the `core-live` commit log of the live clone with its
// `Attempt:` and `Skills:` trailers, spend, S13's spot summary when player/spot-score.ts exists, and the V read only
// once runs/RUN-*/vread.json exists. It writes nothing (AGENTS.md rule 2); server/history.test.ts asserts the reads.
// Sabotage incidents, and the attempts and verdicts that trace to them, carry `sabotage: true` and enter no figure (G2).
// A record with `run: null` was written before the run opened and enters no figure (SPEC §5 S10).

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parseJsonl, Fold, curveEvents, readVRead } from "./events.ts";
import { LIVE_BRANCH } from "../loop/paths.ts";
import { spendMeter, type SpendMeter } from "./spend.ts";
import { routeCalibrationOf, type RouteCalibration } from "../loop/route.ts";
import type { Attempt, Incident, Verdict, Fire, Steer, SpendRecord, UiEvent, VRead, SkillStatus } from "../src/schema.ts";

export interface HistoryOptions {
  ledger: string;
  runs: string;
  skills: string;
  /** policies/{shadow,graduated,tombstones} (loop/policies.ts policiesDir); defaults to policies/ beside `skills`. */
  policies?: string;
  /** The live clone (D-0006); its `core-live` log is read with git. */
  live: string;
  /** Directory holding decisions/ and findings.md: the repository's registers, which a fixture ledger does not carry. */
  registers: string;
  /** Repository root, for repo-relative paths in the response. */
  root: string;
  /** The selected run (server/runs.ts): narrows the meter, the muse-native rows and the V read to it; unset reads every run. */
  run?: string;
}

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const expandHome = (p: string) => (p.startsWith("~") ? join(process.env.HOME ?? "", p.slice(1)) : p);

/** Paths from RATCHET_LEDGER, RATCHET_RUNS, RATCHET_SKILLS, RATCHET_LIVE, RATCHET_REGISTERS (default ledger/). */
export function historyPathsFromEnv(env = process.env): HistoryOptions {
  return {
    ledger: resolve(ROOT, env.RATCHET_LEDGER ?? "ledger"),
    runs: resolve(ROOT, env.RATCHET_RUNS ?? "runs"),
    skills: resolve(ROOT, env.RATCHET_SKILLS ?? "skills"),
    policies: resolve(ROOT, env.RATCHET_POLICIES ?? "policies"),
    live: resolve(ROOT, expandHome(env.RATCHET_LIVE ?? "../ratchet-live")),
    registers: resolve(ROOT, env.RATCHET_REGISTERS ?? "ledger"),
    root: ROOT,
  };
}

export interface SkillItem {
  id: string; name: string; status: SkillStatus | string; path: string;
  successor: string | null; verdict?: string; reason?: string; was?: string;
}
export interface DecisionItem { id: string; title: string; status: string; supersedes: string | null; path: string; body: string }
export interface FindingItem { id: string; slice: string; claim: string; reading: string; disposition: string }
export interface CommitItem { sha: string; at: string; subject: string; attempts: string[]; skills: string[] }
export interface SpendSummary { attempts_usd: number; attempts_n: number; by_role: Record<string, { usd: number; n: number }>; total_usd: number }
/** repaired: incidents with status repaired; repaired_by_graduate: those repaired by another attempt's GRADUATE re-check (repaired_by), with no attempt of their own counted. */
export interface RunFigures { run: string; incidents: number; repaired: number; repaired_by_graduate: number; attempts: number; graduated: number; refused: number; skills_graduated: number; skills_refused: number; policies_graduated: number; policies_refused: number; fires: number }

/** One muse-native reading (loop/muse-native.ts NativeReading), as the History tab plots it beside the curve. */
export interface NativeRow { run: string; generation: number; family: string; base_commit: string; pixel_match: number; pass: number; roms: number; at: string; /** base_commit's first 12 characters */ base_short: string; /** pixel_match to 4 decimals */ pixel_match_text: string }

/** Every runs/RUN-*\/muse-native.jsonl line with a reading, in file order per run (server/history.test.ts "muse-native rows"). */
export function readNative(runsDir: string): NativeRow[] {
  if (!existsSync(runsDir) || !statSync(runsDir).isDirectory()) return [];
  const out: NativeRow[] = [];
  for (const run of readdirSync(runsDir).filter((d) => /^RUN-\d+$/.test(d)).sort()) {
    const f = join(runsDir, run, "muse-native.jsonl");
    if (!existsSync(f)) continue;
    for (const l of readFileSync(f, "utf8").split("\n")) {
      if (!l.trim()) continue;
      try {
        const r = JSON.parse(l) as { run?: string; generation?: number; family?: string; base_commit?: string; at?: string; reading?: { pixel_match?: number; pass?: number; roms?: number } };
        if (!r.reading || typeof r.generation !== "number") continue;
        const base_commit = String(r.base_commit ?? ""), pixel_match = Number(r.reading.pixel_match ?? 0);
        out.push({ run: r.run ?? run, generation: r.generation, family: String(r.family ?? ""), base_commit, pixel_match, pass: Number(r.reading.pass ?? 0), roms: Number(r.reading.roms ?? 0), at: String(r.at ?? ""), base_short: base_commit.slice(0, 12), pixel_match_text: pixel_match.toFixed(4) });
      } catch { /* partial line */ }
    }
  }
  return out;
}

export interface History {
  incidents: (Incident & { sabotage: boolean })[];
  attempts: (Attempt & { run?: string | null; sabotage: boolean })[];
  verdicts: (Verdict & { sabotage: boolean })[];
  fires: Fire[];
  steers: Steer[];
  observations: number;
  skills: SkillItem[];
  policies: SkillItem[];                   // POL ids under policies/, read as skills are
  curve: UiEvent[];
  decisions: DecisionItem[];
  findings: FindingItem[];
  commits: CommitItem[] | null;           // null: no live clone or no core-live branch at `live`
  commits_note: string;
  spend: SpendSummary | null;              // null: no attempt and no spend record
  meter: SpendMeter;                       // server/spend.ts: owner-read and priced, for RATCHET_RUN (default RUN-0001)
  spots: unknown | null;                   // S13's spotSummary(ledger), when player/spot-score.ts and ledger/spots.jsonl exist
  figures: RunFigures[];                   // per opened run; sabotage and run-null records excluded
  router: RouteCalibration | null;         // loop/route.ts routeCalibrationOf(ledger); null when no record carries a route or a forecast
  native: NativeRow[];                     // runs/<run>/muse-native.jsonl of every run (D-0013): beside the curve, in no figure
  vread: VRead | null;
  /** Every run in the registry (server/runs.ts runOverview), set by the /api/history route; absent from readHistory alone. */
  runs?: import("./runs.ts").RunOverview[];
  /** The run this response reads (server/runs.ts selectedRun), set by the /api/history route. */
  selected?: string;
}

function fold<T>(dir: string, file: string): T[] {
  const p = join(dir, file);
  if (!existsSync(p)) return [];
  const f = new Fold();
  for (const r of parseJsonl(readFileSync(p, "utf8") + "\n").records) f.apply(r);
  return f.all() as unknown as T[];
}

function rawLines<T>(dir: string, file: string): T[] {
  const p = join(dir, file);
  return existsSync(p) ? (parseJsonl(readFileSync(p, "utf8") + "\n").records as T[]) : [];
}

/** Top-level and nested `key: value` lines of a Markdown file's frontmatter; nested keys are flattened by last name. */
export function frontmatter(md: string): { fm: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(md);
  if (!m) return { fm: {}, body: md };
  const fm: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = /^\s*([\w-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].replace(/\s+#.*$/, "").trim();
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    if (!(kv[1] in fm) || v) fm[kv[1]] = v;
  }
  return { fm, body: m[2] };
}

const nul = (v: string | undefined) => (!v || v === "null" || v === "—" ? null : v);

/** SKILL.md (or, for policies/, POLICY.md) under <dir>/{shadow,graduated}, then <dir>/tombstones. */
function readSkills(skillsDir: string, root: string, file = "SKILL.md"): SkillItem[] {
  const out: SkillItem[] = [];
  for (const sub of ["shadow", "graduated"]) {
    const d = join(skillsDir, sub);
    if (!existsSync(d)) continue;
    for (const id of readdirSync(d).sort()) {
      const p = join(d, id, file);
      if (!existsSync(p)) continue;
      const { fm } = frontmatter(readFileSync(p, "utf8"));
      out.push({ id: fm.id ?? id, name: fm.name ?? "", status: fm.status ?? sub, path: relative(root, p), successor: nul(fm.successor) });
    }
  }
  const t = join(skillsDir, "tombstones");
  if (existsSync(t)) {
    for (const f of readdirSync(t).filter((x) => x.endsWith(".md")).sort()) {
      const p = join(t, f);
      const { fm } = frontmatter(readFileSync(p, "utf8"));
      const id = fm.id ?? f.replace(/\.md$/, "");
      const prior = out.find((s) => s.id === id);
      const item: SkillItem = { id, name: prior?.name ?? fm.name ?? "", status: "tombstoned", path: relative(root, p), successor: nul(fm.successor), verdict: fm.verdict, reason: fm.reason, was: fm.was };
      if (prior) Object.assign(prior, item); else out.push(item);
    }
  }
  return out;
}

function readDecisions(dir: string, root: string): DecisionItem[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => {
    const p = join(dir, f);
    const { fm, body } = frontmatter(readFileSync(p, "utf8"));
    return { id: fm.id ?? f.replace(/\.md$/, ""), title: fm.title ?? "", status: fm.status ?? "", supersedes: nul(fm.supersedes), path: relative(root, p), body: body.trim() };
  });
}

/** Rows of the findings register's table whose first cell is an id; header and rule rows are skipped. */
export function parseFindings(md: string): FindingItem[] {
  const out: FindingItem[] = [];
  for (const line of md.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 5 || /^-+$/.test(cells[0]) || cells[0] === "Id") continue;
    out.push({ id: cells[0], slice: cells[1], claim: cells[2], reading: cells[3], disposition: cells.slice(4).join(" | ") });
  }
  return out;
}

const SEP_FIELD = "\x1f";
const SEP_REC = "\x1e";

/** `git log core-live` in the live clone with Attempt and Skills trailers; null when the clone or branch is absent. */
export function readCommits(live: string): CommitItem[] | null {
  if (!existsSync(join(live, ".git")) && !existsSync(join(live, "HEAD"))) return null;
  const fmt = ["%H", "%cI", "%s", "%(trailers:key=Attempt,valueonly,separator=%x2C)", "%(trailers:key=Skills,valueonly,separator=%x2C)"].join("%x1f") + "%x1e";
  let out: string;
  try {
    out = execFileSync("git", ["-C", live, "log", LIVE_BRANCH, `--format=${fmt}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 << 20 });
  } catch { return null; }
  const list = (s: string) => s.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
  return out.split(SEP_REC).map((r) => r.replace(/^\n+/, "")).filter(Boolean).map((r) => {
    const [sha, at, subject, att, sk] = r.split(SEP_FIELD);
    return { sha, at, subject, attempts: list(att ?? ""), skills: list(sk ?? "") };
  });
}

async function readSpots(ledger: string, root: string): Promise<unknown | null> {
  const mod = join(root, "player", "spot-score.ts");
  if (!existsSync(mod) || !existsSync(join(ledger, "spots.jsonl"))) return null;
  try {
    const m = (await import(pathToFileURL(mod).href)) as { spotSummary?: (dir: string) => unknown };
    return typeof m.spotSummary === "function" ? m.spotSummary(ledger) : null;
  } catch { return null; }
}

/** The router's calibration (S17b), or null when no incident carries a route and no attempt a forecast. */
function readRouter(ledger: string): RouteCalibration | null {
  if (!existsSync(join(ledger, "incidents.jsonl"))) return null;
  try {
    const c = routeCalibrationOf(ledger);
    return c.routed || c.forecast_pass.n || c.forecast_mechanism.n ? c : null;
  } catch { return null; }
}

export async function readHistory(o: HistoryOptions): Promise<History> {
  const incidents = fold<Incident>(o.ledger, "incidents.jsonl");
  const sabotageInc = new Set(incidents.filter((i) => i.source === "sabotage").map((i) => i.id));
  const attempts = fold<Attempt & { run?: string | null }>(o.ledger, "attempts.jsonl");
  const sabotageAtt = new Set(attempts.filter((a) => a.task?.incident && sabotageInc.has(a.task.incident)).map((a) => a.id));
  const verdicts = fold<Verdict>(o.ledger, "verdicts.jsonl");
  const fires = fold<Fire>(o.ledger, "fires.jsonl");
  const steers = fold<Steer>(o.ledger, "steers.jsonl");
  const observations = fold<{ id: string }>(o.ledger, "observations.jsonl").length;
  const spendRecs = rawLines<SpendRecord>(o.ledger, "spend.jsonl").filter((r) => typeof r?.usd === "number");
  const skills = readSkills(o.skills, o.root);
  const policies = readSkills(o.policies ?? join(o.skills, "..", "policies"), o.root, "POLICY.md");

  const V = verdicts.map((v) => ({ ...v, sabotage: v.subject?.kind === "attempt" && sabotageAtt.has(v.subject.id) }));
  const A = attempts.map((a) => ({ ...a, sabotage: sabotageAtt.has(a.id) }));
  const I = incidents.map((i) => ({ ...i, sabotage: sabotageInc.has(i.id) }));

  let spend: SpendSummary | null = null;
  if (attempts.length || spendRecs.length) {
    const by_role: SpendSummary["by_role"] = {};
    for (const r of spendRecs) { const b = (by_role[r.role] ??= { usd: 0, n: 0 }); b.usd += r.usd; b.n++; }
    const attempts_usd = attempts.reduce((s, a) => s + (a.spent?.usd ?? 0), 0);
    spend = { attempts_usd, attempts_n: attempts.length, by_role, total_usd: attempts_usd + spendRecs.reduce((s, r) => s + r.usd, 0) };
  }

  const runs = new Set<string>();
  for (const r of [...I, ...A, ...V, ...fires] as { run?: string | null }[]) if (r.run) runs.add(r.run);
  const figures: RunFigures[] = [...runs].sort().map((run) => {
    const inRun = <T extends { run?: string | null; sabotage?: boolean }>(xs: T[]) => xs.filter((x) => x.run === run && !x.sabotage);
    const vs = inRun(V);
    return {
      run, incidents: inRun(I).length,
      repaired: inRun(I).filter((i) => i.status === "repaired").length,
      repaired_by_graduate: inRun(I).filter((i) => i.status === "repaired" && (i as { repaired_by?: string }).repaired_by).length,
      attempts: inRun(A).length,
      graduated: vs.filter((v) => v.subject.kind === "attempt" && v.decision === "GRADUATE").length,
      refused: vs.filter((v) => v.subject.kind === "attempt" && v.decision === "REFUSE").length,
      skills_graduated: vs.filter((v) => v.subject.kind === "skill" && v.decision === "GRADUATE").length,
      skills_refused: vs.filter((v) => v.subject.kind === "skill" && v.decision === "REFUSE").length,
      policies_graduated: vs.filter((v) => v.subject.kind === "policy" && v.decision === "GRADUATE").length,
      policies_refused: vs.filter((v) => v.subject.kind === "policy" && v.decision === "REFUSE").length,
      fires: fires.filter((f) => f.run === run && !sabotageAtt.has(f.attempt)).length,
    };
  });

  const commits = readCommits(o.live);
  return {
    incidents: I, attempts: A, verdicts: V, fires, steers, observations, skills, policies,
    curve: curveEvents(verdicts as unknown as (Record<string, unknown> & { id: string })[]),
    decisions: readDecisions(join(o.registers, "decisions"), o.root),
    findings: existsSync(join(o.registers, "findings.md")) ? parseFindings(readFileSync(join(o.registers, "findings.md"), "utf8")) : [],
    commits,
    commits_note: commits ? `git log ${LIVE_BRANCH} in ${o.live}` : `no ${LIVE_BRANCH} branch readable at ${o.live}`,
    spend,
    meter: spendMeter({ ledger: o.ledger, runsDir: o.runs, run: o.run ?? (process.env.RATCHET_RUN || "RUN-0001") }),
    spots: await readSpots(o.ledger, o.root),
    figures,
    router: readRouter(o.ledger),
    native: readNative(o.runs).filter((r) => !o.run || r.run === o.run),
    vread: existsSync(o.runs) && statSync(o.runs).isDirectory() ? readVRead(o.runs, o.run) : null,
  };
}

/** The /api/history handler's read: the server's ledger and runs dirs, every other path from the environment. */
/** A selected run (server/runs.ts RunPaths) also brings its run id, skills dir and live clone when it names them. */
export function historyFor(server: { ledger: string; runs: string; run?: string; skills?: string; live?: string | null }, env = process.env): Promise<History> {
  const base = historyPathsFromEnv(env);
  const skills = server.skills && existsSync(server.skills) ? server.skills : base.skills;
  return readHistory({ ...base, ledger: server.ledger, runs: server.runs, run: server.run, skills, policies: server.skills ? join(server.skills, "..", "policies") : base.policies, live: server.live ?? base.live });
}
