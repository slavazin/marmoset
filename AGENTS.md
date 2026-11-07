# Agent instructions — Ratchet

Ratchet is a Game Boy emulator that an agent repairs while another agent plays it. A failure found in play becomes a versioned change, and a change is kept only if it proves out on held-out hardware behaviour.

This file is a map; every rule lives in the file it points to.

| What | Where |
|---|---|
| The spec: context, terms, north star, slices, schemas, schedule | [SPEC.md](SPEC.md) |
| How to write every durable file: skills, decisions, beliefs, reports, code prose | [LANGUAGE.md](LANGUAGE.md) |
| How the sessions work: orchestrator, implementers, cold readers | [WORKFLOW.md](WORKFLOW.md); `.claude/agents/` |
| The settled decisions | `ledger/decisions/` |
| The GCE doctrine the terms cite ("GCE V2 § n"), a pre-existing input | `docs/gce/GCE-DOCTRINE-V2.md` |

## Binding rules
1. **Types live in `src/schema.ts`** (from SPEC §6). Import them; a shape change is the orchestrator's.
2. **Ledgers append; registers are corrected in place.** `ledger/*.jsonl` is appended only through `loop/ledger.ts`. Decision, belief, skill and tombstone files are written once by their named writer (SPEC §5) and change only by status flip or supersession. `ledger/findings.md` and `ledger/provenance.json` are registers. The spec, `splits.json` and `skills/` are registers. Retirement is a status flip with a successor pointer, never a deletion (SPEC §2.3).
3. **The machine nominates; the gate or the owner ratifies.** No code path graduates a repair or a skill except `loop/gate.ts` under its rule constants, fixed before the run (SPEC G4). The gate commits to `core-live` in the live clone; build merges go to `main` (D-0006).
4. **The repairer works in a scratch repo built by `loop/projection.ts`**, test-asserted, and the gate accepts only its `core/**` diff. The consolidator reads only `consolidatorView`. Oracle source, other families' H and V readings and the gate rule reach neither (SPEC G7).
5. **V is read once**, by `loop/vread.ts` at curve freeze (SPEC G6).
6. **Every Muse Code run is isolated** (SPEC G8, D-0011).
7. **No secret is printed.** Keys come from `.env` (SPEC §7.4).
8. **New work only.** No third-party code beyond the tools SPEC §7.1 names, used and never copied; commit no test ROM.
9. **Stage your own files by path.** Never `git add -A` or `git stash`; worktrees share the repository.
