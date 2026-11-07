---
id: D-0019
title: The Color Game Boy is a second difficulty tier, run as its own run on its own live clone
status: admitted
supersedes: null
---
**Decision:** CGB support enters as a second tier. `oracle/` runs SameBoy in CGB mode on request (`load` with `model: "CGB"`), and the scorer compares RGB frames for CGB ROMs. The tier's families live in `splits-cgb.json`, with its own base, T, H and V, and its V frozen when that file first merges. A CGB core is bootstrapped by Muse on branch `core-cgb` in a second live clone, `../ratchet-live-cgb`, cut from `core-live`, and its run is RUN-0002. RUN-0001's splits, V and `core-live` are untouched.
**Not this:** adding CGB families to `splits.json`, which changes V after S2 merged (D-0009); bootstrapping CGB inside `core-live`, which breaks D-0006 for RUN-0001.
**Warrant:** owner ratified 2026-11-07, choosing the CGB tier as the ambition upgrade. SameBoy emulates the CGB, and `cgb-acid2` and `cgb-acid-hell` are in game-boy-test-roms v7.0. False if: a CGB family name appears in `splits.json`, or a commit on `core-live` comes from the CGB bootstrap.
**Revisit when:** {when: "the CGB core fails cgb-acid2 after its bootstrap rounds by 15:00", then: "show the CGB tier as built-but-unrun, with its readings, and do not open RUN-0002"}
**Residue:** RUN-0002 starts later than RUN-0001, so it has fewer generations; its curve is not comparable point for point.
