// Templates for the Premise, Approach and Pre-event evidence tabs (S14). Premise and Approach are prose and carry
// no figure; a figure on any tab other than Pre-event evidence is read from /api/history (ui/present/history.ts).
// The Pre-event tab renders ui/present/pre-event-evidence.ts, the one data file allowed to hold figures (SPEC §1.4).
// ui/present/present.test.ts greps this file for numeric literals.

import { esc } from "../format.ts";
import { PRE_EVENT_LABEL, PRE_EVENT_PREMISE, PRE_EVENT_FACTS } from "./pre-event-evidence.ts";

/** Track phrase → what stands for it in this build. */
export const TRACK_MAP: [string, string][] = [
  ["a hard, tightly coupled task", "A Game Boy (DMG) emulator accurate to the cycle: CPU, bus, timer, interrupts, a pixel-FIFO PPU and the MBC1 cartridge controller, all depending on each other's timing."],
  ["a failure", "An incident: while the player plays, a frame from this core differs from the frame SameBoy draws on the same inputs."],
  ["a versioned change", "A commit the gate merges into the core-live branch, or a skill: a five-slot lesson file the repairer reads."],
  ["held-out work", "The H and V test-ROM families. The fast loop and the skill author never see their readings."],
  ["roll back the rest", "A refused repair stays an unmerged branch whose REFUSE verdict is its tombstone; a refused skill moves to skills/tombstones/ with a successor pointer."],
];

export function premiseTab(): string {
  return `<section class="pz">
<h2>The question</h2>
<p class="lead">Track 1, <b>The System That Gets Better</b>, asks for a coding system that takes on a hard software task whose parts depend on one another, and improves itself as it works: each failure turns into a versioned change, every change has to prove itself on work held out from it, and only confirmed changes stay while the rest roll back.</p>
<h2>How this build answers it</h2>
<table class="map"><thead><tr><th>The track asks for</th><th>Here it is</th></tr></thead>
<tbody>${TRACK_MAP.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</tbody></table>
<h2>The claim in one line</h2>
<p>While Gemini plays the game, every glitch the SameBoy oracle confirms becomes a repair task for Muse Code, and no repair or lesson is kept unless it holds on hardware behaviour the system never learned from.</p>
<p class="dim">Every figure on the History tab is read from <code>ledger/</code> and <code>runs/</code> when the tab renders. Readings taken before the event appear only on the tab labelled “${esc(PRE_EVENT_LABEL)}”.</p>
</section>`;
}

interface Term { term: string; means: string; cite?: string }
interface Group { title: string; blurb: string; terms: Term[] }

export const GLOSSARY: Group[] = [
  {
    title: "Runtime roles", blurb: "The parts of the running product. No role both proposes and judges.",
    terms: [
      { term: "oracle", means: "SameBoy, run headless in lockstep on the same inputs. Its frames are the outside truth every check compares against.", cite: "GCE V2 § 7.3" },
      { term: "player", means: "Gemini, or the scripted explorer, driving the game. It finds failures and never judges them.", cite: "GCE V2 § 7.2" },
      { term: "narrator", means: "Gemini describing a divergence in screen words. It suggests; the oracle decides (D-0004).", cite: "GCE V2 § 12.6" },
      { term: "repairer", means: "Muse Code, headless, in a scratch repo built for one task. It may propose a change to core/ and nothing else.", cite: "GCE V2 § 7.2" },
      { term: "gate", means: "The mechanical judge in loop/gate.ts. Its rule constants are fixed before the run opens; it graduates or refuses.", cite: "GCE V2 § 10.3" },
      { term: "consolidator", means: "Muse Wonder, reading only its declared view every few incidents, nominating at most two skills.", cite: "GCE V2 § 7.4" },
    ],
  },
  {
    title: "Mechanisms", blurb: "What the loops pass to each other, and what they leave behind.",
    terms: [
      { term: "incident", means: "A divergence signature (scene, line band, diff box) first seen at one frame, with the trace window and oracle frames that replay it." },
      { term: "attempt", means: "One repairer run on one task, in one scratch repo, under one budget; a branch in the live clone." },
      { term: "verdict", means: "The gate's typed decision, GRADUATE or REFUSE, carrying every check's reading, the deciding reason and the residue it does not check." },
      { term: "skill · pentad", means: "A reusable lesson for the repairer. Its five slots: when it activates, what it says to do and not do, its warrant, what enforces it, and when it retires.", cite: "GCE V2 § 6" },
      { term: "shadow trial", means: "A candidate skill's test: the trial families repaired three ways from one commit under one budget. Candidate has the skill, baseline has none, placebo has a matched decoy." },
      { term: "tombstone", means: "The record of a refused or retired change: what it was, the verdict, its successor. Nothing is deleted." },
      { term: "latch · hook · fire", means: "A latch is the condition a skill activates on. It compiles into a Muse Code PreToolUse hook; when the hook triggers it writes a fire and prints the act the skill owes.", cite: "GCE V2 § 9" },
      { term: "declared projections", means: "Two named, tested functions that build a role's context from an allowlist: the repair packet and the consolidator's view.", cite: "GCE V2 § 10.6" },
    ],
  },
  {
    title: "Run roles", blurb: "How one measured run keeps its claim honest.",
    terms: [
      { term: "H families", means: "Held-out test-ROM families. Shadow trials repair them and the gate's no-regress check reads them; no fast-loop repair or consolidator sees them." },
      { term: "V families", means: "Sealed families, repaired once at curve freeze by the empty skill set S₀ and the frozen skill set S*, under equal budgets." },
      { term: "curve freeze", means: "The moment S* is hashed and V is read once. After it the run stops learning." },
      { term: "generation", means: "One slow-loop cycle, the x-axis of the generation curve." },
    ],
  },
];

