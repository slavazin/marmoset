// Shown skills and their hooks (SPEC §5 S8 "Shown skills", §6.12). Offers:
//   listSkills(dir, status)    SKL ids under skills/<status>/ with their parsed activation;
//   selectShown(ids, fires, cap, policy)  at most MAX_SHOWN ids; routing policies in force (loop/policies.ts
//                              applyPolicies) pick among them first; on overflow the least recently fired are evicted (I8);
//   hooksFor(arm, skills)      the .muse/hooks.json file (D-0001 shape): a PreToolUse command per shown skill on
//                              the skill arms, no matchers on baseline and vread-baseline.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_SHOWN } from "./gate.ts";
import { applyPolicies, type PolicyContext } from "./policies.ts";
import type { Arm, Fire, HooksFile, RepairTask } from "../src/schema.ts";

/** Arms whose scratch repo carries the shown skills and their hooks (SPEC §5 S8 projection). */
export const SKILL_ARMS: ReadonlySet<Arm> = new Set(["fast", "candidate", "placebo", "vread-ratchet"]);

export interface ShownSkill { id: string; dir: string; paths: string[]; owed: string }

/** Reads `paths:` and `owed:` from a SKILL.md frontmatter (SPEC §6.9); a minimal reader of the flow forms S9 writes. */
export function parseActivation(text: string): { paths: string[]; owed: string } {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? "";
  const pathsLine = /^\s*paths:\s*\[(.*)\]\s*$/m.exec(fm)?.[1] ?? "";
  const paths = pathsLine.split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  const owed = (/^\s*owed:\s*(.*)$/m.exec(fm)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
  return { paths, owed };
}

/** Skills under `<skillsDir>/<status>/SKL-NNNN/SKILL.md`, in id order. */
export function listSkills(skillsDir: string, status: "graduated" | "shadow"): ShownSkill[] {
  const base = join(skillsDir, status);
  if (!existsSync(base)) return [];
  return readdirSync(base).filter((d) => /^SKL-\d+$/.test(d) && existsSync(join(base, d, "SKILL.md"))).sort().map((id) => {
    const dir = join(base, id);
    return { id, dir, ...parseActivation(readFileSync(join(dir, "SKILL.md"), "utf8")) };
  });
}

/** Keeps at most `cap` ids; evicts those whose last fire is oldest, never-fired first, ties by higher id. */
export function selectShown(ids: string[], fires: Pick<Fire, "skill" | "at">[], cap = MAX_SHOWN, policy?: { task: RepairTask; ctx: PolicyContext }): string[] {
  if (policy) ids = applyPolicies(policy.task, policy.ctx).route(ids);
  if (ids.length <= cap) return [...ids];
  const last = new Map<string, string>();
  for (const f of fires) if ((last.get(f.skill) ?? "") < f.at) last.set(f.skill, f.at);
  const ranked = [...ids].sort((a, b) => {
    const la = last.get(a) ?? "", lb = last.get(b) ?? "";
    return la === lb ? a.localeCompare(b) : lb.localeCompare(la);
  });
  const keep = new Set(ranked.slice(0, cap));
  return ids.filter((id) => keep.has(id));
}

/** The tool name a skill's hook matches (D-0001: matchers key on tool names; only edit_file and read_file were seen). */
export const HOOK_MATCHER = "edit_file";

/**
 * .muse/hooks.json for `arm` (D-0001 shape): one PreToolUse matcher on HOOK_MATCHER holding one command per
 * shown skill with activation paths, on the skill arms; no matchers on baseline and vread-baseline. The path
 * filter is tools/fire.mjs's, since a matcher carries no path.
 */
export function hooksFor(arm: Arm, skills: ShownSkill[]): HooksFile {
  if (!SKILL_ARMS.has(arm)) return { hooks: {} };
  const cmds = skills.filter((s) => s.paths.length).map((s) => ({ type: "command" as const, command: `node tools/fire.mjs ${s.id}` }));
  return cmds.length ? { hooks: { PreToolUse: [{ matcher: HOOK_MATCHER, hooks: cmds }] } } : { hooks: {} };
}
