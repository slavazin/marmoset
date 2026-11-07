// The run registry (S24): every runs/RUN-NNNN directory the server can show, each with a display name, a one-line
// description and the paths its views read. Everything is read from files at request time (SPEC G9); this module
// writes nothing (AGENTS.md rule 2). server/runs.test.ts asserts the names, the paths and the stop wording.
//
// Name: `<game> · <tier> · <repairer family>`, where game is the games.json id whose sha256 matches conditions.json
// rom_sha (else the ROM file's basename), tier is CGB when conditions.json names a CGB live branch or the cgb-suite
// source (else DMG), and the repairer family is conditions.json repairer.runner when present (S23: {"runner":"claude",
// "model":"claude-sonnet-5"}), else manifest.json models.repairer's first word ("muse-spark-1.3" → Muse).
// runs/labels.json, when present, names games and tiers for display and, per run, overrides the name, the tier word
// or prefixes a note to the description:
//   { "games": { "game": "Fernwake" }, "runs": { "RUN-0002": { "tier": "Color tier · CGB suite", "note": "…" } } }
// Description: the note, the repairer model string, the S0 core commit, the incident source, and how the run ended,
// read from the last `stop` record of runs/RUN-NNNN/campaign.jsonl.
//
// Paths: DEFAULT_RUN (RUN-0001) reads the shared ledger/ and evidence/ (its records carry run "RUN-0001"); every
// other run reads runs/RUN-NNNN/ledger, runs/RUN-NNNN/evidence and runs/RUN-NNNN/skills.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Paths } from "./events.ts";

/** The run a request without `run` selects: the one run whose ledger is the shared ledger/ (D-0006 live clone). */
export const DEFAULT_RUN = "RUN-0001";
/** A run id the registry accepts; a request naming anything else is refused (server/runs.test.ts "run id"). */
export const RUN_ID = /^RUN-\d{4}$/;

export interface RunPaths extends Paths { run: string; skills: string; live: string | null; live_branch: string | null }
export interface RunStop { at: string; reason: string; attempts: number | null }
export interface RunEntry {
  id: string; name: string; description: string;
  game: string; tier: "DMG" | "CGB"; repairer: string; repairer_model: string | null;
  core: string | null; source: string | null; stop: RunStop | null;
  has_ledger: boolean; has_telemetry: boolean; has_vread: boolean;
  /** "read": vread.json exists; "running": vread.lock or vread-progress.jsonl without vread.json; "not read": neither. */
  vread_state: "read" | "running" | "not read";
  paths: RunPaths;
}

/** The base directories a registry resolves against: the shared ledger and evidence, and runs/. */
export interface RegistryBase { ledger: string; evidence: string; runs: string; skills?: string; games?: string; live?: string }

function readJson<T>(p: string): T | null {
  try { return JSON.parse(readFileSync(p, "utf8")) as T; } catch { return null; }
}
const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

/** The last `stop` record of runs/<run>/campaign.jsonl, or null when the file holds none. */
export function readStop(runDir: string): RunStop | null {
  const p = join(runDir, "campaign.jsonl");
  if (!existsSync(p)) return null;
  let stop: RunStop | null = null;
  for (const l of readFileSync(p, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l) as { t?: string; at?: string; reason?: string; attempts?: number };
      if (r.t === "stop") stop = { at: String(r.at ?? ""), reason: String(r.reason ?? ""), attempts: typeof r.attempts === "number" ? r.attempts : null };
    } catch { /* partial line */ }
  }
  return stop;
}

/** Paths a run's views read (header). */
export function runPaths(base: RegistryBase, run: string): RunPaths {
  if (!RUN_ID.test(run)) throw new Error(`run id: ${run}`);
  const dir = join(base.runs, run);
  const cond = readJson<{ live?: string; live_branch?: string }>(join(dir, "conditions.json"));
  if (run === DEFAULT_RUN) {
    return { run, ledger: base.ledger, evidence: base.evidence, runs: base.runs, skills: base.skills ?? join(base.ledger, "..", "skills"), live: base.live ?? cond?.live ?? null, live_branch: cond?.live_branch ?? null };
  }
  return { run, ledger: join(dir, "ledger"), evidence: join(dir, "evidence"), runs: base.runs, skills: join(dir, "skills"), live: cond?.live ?? null, live_branch: cond?.live_branch ?? null };
}

