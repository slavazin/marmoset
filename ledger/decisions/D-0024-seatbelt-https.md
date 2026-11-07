---
id: D-0024
title: The seatbelt profile also allows outbound TCP 443, because a localhost-only profile blocks Muse's own model API
status: admitted
supersedes: null
---
**Decision:** `loop/confine.ts` denies `network*`, then allows localhost, outbound TCP to any host on `CONFINE_OUTBOUND_TCP_PORTS` (443), and the DNS socket `/private/var/run/mDNSResponder`.
**Not this:** localhost-only, as D-0021's residue states. Seatbelt confines the whole process tree, including Muse's own HTTPS calls to its model API, so the attempt could not run. SBPL network filters match only `localhost` or `*` as a host, so the API host cannot be named.
**Warrant:** a sandbox-exec run in an agent shell on 2026-11-07, with this profile's network rules: `curl https://example.com` returned 200 and `curl http://example.com` exited 7.
False if: a confined Muse attempt run from the owner's terminal fails to reach its API with 443 allowed, or succeeds with it removed.
**Revisit when:** {when: "Muse can route its API calls through a localhost proxy", then: "drop 443 and allow only that proxy's port"}
**Residue:**
- The repairer's shell can reach any HTTPS host. Web tools stay off through `--disable-web-tools`.
- No real Muse attempt has run under this profile yet.
