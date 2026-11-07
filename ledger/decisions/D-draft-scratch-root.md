---
id: D-draft-scratch-root
title: Scratch repos live under $RATCHET_SCRATCH, outside the cache, repository, live clone and ledger
status: draft
supersedes: null
---
**Decision:** `loop/projection.ts` `repairPacket` materialises each scratch repo at `<scratch root>/<attempt>/`, with its `<attempt>.env/` and `<attempt>.home/` beside it and the read-only `node_modules` copy at `<scratch root>/node_modules-ro/<key>`. The scratch root is `loop/paths.ts` `scratchRoot(paths)`: `paths.scratch`, else `$RATCHET_SCRATCH`, else `DEFAULT_SCRATCH` (`<os.tmpdir()>/ratchet-scratch`). This moves SPEC §5 S8's stated `$RATCHET_CACHE/scratch/<attempt>/`.
**Not this:** a scratch root under `$RATCHET_CACHE`, where `../..` from a scratch repo is the cache root and `../../oracle` is every cached oracle frame (S8-F9). Don't set `RATCHET_SCRATCH` to a directory under the cache, the repository, `$RATCHET_LIVE` or the ledger: `scratchRoot` does not refuse it.
**Warrant:** `loop/projection.test.ts` "no relative hop (../, ../../, ../../../) from a scratch repo resolves into the cache, the repository, the live clone or the ledger" reads the test bed's scratch repo and the `pathsFromEnv({})` defaults, and the `node_modules` link's `../..`. False if: that test fails, or `pathsFromEnv` with `RATCHET_SCRATCH` unset returns a scratch root under `paths.cache`.
**Revisit when:** {when: "SPEC §5 S8's scratch path is next edited", then: "write `$RATCHET_SCRATCH` there and admit this entry"}
**Residue:**
- The move closes relative hops only. Muse's shell reads absolute paths outside the scratch repo (D-draft-muse-sandbox-scope), so an absolute `cat` of `$RATCHET_CACHE/oracle` still succeeds.
- `../` from a scratch repo is the scratch root, which holds every other live attempt's scratch, `.env` and `.home` directories; with attempts in parallel (S8 Wiggle) one attempt can read another's.
- `<attempt>.home/events.jsonl`, the attempt's own Muse event log, sits in the repairer's `HOME` and is readable to it.
