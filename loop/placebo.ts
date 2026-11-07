// The placebo skill (SPEC §2.3 placebo skill, §5 S9). `makePlacebo(candidate, others, skillsDir)` writes the
// candidate's twin mechanically, never through a model: the payload and activation of another candidate of a
// different shape when one exists and its length fits, else a SUBSYSTEM_TEMPLATES entry from a subsystem whose
// paths share no glob with the candidate's. The twin gets its own SKL id, a name from the consolidator's slugger
// (consolidate.ts slug), the same frontmatter fields, and a SKILL.md whose length is within LENGTH_TOLERANCE of the
// candidate's, reached by adding or dropping whole template sentences. Nothing in its files names it a placebo; the
// candidate ↔ twin pairing lives in runs/<run>/trials.jsonl (loop/trial.ts). Tests: loop/placebo.test.ts.

import { readFileSync } from "node:fs";
import { frontmatterFor, nextSkillId, parseSkill, skillText, slug, writeShadowSkill, type Nomination } from "./consolidate.ts";

/** Allowed relative difference between the twin's and the candidate's SKILL.md length in bytes (SPEC §5 S9: ±15%). */
export const LENGTH_TOLERANCE = 0.15;

interface Template { subsystem: string; paths: string[]; nomination: Omit<Nomination, "name" | "anchors" | "shape">; extra: string[] }

/** Payload templates from subsystems other than the PPU, each a complete pentad in the skill register. */
export const SUBSYSTEM_TEMPLATES: readonly Template[] = [
  {
    subsystem: "timer", paths: ["core/timer*.ts"],
    nomination: {
      fires_when: "a divergence whose first wrong value is a TIMA or DIV read, or an interrupt that arrives a few cycles early or late",
      not_this: "PPU pixel errors; joypad input errors", paths: ["core/timer*.ts"],
      owed: "run node tools/replay.mjs over the task's family before writing RESULT.json",
      do: "Derive TIMA increments from falling edges of the selected DIV bit, so a DIV write that clears the bit counts as an edge. Model the overflow as a delayed reload: TIMA reads 0 for one M-cycle before TMA is copied and the interrupt is requested.",
      dont: "Don't add a fixed cycle offset to the timer that makes one test pass; an offset that fits one ROM moves every other overflow by the same amount.",
      false_if: "a repair passes the timer family while counting TIMA on rising DIV edges", checked_by: ["admitted-traces", "base-suites"],
      residue: "does not check the TAC-write glitch on every frequency", retire_when: "moot: the timer is rewritten as a per-cycle counter",
    },
    extra: ["Read TAC's enable bit together with the selected bit, since disabling the timer can also produce an edge.", "Keep the reload window cycle-exact: a TIMA write inside it is ignored, a TMA write inside it is copied.", "Name the M-cycle at which the interrupt flag rises in the summary sentence."],
  },
  {
    subsystem: "dma", paths: ["core/dma*.ts"],
    nomination: {
      fires_when: "a divergence in sprite data or in a read made while an OAM DMA transfer is in flight",
      not_this: "background tile errors; CPU flag errors", paths: ["core/dma*.ts"],
      owed: "run node tools/replay.mjs over the task's family before writing RESULT.json",
      do: "Model OAM DMA as 160 M-cycles of one byte each, starting one M-cycle after the write to FF46. Block CPU reads outside HRAM during the transfer, returning the byte the DMA unit is moving.",
      dont: "Don't copy all 160 bytes at the write; an instant copy passes ROMs that read OAM only after the transfer and hides every bus-conflict test.",
      false_if: "a repair passes the DMA family with an instant 160-byte copy", checked_by: ["admitted-traces", "base-suites"],
      residue: "does not check a DMA restarted while one is in flight", retire_when: "moot: the bus is modelled per M-cycle with DMA as one of its clients",
    },
    extra: ["Treat a second write to FF46 during a transfer as a restart from the new source.", "Keep the source address arithmetic in the DMA unit, not in the bus read.", "Name the M-cycle the first byte lands in the summary sentence."],
  },
  {
    subsystem: "irq", paths: ["core/irq*.ts", "core/cpu*.ts"],
    nomination: {
      fires_when: "a divergence where an interrupt handler runs one instruction early or late, or HALT wakes at the wrong cycle",
      not_this: "pixel errors inside a correct frame; MBC bank errors", paths: ["core/irq*.ts"],
      owed: "run node tools/replay.mjs over the task's family before writing RESULT.json",
      do: "Dispatch an interrupt in 5 M-cycles, checking IE and IF after the high byte of PC is pushed, so a write to IE during the push can cancel the dispatch. Make EI take effect after the instruction that follows it.",
      dont: "Don't service an interrupt at the start of the instruction that enabled it; that ordering passes simple handlers and breaks every EI-delay test.",
      false_if: "a repair passes the interrupt family with EI taking effect immediately", checked_by: ["admitted-traces", "base-suites"],
      residue: "does not check the HALT bug's double-read on every opcode", retire_when: "moot: the CPU is rewritten as a per-M-cycle state machine",
    },
    extra: ["Model HALT with IME clear and a pending interrupt as the HALT bug: the next byte is read twice.", "Keep interrupt priority fixed by bit order, lowest bit first.", "Name the M-cycle the vector jump happens in the summary sentence."],
  },
];

