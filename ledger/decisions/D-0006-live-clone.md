---
id: D-0006
title: The runtime core evolves in a live clone on branch core-live
status: admitted
supersedes: null
---
**Decision:** the gate commits to `core-live` in `../ratchet-live`, seeded by fast-forward to `main` once S1 merges; `main` receives `core-live` once, at S11, and no build slice edits `core/` after S8 starts.
**Not this:** slice branches, which merge to `main` through the orchestrator.
**Warrant:** gate commits and build merges on one branch interleave from 13:00 onward. False if: no build merge happens after S8 lands.
**Revisit when:** {when: "S8 lands after 15:00", then: "re-derive: gate commits on main"}
**Residue:** `main`'s `core/` lags the live core until S11.
