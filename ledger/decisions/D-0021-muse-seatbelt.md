---
id: D-0021
title: Every Muse run is confined by a macOS seatbelt profile that denies reads outside its scratch repo
status: admitted
supersedes: null
---
**Decision:** `loop/repair.ts` runs each Muse Code process under `sandbox-exec -f <profile>` with `--disable-sandbox` passed to Muse. The profile is generated per attempt from resolved real paths:
- **Reads denied:** the repository, `$RATCHET_CACHE`, both live clones, and every other attempt's scratch directory.
- **Reads allowed:** the attempt's scratch repo, its `.env` dir, its HOME, the read-only node_modules copy, and system paths.
- **Writes allowed:** only the scratch repo, its HOME and temp.

Muse's own sandbox is off because it cannot start inside `sandbox-exec`.
**Not this:** Muse's `--workspace` flag, which roots its file tools but leaves shell reads open; `--permission-profile :read-only`, which is refused with `--approval-mode`; Muse's default sandbox alone, which confines writes but not reads (D-0018).
**Warrant:** `scripts/muse-sandbox-probe.sh`, run by the owner 2026-11-07 (evidence/muse-sandbox-probe.txt):
- default: outside-read OPEN, cache-read OPEN, inside-write ok;
- `--workspace .`: OPEN, OPEN, ok;
- seatbelt with `--disable-sandbox`: closed, closed, ok. Both `cat` reads exited 1.

False if: a seatbelt-confined attempt's MSP log shows content of a file under `$RATCHET_CACHE` or the repository.
**Revisit when:** {when: "Muse documents a workspace-only read setting", then: "measure it with the probe and prefer it over sandbox-exec"}
**Residue:**
- Network: with Muse's sandbox off, its `proxy-only` network mode is gone. Web tools stay off by `--disable-web-tools`, but the shell reaches the network. The seatbelt profile denies outbound network except localhost.
- `sandbox-exec` is deprecated by Apple, and macOS is the only platform covered.
- Agent shells cannot launch isolated Muse (HOME override refused), so real Muse attempts run from the owner's terminal.