export interface Twin { id: string; path: string; source: string; bytes: number; candidateBytes: number }

function overlaps(a: string[], b: string[]): boolean {
  const stem = (g: string) => g.replace(/\*.*$/, "");
  return a.some((x) => b.some((y) => stem(x).startsWith(stem(y)) || stem(y).startsWith(stem(x))));
}

function within(bytes: number, target: number): boolean {
  return Math.abs(bytes - target) <= LENGTH_TOLERANCE * target;
}

/** Writes the candidate's twin (see the file header) and returns it. `others` are this generation's other candidates' SKILL.md paths. */
export function makePlacebo(candidatePath: string, others: string[], skillsDir: string): Twin {
  const cand = parseSkill(readFileSync(candidatePath, "utf8"));
  const target = Buffer.byteLength(readFileSync(candidatePath, "utf8"));
  const id = nextSkillId(skillsDir);
  const anchors = cand.fm.warrant.anchors;

  for (const o of others) {
    const d = parseSkill(readFileSync(o, "utf8"));
    if (d.fm.id === cand.fm.id || d.fm.name === cand.fm.name) continue;
    const fm = { ...d.fm, id, status: "shadow" as const, name: slug(d.do.split(/\s+/).slice(0, 5).join(" ")), lifecycle: { ...d.fm.lifecycle, successor: null } };
    const text = skillText(fm, d.do, d.dont);
    if (within(Buffer.byteLength(text), target)) return { id, path: writeShadowSkill(skillsDir, fm, d.do, d.dont), source: `candidate ${d.fm.id}`, bytes: Buffer.byteLength(text), candidateBytes: target };
  }

  const tpl = SUBSYSTEM_TEMPLATES.find((t) => !overlaps(t.paths, cand.fm.activation.paths)) ?? SUBSYSTEM_TEMPLATES[0];
  const n: Nomination = { ...tpl.nomination, name: slug(tpl.nomination.do.split(/\s+/).slice(0, 5).join(" ")), shape: tpl.subsystem, anchors };
  const fm = frontmatterFor(id, n);
  // fit the length: add whole sentences from tpl.extra, then trim the Do sentence by sentence, then cut at a word
  let doText = n.do;
  const len = () => Buffer.byteLength(skillText(fm, doText, n.dont));
  for (const s of tpl.extra) { if (len() >= target * (1 - LENGTH_TOLERANCE / 2)) break; doText += " " + s; }
  let fill = 0;
  while (len() < target * (1 - LENGTH_TOLERANCE / 2) && fill < 40) { doText += " " + tpl.extra[fill % tpl.extra.length]; fill++; }
  while (len() > target * (1 + LENGTH_TOLERANCE / 2)) {
    const sentences = doText.split(/(?<=\.)\s+/);
    if (sentences.length > 1) { sentences.pop(); doText = sentences.join(" "); continue; }
    const words = doText.split(" ");
    if (words.length <= 4) break;
    doText = words.slice(0, -1).join(" ").replace(/[.,;]*$/, "") + ".";
  }
  const path = writeShadowSkill(skillsDir, fm, doText, n.dont);
  return { id, path, source: `template ${tpl.subsystem}`, bytes: len(), candidateBytes: target };
}
