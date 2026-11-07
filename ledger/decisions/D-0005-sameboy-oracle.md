---
id: D-0005
title: SameBoy through libretro is the oracle
status: admitted
supersedes: null
---
**Decision:** the oracle is SameBoy's libretro core, run headless by `oracle/frontend.py` in lockstep on the same inputs.
**Not this:** a second LLM-written core as reference; the test ROMs alone as the only truth for play.
**Warrant:** SameBoy is Expat-licensed and its README states it passes all Blargg and Mooneye tests, with T-cycle-accurate LCD timing. False if: SameBoy fails dmg-acid2 exactly under the frontend.
**Revisit when:** {when: "the libretro build fails by 11:45 or no oracle runs by 12:15", then: "SPEC §5 S3 Wiggle"}
**Residue:** SameBoy's own inaccuracies become the target.
