---
id: D-0011
title: Every Muse run is isolated, and long model calls stream
status: admitted
supersedes: null
---
**Decision:** every Muse Code run gets a fresh `HOME` and `XDG_CONFIG_HOME` with only auth copied in, a fresh `--session-id`, no memory files, a read-only skills directory, and a logged `muse skills list` (SPEC G8); every long model call streams with no idle timeout (`loop/llm.ts`).
**Not this:** running Muse under the owner's home directory.
**Warrant:** Muse loads `~/.claude/skills` and `~/.agents/skills`, and its observers default on (Muse Code docs, read 2026-11-06). False if: `muse skills list` in a fresh HOME lists any skill.
**Revisit when:** {when: "the observer key is documented (D-0001)", then: "turn observers off in every run"}
**Residue:** observers stay on, identical across arms, until D-0001 names their key.