/** One run's registry entry, or null when runs/<run> holds no manifest.json and is not DEFAULT_RUN. */
export function runEntry(base: RegistryBase, run: string, labels: Labels = readLabels(base.runs)): RunEntry | null {
  const dir = join(base.runs, run);
  const manifest = readJson<{ models?: { repairer?: string } }>(join(dir, "manifest.json"));
  if (!manifest && run !== DEFAULT_RUN) return null;
  const cond = readJson<{ rom?: string; rom_sha?: string; source?: string; live_branch?: string; s0_core_commit?: string; repairer?: { runner?: string; model?: string } }>(join(dir, "conditions.json"));
  const games = readJson<{ games?: { id: string; rom?: { sha256?: string } }[] }>(base.games ?? join(base.runs, "..", "games.json"))?.games ?? [];
  const byS = cond?.rom_sha ? games.find((g) => g.rom?.sha256 === cond.rom_sha) : undefined;
  const game = byS?.id ?? (cond?.rom ? basename(cond.rom, extname(cond.rom)) : "game");
  const tier: "DMG" | "CGB" = /cgb/i.test(`${cond?.live_branch ?? ""} ${cond?.source ?? ""}`) ? "CGB" : "DMG";
  const model = cond?.repairer?.model ?? manifest?.models?.repairer ?? null;
  const fam = cond?.repairer?.runner ?? (model ?? "unknown").split(/[-\s]/)[0];
  const repairer = fam.charAt(0).toUpperCase() + fam.slice(1);
  const stop = readStop(dir);
  const label = labels.runs?.[run] ?? {};
  const gameName = labels.games?.[game] ?? game;
  const paths = runPaths(base, run);
  const has_vread = existsSync(join(dir, "vread.json"));
  const vread_state = has_vread ? "read" : existsSync(join(dir, "vread.lock")) || existsSync(join(dir, "vread-progress.jsonl")) ? "running" : "not read";
  const core = cond?.s0_core_commit ?? null;
  const ended = stop
    ? `stopped ${stop.at}: ${stop.reason}${stop.attempts !== null ? ` (${stop.attempts} attempts)` : ""}`
    : "no stop record in campaign.jsonl (running, or ended without one)";
  const parts = [label.note, model ? `repairer ${model}` : null, core ? `S0 core ${core.slice(0, 7)}` : null, cond?.source ? `incidents from ${cond.source}` : null, ended];
  return {
    id: run, name: label.name ?? `${label.game ?? gameName} · ${label.tier ?? tier} · ${repairer}`, description: parts.filter(Boolean).join("; "),
    game, tier, repairer, repairer_model: model, core, source: cond?.source ?? null, stop,
    has_ledger: isDir(paths.ledger), has_telemetry: isDir(join(dir, "telemetry")), has_vread, vread_state, paths,
  };
}

/** runs/labels.json (see the file header): display words only; it enters no figure. */
export interface Labels { games?: Record<string, string>; runs?: Record<string, { name?: string; game?: string; tier?: string; note?: string }> }
/** runs/labels.json, or {} when absent or unreadable. */
export function readLabels(runsDir: string): Labels {
  return readJson<Labels>(join(runsDir, "labels.json")) ?? {};
}

/** Every run under runs/ with a manifest.json, plus DEFAULT_RUN, in id order (GET /api/runs). */
export function listRuns(base: RegistryBase): RunEntry[] {
  const labels = readLabels(base.runs);
  const ids = new Set<string>([DEFAULT_RUN]);
  if (isDir(base.runs)) for (const d of readdirSync(base.runs)) if (RUN_ID.test(d)) ids.add(d);
  return [...ids].sort().flatMap((id) => runEntry(base, id, labels) ?? []);
}

