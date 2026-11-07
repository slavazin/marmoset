// suiteIncident (SPEC §5 S5): opens an incident from a failing T-family ROM, with source "suite",
// align "frame" and the ROM's reading (suites/score.ts runRom) as its repro in window.json. G4 check 1
// reads that repro as "the ROM passes, or its pixel match rises by at least SUITE_MIN_GAIN" (loop/gate.ts).
// A passing ROM opens nothing; a ROM with an open suite incident returns that incident.
// Truth-maker: lockstep/lockstep.test.ts.
import { readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Core, CreateCore, Incident, Splits } from "../src/schema.ts";
import { sha256, traceSha } from "../oracle/client.ts";
import { loadReference, loadReferenceRgb, runRom, type Caps } from "../suites/score.ts";
import { familyModel, familyRoms, loadSplits, passRule, referencePath, romsDir } from "../suites/splits.ts";
import { frameDiff, signatureOf } from "./diff.ts";
import { EVIDENCE_ROOT, writeEvidence } from "./evidence.ts";
import type { IncidentSink } from "./incidents.ts";

const REPO = resolve(import.meta.dirname, "..");

export interface SuiteIncidentOptions {
  createCore: CreateCore;
  coreCommit: string;
  sink: IncidentSink;
  evidenceRoot?: string;
  splits?: Splits;
  root?: string;
  caps?: Caps;
  run?: string | null;
}

export function suiteIncident(family: string, rom: string, o: SuiteIncidentOptions): Incident | null {
  const splits = o.splits ?? loadSplits();
  const root = o.root ?? romsDir();
  if (splits.families[family]?.split !== "T") throw new Error(`suiteIncident: ${family} is not a T family`);
  if (!familyRoms(splits, family, root).includes(rom)) throw new Error(`suiteIncident: ${rom} is not a scored ROM of ${family}`);
  const rom_sha = sha256(readFileSync(join(root, rom)));
  const seen = o.sink.open().find((i) => i.source === "suite" && i.rom_sha === rom_sha);
  if (seen) return seen;

  // a CGB family (splits-cgb.json, D-0019) runs on a core created with { model: "CGB" } and diffs RGB frames
  const model = familyModel(splits, family);
  let core: Core | null = null;
  const reading = runRom((bytes, opts) => (core = o.createCore(bytes, opts)), root, rom, o.caps, undefined, model);
  if (reading.pass) return null;

  let frame: Uint8Array | null = null, ref: Uint8Array | null = null;
  try { const c = core as Core | null; frame = (model === "CGB" ? c?.frameRgb?.() : c?.frame()) ?? null; } catch { frame = null; }
  const rp = passRule(rom) === "screenshot" ? referencePath(root, rom, model) : null;
  if (rp) ref = model === "CGB" ? loadReferenceRgb(join(root, rp)) : loadReference(join(root, rp));
  const d = frame && ref ? (model === "CGB" ? frameDiff(...rgbMasks(frame, ref)) : frameDiff(frame, ref)) : { pixels: 0, firstLine: -1, box: [0, 0, 0, 0] as [number, number, number, number] };
  const evidenceRoot = o.evidenceRoot ?? EVIDENCE_ROOT;

  const inc = o.sink.record((id) => {
    const dir = join(evidenceRoot, id);
    const rel = relative(REPO, dir);
    return {
      id, at: new Date().toISOString(), run: o.run ?? null, kind: "frame", align: "frame",
      signature: signatureOf(0, d), rom_sha, trace_sha: traceSha({ rom_sha, align: "frame", inputs: [] }),
      window: [0, 0], core_commit: o.coreCommit, counter: 0, pixels: d.pixels,
      files: { dir: rel.startsWith("..") ? dir : rel }, source: "suite", status: "open",
    };
  });
  writeEvidence(join(evidenceRoot, inc.id), {
    kind: "suite", incident: inc, rom: { path: resolve(root, rom), sha: rom_sha }, family, rom_rel: rom, repro: reading,
    ...(model === "CGB" ? { model } : {}),
  }, frame, ref, [], model === "CGB");
  return inc;
}

/** Two per-pixel arrays frameDiff reads from two RGB888 frames: 0 everywhere, 1 in the second where the colours differ. */
function rgbMasks(a: Uint8Array, b: Uint8Array): [Uint8Array, Uint8Array] {
  const n = a.length / 3, x = new Uint8Array(n), y = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (a[i * 3] !== b[i * 3] || a[i * 3 + 1] !== b[i * 3 + 1] || a[i * 3 + 2] !== b[i * 3 + 2]) y[i] = 1;
  return [x, y];
}
