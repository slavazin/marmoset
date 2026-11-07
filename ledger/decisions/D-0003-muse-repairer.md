---
id: D-0003
title: Muse Code is the repairer and writes the core; Muse Wonder consolidates
status: admitted
supersedes: null
---
**Decision:** Muse Code (headless, `muse-spark-1.3`) writes `core/` at S1 and runs every repair attempt; `muse-wonder-1.0` through the streaming API is the consolidator.
**Not this:** another vendor's agent as repairer; Wonder as the per-incident repairer.
**Warrant:** Meta's prize is the largest (SPEC §1.1); Muse Code's skills and hooks are the surfaces a skill graduates into. Long Wonder calls reason silently for 9–12 minutes and non-streamed calls time out (2026-11-06, SPEC §1.4 F4). False if: Muse Code headless cannot complete one `exec --json` run at S0.
**Revisit when:** {when: "Muse headless fails at S0", then: "the repairer becomes the streaming Meta API with a minimal edit loop (SPEC §5 S0 Wiggle)"}
**Residue:** Muse Code's internal behaviour between tool calls is outside the ledger.
