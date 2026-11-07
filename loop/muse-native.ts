// The muse-native arm (D-0013). `runMuseNative(deps)` repairs each TRIAL_FAMILIES family once from the core-live
// commit with Muse Code's own learning on: a persistent HOME and XDG_CONFIG_HOME at $RATCHET_CACHE/muse-native-home
// kept across this arm's runs only, observers on (D-0001's command line without --disable-reminders), no shown
// skills and no hooks. Its readings go to runs/<run>/muse-native.jsonl and nowhere else: it appends no Attempt, no
// Verdict, no Calibration and no vread record (loop/muse-native.test.ts asserts the ledger and calibration files are
// untouched). Each reading carries the repairer's priced `spent`, which server/spend.ts combinedMeter reads through
// extraFiles. `base` pins the commit (a generation's base_commit; loop/muse-native-watch.ts), else the live branch head.
// Off by default: `node loop/slow.ts --muse-native`, or the watcher, run only after S9's Accept is green (D-0013).

import { appendFileSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { TRIAL_FAMILIES, MAX_STEPS } from "./gate.ts";
import { git, LIVE_BRANCH, type LoopPaths } from "./paths.ts";
import { repairPacket, removeScratch } from "./projection.ts";
import { MUSE_BIN, MUSE_SETTINGS_FILE, museArgs, runRepair, usageFromEvents, MUSE_MODEL, type MuseRunner, type RepairOutput } from "./repair.ts";
import { coreAt, TRIAL_WALL_S, type TrialJudge } from "./trial.ts";
import { loadSplits, familyRoms } from "../suites/splits.ts";
import { tlog } from "../src/telemetry.ts";
import type { RepairTask, SuiteReading } from "../src/schema.ts";

/** The arm's persistent home under the cache. */
export function nativeHome(cache: string): string { return join(cache, "muse-native-home"); }

/** D-0001's argv with observers on: --disable-reminders removed. */
export function nativeArgs(sessionId: string, maxSteps: number): string[] {
  return museArgs(sessionId, maxSteps).filter((a) => a !== "--disable-reminders");
}

/** Wraps a runner so every run uses the persistent home; `inner` defaults to the real CLI with nativeArgs. */
export function nativeRunner(home: string, inner?: MuseRunner): MuseRunner {
  const xdg = join(home, ".config");
  mkdirSync(join(xdg, "muse"), { recursive: true });
  if (!existsSync(join(xdg, "muse", "settings.json"))) copyFileSync(MUSE_SETTINGS_FILE, join(xdg, "muse", "settings.json"));
  const withHome = (env: Record<string, string>) => ({ ...env, HOME: home, XDG_CONFIG_HOME: xdg });
  if (inner) return { skillsList: (cwd, env) => inner.skillsList(cwd, withHome(env)), run: (r) => inner.run({ ...r, env: withHome(r.env) }) };
  return {
    async skillsList() { return "(muse-native: persistent home, not listed)"; },
    run: (r) => new Promise((res) => {
      const t0 = Date.now();
      const ch = spawn(MUSE_BIN, nativeArgs(r.sessionId, r.maxSteps), { cwd: r.cwd, env: withHome(r.env), stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      const timer = setTimeout(() => ch.kill("SIGTERM"), r.wallS * 1000);
      ch.stdout.on("data", (x) => { out += x; appendFileSync(r.eventsFile, x); });
      ch.on("error", () => { clearTimeout(timer); res({ exitCode: 127, model: "", steps: 0, tokens_in: 0, tokens_out: 0, wall_s: 0 }); });
      ch.on("close", (code) => {
        clearTimeout(timer);
        const u = usageFromEvents(out);
        res({ exitCode: code ?? 1, model: u.model || `${MUSE_MODEL} (not echoed)`, steps: u.steps, tokens_in: u.tokens_in, tokens_out: u.tokens_out, wall_s: (Date.now() - t0) / 1000 });
      });
    }),
  };
}

export interface NativeDeps { paths: LoopPaths; judge: TrialJudge; run: string; runsDir?: string; generation: number; runner?: MuseRunner; families?: readonly string[]; familyRoms?: (f: string) => string[]; base?: string; home?: string }
export interface NativeReading { at: string; run: string; generation: number; arm: "muse-native"; family: string; base_commit: string; reading: SuiteReading; model: string; exit: number; home: string; spent?: RepairOutput["spent"] }

/** One muse-native pass over the trial families (see the file header); returns the records appended. */
export async function runMuseNative(d: NativeDeps): Promise<NativeReading[]> {
  const home = d.home ?? nativeHome(d.paths.cache);
  const runner = nativeRunner(home, d.runner);
  const base = d.base ?? git(d.paths.live, ["rev-parse", LIVE_BRANCH]);
  const file = join(d.runsDir ?? join(d.paths.root, "runs"), d.run, "muse-native.jsonl");
  mkdirSync(join(file, ".."), { recursive: true });
  const out: NativeReading[] = [];
  for (const family of d.families ?? TRIAL_FAMILIES) {
    const id = `NATIVE-${d.generation}-${family.replace(/[^a-z0-9]+/gi, "-")}`;
    const task: RepairTask = { kind: "family", family, base_commit: base, arm: "baseline", skills: [], budget: { max_steps: MAX_STEPS, wall_s: TRIAL_WALL_S } };
    const roms = d.familyRoms ? d.familyRoms(family) : (() => { try { return familyRoms(loadSplits(), family, d.paths.roms).map((r) => join(d.paths.roms, r)); } catch { return []; } })();
    tlog("loop", "muse-native.start", { generation: d.generation, family, base_commit: base, home });
    const packet = repairPacket(task, { attempt: id, paths: d.paths, familyRoms: roms });
    const rep = await runRepair(task, packet, { attempt: id, server: d.paths.server, runner });
    // a Muse run that exits non-zero before any model call repaired nothing: no reading is written for it
    // (loop/muse-native.test.ts "no model call")
    if (rep.exitCode !== 0 && rep.spent.steps === 0) { removeScratch(packet.dir); throw new Error(`muse-native ${family}: Muse exited ${rep.exitCode} before any model call`); }
    const coreDir = join(d.paths.cache, "trial", id);
    try { coreAt(d.paths, base, coreDir, rep.diff); } catch { coreAt(d.paths, base, coreDir); }
    const [reading] = await d.judge.score(join(coreDir, "core"), "H", family);
    removeScratch(packet.dir); removeScratch(coreDir);
    const rec: NativeReading = { at: new Date().toISOString(), run: d.run, generation: d.generation, arm: "muse-native", family, base_commit: base, reading, model: rep.model, exit: rep.exitCode, home, spent: rep.spent };
    appendFileSync(file, JSON.stringify(rec) + "\n");
    tlog("loop", "muse-native.end", rec);
    out.push(rec);
  }
  return out;
}
