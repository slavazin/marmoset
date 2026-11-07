// Opens one History item in S6's evidence dialog (`#modal`, `#modalbody` in ui/index.html): a verdict with its
// checks, readings, attempt, commit and incident images; an incident with its evidence PNGs; an attempt, skill,
// commit, decision, finding, fire, steer or V read with its record. Every value printed is the record's. No numeric
// literal (ui/present/present.test.ts).

import type { History } from "../../server/history.ts";
import type { Incident } from "../../src/schema.ts";
import { esc, fmtReading, evidenceUrl } from "../format.ts";
import { fmtUsd } from "./units.ts";

const figs = (inc: Incident) => `<p>evidence: <code>${esc(inc.files.dir)}</code> (${esc(inc.id)})</p><div class="figs">${["core.png", "oracle.png", "diff.png"].map((f) => `<figure><img src="${esc(evidenceUrl(inc, f))}" alt="${esc(f)}"><figcaption>${esc(f)}</figcaption></figure>`).join("")}</div>`;
const record = (r: unknown) => `<details><summary>record</summary><pre>${esc(JSON.stringify(r, null, "  "))}</pre></details>`;

/** The dialog body for item `kind:id`, or null when the History response holds no such item. */
export function evidenceHtml(h: History, kind: string, id: string): string | null {
  const incident = (iid: string | undefined) => (iid ? h.incidents.find((i) => i.id === iid) : undefined);
  switch (kind) {
    case "verdict": {
      const v = h.verdicts.find((x) => x.id === id);
      if (!v) return null;
      const a = v.subject.kind === "attempt" ? h.attempts.find((x) => x.id === v.subject.id) : undefined;
      const inc = incident(a?.task?.incident);
      const commit = a?.head_commit ? h.commits?.find((c) => c.sha.startsWith(a.head_commit!) || c.attempts.includes(a.id)) : undefined;
      return `<h2>${esc(v.id)} · ${esc(v.decision)} · ${esc(v.subject.kind)} ${esc(v.subject.id)}${v.sabotage ? " · sabotage (excluded from figures)" : ""}</h2>
<p>${esc(v.reason)}</p>
<table>${v.checks.map((c) => `<tr class="${c.pass ? "pass" : "fail"}"><td>${c.pass ? "pass" : "FAIL"}</td><td>${esc(c.name)}</td><td>${esc(fmtReading(c.reading))}</td></tr>`).join("")}</table>
${v.arms ? `<p>arms (n ${esc(v.arms.n_family_runs_per_arm)} family-runs per arm): candidate ${esc(fmtReading(v.arms.candidate))}; baseline ${esc(fmtReading(v.arms.baseline))}; placebo ${esc(fmtReading(v.arms.placebo))}; margin ${esc(fmtReading(v.arms.margin))}</p>` : ""}
<p class="dim">attempt ${esc(a?.id ?? "—")} · commit ${esc(a?.head_commit ?? "—")}${commit ? ` (core-live ${esc(commit.sha)})` : ""} · branch ${esc(a?.branch ?? "—")} · rule_version ${esc(v.rule_version)} · residue ${esc(v.residue.join(", "))}</p>
${inc ? figs(inc) : ""}${record(v)}`;
    }
    case "incident": {
      const inc = incident(id);
      if (!inc) return null;
      return `<h2>${esc(inc.id)} · incident · ${esc(inc.source)}${inc.sabotage ? " (sabotage, excluded from figures)" : ""} · ${esc(inc.status)}</h2>
<p>${esc(inc.pixels)} px differ at counter ${esc(inc.counter)}, window ${esc(inc.window.join("…"))}, core ${esc(inc.core_commit)}</p>
${inc.narration ? `<p><i>${esc(inc.narration)}</i> <span class="dim">(narration nominates; the oracle decides)</span></p>` : ""}${figs(inc)}${record(inc)}`;
    }
    case "attempt": {
      const a = h.attempts.find((x) => x.id === id);
      if (!a) return null;
      const inc = incident(a.task?.incident);
      return `<h2>${esc(a.id)} · attempt · ${esc(a.task?.arm)}</h2>
<p>${esc(a.result?.summary ?? "no RESULT.json summary")}</p>
<p class="dim">branch ${esc(a.branch)} · head ${esc(a.head_commit ?? "—")} · model ${esc(a.model)} · steps ${esc(a.spent?.steps)} · wall ${esc(a.spent?.wall_s)} s · ${esc(a.spent ? fmtUsd(a.spent.usd) : "—")} · skills shown ${esc(a.task?.skills?.join(", ") || "none")} · dispositions ${esc(fmtReading(a.result?.dispositions))} · fires ${esc(a.fires?.join(", ") || "none")}</p>
${inc ? figs(inc) : ""}${record(a)}`;
    }
    case "commit": {
      const c = h.commits?.find((x) => x.sha === id);
      if (!c) return null;
      const vs = h.verdicts.filter((v) => c.attempts.includes(v.subject.id));
      return `<h2>core-live ${esc(c.sha)}</h2><p>${esc(c.subject)}</p><p class="dim">${esc(c.at)} · Attempt: ${esc(c.attempts.join(", ") || "—")} · Skills: ${esc(c.skills.join(", ") || "—")}</p>
${vs.map((v) => `<p>${esc(v.id)} ${esc(v.decision)}: ${esc(v.reason)}</p>`).join("")}`;
    }
    case "decision": {
      const d = h.decisions.find((x) => x.id === id);
      return d ? `<h2>${esc(d.id)} · ${esc(d.title)}</h2><p class="dim">${esc(d.status)} · ${esc(d.path)}</p><pre>${esc(d.body)}</pre>` : null;
    }
    case "finding": {
      const f = h.findings.find((x) => x.id === id);
      return f ? `<h2>${esc(f.id)} · ${esc(f.slice)}</h2><table><tr><td>claim</td><td>${esc(f.claim)}</td></tr><tr><td>reading</td><td>${esc(f.reading)}</td></tr><tr><td>disposition</td><td>${esc(f.disposition)}</td></tr></table><p class="dim">ledger/findings.md</p>` : null;
    }
    case "skill": {
      const s = h.skills.find((x) => x.id === id);
      return s ? `<h2>${esc(s.id)} · ${esc(s.name)} · ${esc(s.status)}</h2><p class="dim">${esc(s.path)}</p>${record(s)}` : null;
    }
    case "fire": { const f = h.fires.find((x) => x.id === id); return f ? `<h2>${esc(f.id)} · fire</h2><p>${esc(f.skill)} fired in ${esc(f.attempt)} on <code>${esc(f.path)}</code>; owed: ${esc(f.owed)}</p>${record(f)}` : null; }
    case "steer": { const s = h.steers.find((x) => x.id === id); return s ? `<h2>${esc(s.id)} · owner steer</h2><p>${esc(s.text)}</p>${record(s)}` : null; }
    case "vread": return h.vread ? `<h2>V read · ${esc(h.vread.run)}</h2>${record(h.vread)}` : null;
  }
  return null;
}

/** Fills and opens S6's dialog for `kind:id`; returns false when the dialog or the item is missing. */
export function openEvidence(h: History, key: string): boolean {
  const [kind, ...rest] = key.split(":");
  const html = evidenceHtml(h, kind, rest.join(":"));
  const body = document.getElementById("modalbody");
  const dlg = document.getElementById("modal") as HTMLDialogElement | null;
  if (!html || !body || !dlg) return false;
  body.innerHTML = html;
  dlg.showModal();
  return true;
}
