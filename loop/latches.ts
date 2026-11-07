// Latches into hooks (SPEC §2.3 latch, hook; §5 S9; §6.12; D-0001). `compileLatches(skillsDir, root)` compiles every
// graduated skill's activation into `<root>/.muse/hooks.json` in D-0001's Claude-compatible shape: one PreToolUse
// matcher on HOOK_MATCHER ("edit_file", loop/shown.ts) holding `node tools/fire.mjs SKL-NNNN` per graduated skill with
// activation paths. The path filter is tools/fire.mjs's, since a matcher names a tool and carries no path. The same
// shape reaches each scratch repo through loop/projection.ts (shown.ts hooksFor). Tests: loop/latches.test.ts.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hooksFor, listSkills } from "./shown.ts";
import type { HooksFile } from "../src/schema.ts";

/** The hooks file for every graduated skill under `skillsDir`. */
export function latchHooks(skillsDir: string): HooksFile {
  return hooksFor("fast", listSkills(skillsDir, "graduated"));
}

/** Writes `<root>/.muse/hooks.json` from latchHooks; returns the path and the file. */
export function compileLatches(skillsDir: string, root: string): { path: string; hooks: HooksFile } {
  const hooks = latchHooks(skillsDir);
  mkdirSync(join(root, ".muse"), { recursive: true });
  const path = join(root, ".muse", "hooks.json");
  writeFileSync(path, JSON.stringify(hooks, null, 2) + "\n");
  return { path, hooks };
}
