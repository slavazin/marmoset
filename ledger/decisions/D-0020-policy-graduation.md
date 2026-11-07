---
id: D-0020
title: The gate graduates policies (packet, tool and routing changes) by the skill trial rule
status: admitted
supersedes: null
---
**Decision:** besides skills, the slow loop nominates policies: versioned changes to how the repair packet is built, which tool flags the repairer gets, or how an incident is routed to shown skills (Gemini's S13 subsystem guess included). A policy runs through the same shadow trial as a skill. The candidate arm runs with the policy, the baseline without it, and the placebo with a matched mechanical twin (for routing, a random route; for packets, a size-matched other file set). It graduates only if candidate − max(baseline, placebo) ≥ margin on every trial family, with the calibration margins of `runs/<run>/calibration.jsonl`. A graduated policy applies to every later fast attempt and is named on each attempt (`RepairTask.policies`). Refused policies are tombstoned like skills.
**Not this:** policy changes applied by hand or by the consolidator directly; a policy judged by any rule other than the gate's.
**Warrant:** owner ratified 2026-11-07. The track asks for versioned changes to "skills, tools, routing or context", and a policy that beats its placebo shows the system changing how it works. False if: a policy reaches `policies/graduated/` without a skill-rule verdict naming it.
**Revisit when:** {when: "one policy trial costs more than one skill trial's wall time ×2 (measured)", then: "trial policies on 1 trial family (S9 Wiggle)"}
**Residue:** policies and skills share trial families and budget, so a generation that trials both runs longer.
