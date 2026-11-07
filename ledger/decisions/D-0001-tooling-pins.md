---
id: D-0001
title: Tooling pins, Muse Code headless flags, auth, observers, hooks and skills
status: admitted
supersedes: null
---
**Decision:** run every Muse Code attempt with this command line, from the scratch repo as cwd. Its environment holds only `PATH`, the fresh `HOME`, the fresh `XDG_CONFIG_HOME`, `META_API_KEY`, `MUSE_NO_AUTO_UPDATE=1` and `TERM=dumb`:

```sh
env -i PATH="$PATH" HOME="$H" XDG_CONFIG_HOME="$X" META_API_KEY="$muse_code_key" \
  MUSE_NO_AUTO_UPDATE=1 TERM=dumb \
  muse exec --json --prompt-file packet/TASK.md --session-id "$SID" \
    --max-model-steps "$STEPS" --approval-mode never --disable-approval \
    --model muse-spark-1.3 --disable-web-tools --disable-reminders \
    -c agents.execution_capacity=1 --trust-workspace < /dev/null
```

- **Pins (measured 2026-11-07):**
  - Muse Code `1.4.14 (1.4.14-R7309.1)` (`muse --version`).
  - `muse-spark-1.3` is echoed as `"model":"muse-spark-1.3"` in two places: the streaming chat API chunks, and Muse's `run_model_configured` (`model_id`) and `run_usage` events.
- **Auth:**
  - Muse reads the key from `META_API_KEY`. It takes priority over a stored login (dev.meta.ai/docs/muse-code/auth).
  - `.env`'s `muse_code_key` is passed in under that name. No auth file is copied.
  - The stored credential, when used, lives at `$XDG_CONFIG_HOME/muse/auth.json`, or `$MUSE_AUTH_PATH` if set (the launcher at `~/.local/bin/muse`).
- **Streaming API:**
  - `POST https://api.meta.ai/v1/chat/completions`, with `Authorization: Bearer <key>` and `"stream": true`. `stream_options.include_usage` returns usage with `reasoning_tokens`.
  - `max_tokens` counts reasoning tokens. A cap of 20 returned `finish_reason: stop` with empty content; a cap of 400 returned "ok" after 312 reasoning tokens.
- **Observers:**
  - Observers are the reminder agents. `--disable-reminders` turns them off for the run. With it, a run left no `subagent/` directory. Without it, the same prompt spawned two `reminder_child` sub-agents on `muse-spark-1.3`.
  - No `settings.json` key for observers was found.
- **Tools off:**
  - `--disable-web-tools` turns off web tools.
  - `-c agents.execution_capacity=1` caps the agent tree at the root. The run accepts the key, and an unknown key refuses the run with exit 2. Whether the cap blocks a spawn is unmeasured.
- **Skills:**
  - In a fresh `HOME`, `muse skills list --source user` and `--source project` each list 0 skills.
  - The full list holds 25 `bundled:` skills and 1 `plugin:threejs:threejs`.
  - `muse skills disable <id> --scope built-in|plugin` for each of the 26 skills writes `skills.activation` into `$XDG_CONFIG_HOME/muse/settings.json`. After that, `muse skills list --enabled-only` lists 0. The projection writes that file into each fresh `XDG_CONFIG_HOME` and logs `muse skills list --enabled-only --json`.
- **Hooks:**
  - `.muse/hooks.json` takes the Claude-compatible shape: `{"hooks":{"PreToolUse":[{"matcher":"edit_file","hooks":[{"type":"command","command":"node tools/fire.mjs SKL-0003"}]}]}}`.
  - `matcher` matches tool names (`edit_file`, `read_file`, `*`). It has no path field. The hook receives on stdin `{"hook_event_name","tool_name","tool_input":{"path",…},"session_id","cwd","model",…}`, so `tools/fire.mjs` filters `tool_input.path` against the skill's globs itself.
  - The hook's environment is cleared to `HOME`, `MUSE_SESSION_ID`, `MUSE_THREAD_ID`, `PATH`, `PWD`, `SHLVL`, `TERM` and `TRACEPARENT`. `ATTEMPT_ID` and `RATCHET_SERVER` set on `muse` do not reach it. `fire.mjs` reads them from a file in the scratch repo (cwd), or the projection writes them into the command string.
- **Gemini:** pending: no `GEMINI_API_KEY` in `.env`; the `gemini-3.8-flash` PNG-in, JSON-out call was not made.
- **SubQ:** pending: no `SUBQ_API_KEY` in `.env`.

**Not this:**
- Don't use SPEC §6.12's `{ "event", "match": { "paths" }, "command" }` entry. Muse ignores it without a warning: no fire and no diagnostic.
- Don't use the plugin-manifest array `{"hooks":[{id,event,command:[argv]}]}` in `.muse/hooks.json`. It is refused with "MalformedConfig: hooks must be an object".
- Don't run `muse` with the owner's environment or `HOME`.
- Don't drop `--trust-workspace`: an untrusted workspace loads no project hooks or skills, and it disables agent delegation.
- Don't use `--yolo`, which also turns the sandbox off.

**Warrant:**
- Each of these readings comes from one run under a fresh `mktemp` `HOME` and `XDG_CONFIG_HOME`, in a throwaway git repo, on 2026-11-07.
  - The command above exits 0, writes `hello.txt`, and echoes the passed `--session-id` as the session stream id.
  - With the Claude-compatible `hooks.json`, a `PreToolUse` hook fired on `edit_file` for `core/ppu.ts`. The SPEC shape and the array shape did not fire.
  - The flag list comes from `muse exec --help` in 1.4.14.
- The exec usage event reports `children_included: false`. Observer calls, when on, are therefore missing from `run_usage`.
- False if: under the pinned version, a run with `--disable-reminders` leaves a `subagent/` directory; or a hook fires with the §6.12 shape; or `muse skills list --enabled-only` in a fresh HOME with the written `settings.json` lists a skill; or `META_API_KEY` alone fails to authenticate.

**Revisit when:** {when: "`muse --version` differs from 1.4.14 (1.4.14-R7309.1), or a model string echoes differently", then: "re-run this spike and mint a new run id"}; {when: "`GEMINI_API_KEY` or `SUBQ_API_KEY` appears in `.env`", then: "make the pending calls and supersede this entry with their echoed model strings"}.

**Residue:**
- The `muse` launcher self-updates unless `MUSE_NO_AUTO_UPDATE=1` is set.
- Muse's system context is about 25k input tokens per model call: 49.5k for 2 calls on a one-line task.
- A `PreToolUse` hook reached `http://127.0.0.1:8799` under the default sandbox (`proxy-only`): the local server logged the request. A POST from `node` was not tried.
- The name of the write-file tool is unmeasured. Only `edit_file` and `read_file` were seen.
- Bundled skills stay listed by `muse skills list`, with activation `off`. G8's "empty" is read on `--enabled-only`.
