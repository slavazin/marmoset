---
id: D-0009
title: The base, T, H and V split, with V read once
status: admitted
supersedes: null
---
**Decision:** families split per SPEC §5 S2 into base, T, H and V in `splits.json`; V's list is frozen when S2 merges and is read once, by `loop/vread.ts` at curve freeze.
**Not this:** a V list adjusted after any reading of it.
**Warrant:** a number read many times is tuned. False if: `runs/<id>/vread.lock` holds more than one record.
**Revisit when:** — (V's list never changes)
**Residue:** the designer chose V after reading the pre-event F2 failures.