export const UNIQUE: string[] = [
  "Failures come from use: the game is played, and only a frame the oracle disagrees with becomes an incident.",
  "The judge is not a model. Oracle frames and test ROMs decide; Gemini only describes (D-0004).",
  "Every skill races a placebo of the same length and register, so a lesson graduates only if it beats both doing nothing and doing something irrelevant.",
  "The repairer cannot see the oracle's source, the gate's rule or any held-out reading: its scratch repo's file list is asserted by a test (loop/projection.ts).",
  "Each Muse run gets a fresh HOME and session, so the baseline cannot learn on its own (D-0011); Muse's own memory runs only in a separate arm outside the gate (D-0013).",
  "Graduated lessons are files: SKILL.md plus a hook, drop-in for any Muse Code repository.",
];

export function approachTab(diagram: string, caption: string): string {
  return `<section class="ap">
<h2>How it works</h2>
<div class="diagram" id="present-diagram">${diagram}</div>
<div class="cap" id="present-diagram-cap">${esc(caption)}</div>
<h2>What is different here</h2>
<ul class="uniq">${UNIQUE.map((u) => `<li>${esc(u)}</li>`).join("")}</ul>
<p class="dim">The fast loop runs per incident: play, lockstep against the oracle, an incident, a repair packet in a scratch repo, then the gate's checks in order, ending GRADUATE or REFUSE. The slow loop reads the observations the fast loop writes, nominates skills, and trials each against a baseline and a placebo; a graduated skill's hook fires in later attempts. The highlighted box is the stage the most recent event on <code>/events</code> stands for.</p>
<h2>Terms</h2>
<div class="gloss">${GLOSSARY.map((g) => `<div class="ggroup"><h3>${esc(g.title)}</h3><p class="dim">${esc(g.blurb)}</p>
<dl>${g.terms.map((t) => `<dt>${esc(t.term)}${t.cite ? ` <span class="cite">${esc(t.cite)}</span>` : ""}</dt><dd>${esc(t.means)}</dd>`).join("")}</dl></div>`).join("")}</div>
</section>`;
}

export function preEventTab(): string {
  return `<section class="pe">
<h2>${esc(PRE_EVENT_LABEL)}</h2>
<p class="warn">${esc(PRE_EVENT_PREMISE)}</p>
${PRE_EVENT_FACTS.map((f) => `<div class="fact"><h3>${esc(f.id)}</h3><p>${esc(f.claim)}</p>
${f.table ? `<table class="map"><thead><tr>${f.table.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${f.table.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>` : ""}
<p class="dim">${esc(f.consequence)}</p></div>`).join("")}
</section>`;
}