/** The run a request selects: `?run=`, else the `ratchet_run` cookie, else DEFAULT_RUN; an ill-formed id is refused. */
export function selectedRun(url: URL, cookie: string | undefined, fallback = DEFAULT_RUN): string {
  const q = url.searchParams.get("run");
  const c = /(?:^|;\s*)ratchet_run=([^;]+)/.exec(cookie ?? "")?.[1];
  const run = q ?? (c ? decodeURIComponent(c) : fallback);
  if (run !== fallback && !RUN_ID.test(run)) throw new Error(`run id: ${run}`);
  return run;
}

/** The mode a request selects: `?mode=`, else the `ratchet_mode` cookie, else "live". */
export function selectedMode(url: URL, cookie: string | undefined): "live" | "replay" {
  const q = url.searchParams.get("mode") ?? /(?:^|;\s*)ratchet_mode=([^;]+)/.exec(cookie ?? "")?.[1];
  return q === "replay" ? "replay" : "live";
}

/** One run's overview row (History tab "Runs"): counts over records whose `run` is the run's id, sabotage excluded (G2). */
export interface RunOverview {
  id: string; name: string; description: string;
  incidents: number; attempts: number; graduated: number; refused: number;
  /** REFUSE verdicts on attempts, keyed by the first check with pass false ("none" when every check passed). */
  refused_by_check: Record<string, number>;
  /** server/spend.ts spendMeter for the run: the figure its guard acts on, and that figure's source. */
  spend_usd: number; spend_source: string;
  vread_state: RunEntry["vread_state"]; stop: RunStop | null; has_telemetry: boolean;
}

function jsonl(p: string): Record<string, unknown>[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").flatMap((l) => { if (!l.trim()) return []; try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } });
}
/** Last record per id, in first-seen order (ledgers append status flips under the same id). */
function lastById(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const m = new Map<string, Record<string, unknown>>();
  for (const r of rows) m.set(String(r.id), r);
  return [...m.values()];
}

/** The overview row of one registry entry, read from its ledger (server/runs.test.ts "overview"). */
export async function runOverview(e: RunEntry): Promise<RunOverview> {
  const { spendMeter } = await import("./spend.ts");
  const L = e.paths.ledger;
  const inc = lastById(jsonl(join(L, "incidents.jsonl"))).filter((i) => i.run === e.id);
  const sabInc = new Set(inc.filter((i) => i.source === "sabotage").map((i) => String(i.id)));
  const att = lastById(jsonl(join(L, "attempts.jsonl"))).filter((a) => a.run === e.id && !sabInc.has(String((a.task as { incident?: string } | undefined)?.incident)));
  const attIds = new Set(att.map((a) => String(a.id)));
  const ver = lastById(jsonl(join(L, "verdicts.jsonl"))).filter((v) => (v.subject as { kind?: string } | undefined)?.kind === "attempt" && attIds.has(String((v.subject as { id: string }).id)));
  const refused_by_check: Record<string, number> = {};
  for (const v of ver.filter((x) => x.decision === "REFUSE")) {
    const c = ((v.checks as { name: string; pass: boolean }[] | undefined) ?? []).find((k) => !k.pass)?.name ?? "none";
    refused_by_check[c] = (refused_by_check[c] ?? 0) + 1;
  }
  let spend_usd = 0, spend_source = "no ledger";
  if (e.has_ledger) { const m = spendMeter({ ledger: L, runsDir: e.paths.runs, run: e.id }); spend_usd = m.usd; spend_source = m.source; }
  return {
    id: e.id, name: e.name, description: e.description, incidents: inc.filter((i) => !sabInc.has(String(i.id))).length,
    attempts: att.length, graduated: ver.filter((v) => v.decision === "GRADUATE").length, refused: ver.filter((v) => v.decision === "REFUSE").length,
    refused_by_check, spend_usd, spend_source, vread_state: e.vread_state, stop: e.stop, has_telemetry: e.has_telemetry,
  };
}

