---
id: D-0018
title: Muse's default sandbox confines shell writes to the workspace and leaves reads open
status: admitted
supersedes: null
---
**Decision:** read G7's "the repairer runs in a scratch repo holding only …" as holding for writes and relative paths, and not for absolute reads: D-0001's command line, unchanged, is the repairer's command line, and every repair verdict's residue states that the repairer's shell reads absolute paths outside the scratch repo. This entry appends a residue to D-0001 and does not edit it.
**Not this:**
- Don't claim the scratch repo hides the oracle cache, the ledger or the repository from Muse: an absolute `cat` reads them.
- Don't add `--permission-profile`, `--workspace` or a `-c` sandbox key to `museArgs` on a reading of help text or binary strings alone; an unmeasured confinement flag reads as isolation it does not give.
- Don't drop the default sandbox (`--yolo`, `--disable-sandbox`): it is what refuses the writes below.
**Warrant:**
- On 2026-11-07, Muse Code 1.4.14 (1.4.14-R7309.1), one run of D-0001's command line through `loop/repair.ts` `runRepair` with `museCli`, `muse-spark-1.3` echoed, exit 0, in a scratch repo built by `repairPacket` on the `loop/fixtures/harness.ts` bed (scratch root under `os.tmpdir()`), with a probe prompt in `packet/TASK.md`. Muse's shell returned:
  - `cat <bed cache>/oracle/canary.txt` (absolute): the canary's text. **Read outside the workspace: allowed.**
  - `echo escaped > ../escape.txt`: `Operation not permitted`; no file at `../escape.txt`. **Relative write outside: refused.**
  - `ls -la ~`: the fresh `HOME` (`.config`, `.local`, `events.jsonl`).
  - `echo poisoned > <bed cache>/oracle/poison.txt` (absolute): `Operation not permitted`; no file written. **Absolute write outside: refused.**
  - `ls /Users/slavazinevich/GenDev/marmoset` and `cat …/package.json`: the repository's top-level names and `package.json` text. **Reads of the repository: allowed.**
- False if: under 1.4.14 with D-0001's flags, an absolute `cat` of a file outside the scratch repo fails, or a write outside it succeeds.
**Revisit when:** {when: "a Muse run under a fresh HOME may be made to test `--permission-profile`, `--workspace` and the `allow_outside_workspace` / `workspace_root_only` settings", then: "measure whether one confines shell reads to the workspace; if it does, add it to `museArgs` with a test and supersede this entry"}; {when: "`muse --version` differs from 1.4.14 (1.4.14-R7309.1)", then: "re-run the probe"}
**Residue:**
- The search for a read-confining setting is not measured. The implementer's shell refused the fresh-HOME `muse exec` command needed to test candidates (S8b report). Strings in the 1.4.14 binary name `--permission-profile`, a `:read-only` built-in profile, and `allow_outside_workspace` and `workspace_root_only` fields; none was run.
- With reads open, the repairer can read the real oracle cache, every cached reading, the ledger, `loop/gate.ts`'s rule and the H and V families' ROMs by absolute path. G7's independence then rests on the gate's diff checks and on the packet not naming those paths, not on the scratch repo's file list.
