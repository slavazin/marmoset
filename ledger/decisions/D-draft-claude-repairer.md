---
id: D-draft-claude-repairer
title: RUN-0005 runs the loop with Claude Code as repairer and consolidator, under seatbelt with the owner's HOME
status: draft
supersedes: null
---
**Decision:** S23 takes these Wiggle choices:
- **Runner.** `RATCHET_REPAIRER=claude` makes every spawn site use `loop/claude.ts` `claudeCli`: fast attempts, trial arms, V-read arms and `loop/once.ts`. The consolidator uses `claudeChat`. `runs/<run>/conditions.json` records `repairer: {runner, model}`, and Muse is recorded by omission. `--resume` refuses a runner or model change in either direction, and `loop/vread.ts` refuses a runner that differs from the one in conditions.json.
- **Command.** `claude -p <prompt naming packet/TASK.md> --output-format stream-json --verbose --model claude-sonnet-5 --max-turns MAX_STEPS --session-id <uuid> --no-session-persistence --setting-sources "" --strict-mcp-config --disable-slash-commands --tools Bash,Read,Edit,Write,Glob,Grep --dangerously-skip-permissions`. The cwd is the scratch repo, stdin is /dev/null and the wall is ATTEMPT_WALL_S. The prompt names TASK.md, which is the same task file the Muse runner gets.
- **Model.** `claude-sonnet-5`. The CLI rejects the id `claude-sonnet-5-5` ("unrecognized_model"). The alias `sonnet` echoes `claude-sonnet-5`, so the run pins that full id.
- **Isolation.** The CLI authenticates through the login keychain, which needs the owner's real HOME, USER and LOGNAME. With a fresh HOME, or a fresh CLAUDE_CONFIG_DIR, it answers "Not logged in". So HOME is the owner's, and the seatbelt profile (`loop/confine.ts`, D-0021 shape) gains a `claude` block. That block denies reads of the repositories' parent dir (every sibling clone and worktree), `~/.cache`, and the `~/.claude` entries in `CLAUDE_HISTORY_DIRS` (projects, history, sessions, skills, plugins, settings.json, CLAUDE.md and others). It allows writes to `~/.claude`, `~/.claude.json*` and `~/Library/Caches` so the CLI's own state works, then denies writes to the history entries again. Each attempt starts with a fresh session id, no persistence, no user or project settings, no skills, no MCP, and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.
- **Spend.** Claude models price at 0 (`loop/llm.ts` `isSubscriptionModel`). A consolidator spend record carries `billing: "subscription"`, and the repairer's usage stays in `Attempt.spent`. RUN-0005 joins no other run's spend guard because it spends no Meta dollars.

**Not this:**
- A fresh HOME per attempt, as the Muse runner has (D-0001). The CLI cannot authenticate without the keychain.
- `--bare`. It reads no OAuth or keychain credentials, only `ANTHROPIC_API_KEY`, and there is no API key.
- Copying the OAuth token into the attempt's HOME. The repairer could then read the token and send it out over port 443.

**Warrant:**
- Owner approval, 2026-11-07: run further on the owner's Claude subscription with a comparable model, knowing it is not apples-to-apples with the Muse runs.
- `evidence/s23/claude-sandbox-probe.txt` (`scripts/claude-sandbox-probe.ts`): the model run authenticated and wrote inside the scratch repo. Under the same profile, these reads came back closed: the worktree, the main checkout's AGENTS.md and oracle/, the live clone, the run cache, ~/.cache, the repositories' parent dir, ~/.claude/projects, ~/.claude/history.jsonl and the ROM dir. A write to the worktree was blocked. False if: a rerun of the probe reads OPEN on any of them.
- Residue: a new file under `~/.claude` that is not in `CLAUDE_HISTORY_DIRS` can be written (probe: claude-settings-write OPEN on `settings.json.probe`). HTTPS to any host stays open (D-0024). Both runners run under the same seatbelt shape, but the runners differ in model and in agent harness, so RUN-0005's readings compare with RUN-0001's game-for-game, not runner-for-runner.

**Revisit when:**
- {when: "the Meta budget is restored", then: "decide whether RUN-0005's readings stand beside RUN-0001's or a Muse rerun replaces them"}
- {when: "an API key replaces the subscription", then: "use --bare with ANTHROPIC_API_KEY and a fresh HOME, and drop the claude seatbelt block"}
