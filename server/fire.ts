// POST /fire (SPEC §5 S8, §6.12): receives a hook's {skill, attempt, path, owed} from tools/fire.mjs and appends
// one Fire to ledger/fires.jsonl through loop/ledger.ts; the UI reads fires only from the ledger tail.

import { appendNew, runId } from "../loop/ledger.ts";
import type { Fire } from "../src/schema.ts";

const SKL = /^SKL-\d+$/;
const ATT = /^ATT-\d+$/;
/** Longest path or owed string kept on a fire, in characters; the ledger line stays under 4 KB. */
export const FIRE_FIELD_MAX = 400;

/** Validates a hook body and appends its Fire; throws on a body without a SKL id and an ATT id. */
export function recordFire(body: unknown, ledger: string): Fire {
  const b = (body ?? {}) as Record<string, unknown>;
  const skill = String(b.skill ?? ""), attempt = String(b.attempt ?? "");
  if (!SKL.test(skill) || !ATT.test(attempt)) throw new Error("fire needs skill SKL-NNNN and attempt ATT-NNNN");
  return appendNew<Fire>("fires.jsonl", "FIR", (id) => ({
    id, at: new Date().toISOString(), run: runId(), skill, attempt,
    path: String(b.path ?? "").slice(0, FIRE_FIELD_MAX), owed: String(b.owed ?? "").slice(0, FIRE_FIELD_MAX),
  }), ledger);
}
