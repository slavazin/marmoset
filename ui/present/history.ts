// The History tab template (S14): past progress read from GET /api/history (server/history.ts), which reads
// ledger/, runs/, skills/, ledger/decisions, ledger/findings.md and `git log core-live` at request time (SPEC G9).
// Every figure printed comes from that response; an absent source prints an empty state naming the file, never a
// zero. Sabotage records carry a label and are left out of the run figures (G2). Each item carries
// `data-ev="<kind>:<id>"`, which ui/present/evidence.ts opens in S6's evidence dialog. No numeric literal
// (ui/present/present.test.ts).

import type { History } from "../../server/history.ts";
import { esc, fmtReading, decidingCheck, shortSha } from "../format.ts";
import { fmtUsd, fmtRatio, fmtAt } from "./units.ts";

interface Row { at: string; kind: string; id: string; html: string; cls: string; run?: string | null }

const empty = (what: string) => `<div class="dim empty">${esc(what)}</div>`;
const tag = (s: string, cls = "") => `<span class="tag ${cls}">${esc(s)}</span>`;
const runTag = (run: string | null | undefined) => (run ? tag(run) : tag("run: null", "pre"));

export function timelineRows(h: History): Row[] {
  const rows: Row[] = [];
  for (const i of h.incidents) rows.push({ run: (i as { run?: string | null }).run, at: i.at, kind: "incident", id: i.id, cls: i.sabotage ? "sabotage" : "", html:
    `<b>${esc(i.id)}</b> incident · ${esc(i.source)}${i.sabotage ? " " + tag("sabotage: excluded from figures", "sab") : ""} · ${esc(i.pixels)} px differ · ${esc(i.status)}${i.narration ? ` · <i>${esc(i.narration)}</i>` : ""}` });
  for (const a of h.attempts) rows.push({ run: a.run, at: (a as { at?: string }).at ?? "", kind: "attempt", id: a.id, cls: a.sabotage ? "sabotage" : "", html:
    `<b>${esc(a.id)}</b> attempt · ${esc(a.task?.arm)} on ${esc(a.task?.incident ?? a.task?.family ?? "—")}${a.task?.skills?.length ? ` · shown ${esc(a.task.skills.join(", "))}` : ""}${a.result ? ` · <i>${esc(a.result.summary)}</i>` : ""}` });
  for (const v of h.verdicts) {
    const c = decidingCheck(v);
    const stamp = v.decision === "GRADUATE" ? "GRADUATED" : "REFUSED";
    rows.push({ run: v.run, at: v.at, kind: "verdict", id: v.id, cls: `${v.decision === "GRADUATE" ? "grad" : "refuse"}${v.sabotage ? " sabotage" : ""}`, html:
      `<span class="stampmini">${stamp}</span> <b>${esc(v.id)}</b> ${esc(v.subject.kind)} ${esc(v.subject.id)} · <b>${esc(c?.name ?? "—")}</b> ${esc(fmtReading(c?.reading))}` });
  }
  for (const f of h.fires) rows.push({ run: f.run, at: f.at, kind: "fire", id: f.id, cls: "", html: `<b>${esc(f.id)}</b> hook fired · ${esc(f.skill)} in ${esc(f.attempt)} on <code>${esc(f.path)}</code>` });
  for (const s of h.steers) rows.push({ run: s.run, at: s.at, kind: "steer", id: s.id, cls: "", html: `<b>${esc(s.id)}</b> owner steer${s.vetoes ? ` · vetoes ${esc(s.vetoes)}` : ""} · ${esc(s.text)}` });
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

function figures(h: History): string {
  const any = h.incidents.length || h.attempts.length || h.verdicts.length;
  if (!any) return empty("ledger/ holds no incident, attempt or verdict yet.");
  if (!h.figures.length) return empty("No run is open in this ledger: every record below carries run: null, was written before a run opened, and enters no figure.");
  return `<table class="map"><thead><tr><th>run</th><th>incidents</th><th>attempts</th><th>repairs graduated</th><th>repairs refused</th><th>skills graduated</th><th>skills refused</th><th>hook fires</th></tr></thead><tbody>
${h.figures.map((f) => `<tr><td>${esc(f.run)}</td><td>${esc(f.incidents)}</td><td>${esc(f.attempts)}</td><td>${esc(f.graduated)}</td><td>${esc(f.refused)}</td><td>${esc(f.skills_graduated)}</td><td>${esc(f.skills_refused)}</td><td>${esc(f.fires)}</td></tr>`).join("")}</tbody></table>
<div class="dim">Counted from ledger/*.jsonl per run; sabotage incidents, their attempts and verdicts, and run-null records are left out.</div>`;
}

function skills(h: History): string {
  if (!h.skills.length) return empty("No skill file under skills/shadow, skills/graduated or skills/tombstones.");
  return h.skills.map((s) => `<div class="item ${esc(s.status)}" data-ev="skill:${esc(s.id)}">${tag(s.status, s.status)} <b>${esc(s.id)}</b> ${esc(s.name)}${s.reason ? ` · ${esc(s.reason)}` : ""}${s.verdict ? ` · ${esc(s.verdict)}` : ""}${s.successor ? ` · successor <b>${esc(s.successor)}</b>` : ""} <span class="dim">${esc(s.path)}</span></div>`).join("");
}

function commits(h: History): string {
  if (!h.commits) return empty(h.commits_note);
  if (!h.commits.length) return empty(`${h.commits_note}: no commit`);
  return h.commits.map((c) => `<div class="item" data-ev="commit:${esc(c.sha)}"><code title="${esc(c.sha)}">${esc(shortSha(c.sha))}</code> ${esc(fmtAt(c.at))} · ${esc(c.subject)}${c.attempts.length ? ` · Attempt: <b>${esc(c.attempts.join(", "))}</b>` : ""}${c.skills.length ? ` · Skills: <b>${esc(c.skills.join(", "))}</b>` : ""}</div>`).join("")
    + `<div class="dim">${esc(h.commits_note)}</div>`;
}

function decisions(h: History): string {
  if (!h.decisions.length) return empty("No decision under ledger/decisions/.");
  return h.decisions.map((d) => `<div class="item" data-ev="decision:${esc(d.id)}">${tag(d.status, d.status)} <b>${esc(d.id)}</b> ${esc(d.title)}${d.supersedes ? ` · supersedes ${esc(d.supersedes)}` : ""}</div>`).join("");
}

function findings(h: History): string {
  if (!h.findings.length) return empty("No row in ledger/findings.md.");
  return h.findings.map((f) => `<div class="item" data-ev="finding:${esc(f.id)}"><b>${esc(f.id)}</b> ${esc(f.claim)} · <span class="dim">${esc(f.disposition)}</span></div>`).join("");
}

function spots(h: History): string {
  if (!h.spots) return empty("No Gemini sensor record: ledger/spots.jsonl is absent, or player/spot-score.ts is not in this build.");
  const s = h.spots as Record<string, unknown>;
  const keys = ["n", "tp", "fp", "fn", "tn", "failed"].filter((k) => k in s);
  return `<div>${keys.map((k) => `${esc(k)} <b>${esc(s[k])}</b>`).join(" · ")} · precision <b>${esc(fmtRatio(s.precision as number | null))}</b> · recall <b>${esc(fmtRatio(s.recall as number | null))}</b></div>
${s.subsystem ? `<div class="dim">subsystem agreement: ${esc(fmtReading(s.subsystem))}</div>` : ""}<div class="dim">spotSummary over ledger/spots.jsonl (player/spot-score.ts). The sensor nominates; the oracle decides (D-0004).</div>`;
}

function meter(h: History): string {
  const m = h.meter;
  if (!m) return "";
  const owner = m.owner_read_usd === null ? "no spend-override.json" : fmtUsd(m.owner_read_usd);
  return `<div>owner-read (Meta console) <b>${esc(owner)}</b> · priced (list rates, held by review) ${esc(fmtUsd(m.priced_usd))} · the guard reads ${esc(m.source)} ${esc(fmtUsd(m.usd))}: ask at ${esc(fmtUsd(m.ask_usd))}, stop at ${esc(fmtUsd(m.stop_usd))}</div>${m.warning ? `<div class="dim">warning: ${esc(m.warning)}</div>` : ""}`;
}

function spend(h: History): string {
  if (!h.spend) return meter(h) + empty("No attempt record and no ledger/spend.jsonl line.");
  const roles = Object.entries(h.spend.by_role);
  return `${meter(h)}<div>priced total <b>${esc(fmtUsd(h.spend.total_usd))}</b> · repair attempts ${esc(fmtUsd(h.spend.attempts_usd))} over ${esc(h.spend.attempts_n)} attempt records${roles.map(([r, b]) => ` · ${esc(r)} ${esc(fmtUsd(b.usd))} over ${esc(b.n)} calls`).join("")}</div>
<div class="dim">Summed from Attempt.spent.usd in ledger/attempts.jsonl and usd in ledger/spend.jsonl.</div>`;
}

function vread(h: History): string {
  if (!h.vread) return empty("V is sealed: no runs/<id>/vread.json exists, so nothing from V is shown.");
  const v = h.vread;
  const arm = (name: "baseline" | "ratchet") => v.arms[name].map((r) => `<div>${esc(name)} · ${esc(fmtReading(r))}</div>`).join("");
  return `<div data-ev="vread:${esc(v.run)}" class="item"><b>${esc(v.run)}</b> read once at ${esc(fmtAt(v.at))} on ${esc(shortSha(v.core_commit))} · n ${esc(v.n_family_runs_per_arm)} family-runs per arm${arm("baseline")}${arm("ratchet")}<div class="dim">residue: ${esc(v.residue.join(", "))}</div></div>`;
}

export function historyTab(h: History | null, error?: string): string {
  if (!h) return `<section class="hi">${empty(error ? `GET /api/history failed: ${error}` : "Reading /api/history …")}</section>`;
  const tl = timelineRows(h);
  return `<section class="hi">
<div class="hgrid">
<div class="hcol">
<h2>Run figures</h2>${figures(h)}
<h2>Timeline</h2><div class="timeline">${tl.length ? tl.map((r) => `<div class="item ${r.kind} ${r.cls}" data-ev="${esc(r.kind)}:${esc(r.id)}"><span class="at">${esc(fmtAt(r.at))}</span> ${r.html} ${runTag(r.run)}</div>`).join("") : empty("No incident, attempt, verdict, fire or steer in ledger/.")}</div>
</div>
<div class="hcol">
<h2>Skills</h2>${skills(h)}
<h2>Generation curve</h2><div id="present-curve"></div>
<h2>V read</h2>${vread(h)}
<h2>core-live commits</h2><div class="scrollbox">${commits(h)}</div>
<h2>Gemini sensor</h2>${spots(h)}
<h2>Spend</h2>${spend(h)}
<h2>Decisions</h2><div class="scrollbox">${decisions(h)}</div>
<h2>Cold-read findings</h2><div class="scrollbox">${findings(h)}</div>
</div></div></section>`;
}
