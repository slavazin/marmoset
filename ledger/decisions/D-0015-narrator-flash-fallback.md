---
id: D-0015
title: The narrator falls back to gemini-3.8-flash when gemini-4-argon refuses for quota
status: admitted
supersedes: null
---
**Decision:** `player/narrate.ts` asks `NARRATOR_MODEL` (`gemini-4-argon`, `thinking_level: "medium"`) and, on an HTTP 429, asks `PLAYER_MODEL` (`gemini-3.8-flash`, `"low"`) the same prompt; the spend record and the `llm` telemetry stream carry the model the service echoed, so every narration names its model.
**Not this:** no narration until Argon quota exists, or a silent model swap.
**Warrant:** on 2026-11-07 `gemini-4-argon` answered `429 Rate limit exceeded for model gemini-4-argon (limit: 0 input tokens per minute on Free Tier)` for the key in `.env`. The narration nominates and enters no gate check (D-0004), so its model changes no verdict. False if: an Argon call with this key returns 200.
**Revisit when:** {when: "the Gemini account leaves the free tier or Argon quota is granted", then: "drop the fallback"}
**Residue:** Flash narrations read differently from Argon's; a viewer sees the model per narration only in `ledger/spend.jsonl` and telemetry.
