---
id: D-0008
title: Git and JSONL are the stores, written by one writer process per file lock
status: admitted
supersedes: null
---
**Decision:** records live in `ledger/*.jsonl` (appended only through `loop/ledger.ts` under `ledger/.lock`) and in git; no database.
**Not this:** MongoDB or any service store.
**Warrant:** inspectable in Q&A with `cat` and `git log`; the lock file removes append races. False if: two appends interleave inside one line.
**Revisit when:** —
**Residue:** concurrent readers can see a file mid-append.
