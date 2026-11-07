# Ratchet spec pack

This pack is the input for the event repo, written before the AIE Code Summit 2026 Hackathon (2026-11-07). It is copied into the new public repo at S0 (WORKFLOW.md, Setup).

| File | Goes to | What it is |
|---|---|---|
| `SPEC.md` | repo root | context, terminology, north star, nice-to-haves, slices, schemas, schedule, risks |
| `LANGUAGE.md` | repo root | authoring rules for every durable file |
| `WORKFLOW.md` | repo root | orchestrator, implementers, cold readers; dispatch, merge, checkpoints |
| `AGENTS.md`, `CLAUDE.md` | repo root | the map every session reads |
| `agents/implementer.md`, `agents/cold-reader.md` | `.claude/agents/` | agent definitions |

Also copy the GCE doctrine (`GCE-DOCTRINE-V2.md`, the owner's own document) to `docs/gce/`, and list it in the event repo's README as a pre-existing input. This README is pack-only and is not copied.
