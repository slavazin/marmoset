// SubQ forecast sensors on a fast-loop attempt (S17b). They nominate, never decide (D-0004): nothing in the loop reads
// a forecast, and loop/sensors.test.ts asserts a forecast leaves every gate check unchanged. Offers:
//   senseAttempt(o)  called once where the attempt starts (loop/fast.ts): asks PASS_QUESTION ("will this repair pass
//                    the gate?") in the background from the incident state and the task; returns { after } ;
//   after(o)         called once where the attempt ends: waits for the pass forecast, then, when the attempt has a
//                    diff, asks MECHANISM_QUESTION ("does this diff fix the mechanism or only mask the symptom?") from
//                    the diff, the incident evidence and the regwrites.
// Each answer becomes a status record on ledger/attempts.jsonl (fields FORECAST_FIELDS, loop/subq.ts), a `loop`
// record (forecast.pass, forecast.mechanism), an `llm` record and a router spend record (loop/route.ts askSubq).
// Neither function throws into the loop path; with no client (loop/subq.ts subqClient(): no key, or a test process
// without setSubqClient) they make no call and write nothing. loop/route.ts routeCalibrationOf scores both.

import { status } from "./ledger.ts";
import { askSubq, buildState, evidenceImages, answerProbs } from "./route.ts";
import { FORECAST_FIELDS, SUBQ_MODEL, subqClient, type SubqClient, type SubqQuestion } from "./subq.ts";
import { tlog } from "../src/telemetry.ts";
import type { LoopPaths } from "./paths.ts";
import type { Incident, RepairTask } from "../src/schema.ts";

/** Characters of the attempt's diff the mechanism question's state carries; the rest is cut and the cut noted. */
export const MECHANISM_DIFF_CHARS = 60_000;

export const PASS_KEY = "pass";
export const PASS_QUESTION: SubqQuestion = { type: "noul", instructions: "Will a repair attempt on this incident pass the gate: replay the incident's trace to match the hardware reference and regress no held-out test suite?",
  criteria: { true: "the divergence has one clear, local cause in the emulator core that a short edit can fix", false: "the cause is unclear, spread across subsystems, or likely to break held-out timing tests when fixed" } };

export const MECHANISM_KEY = "mechanism";
export const MECHANISM_QUESTION: SubqQuestion = { type: "noul", instructions: "Does this diff fix the mechanism that produced the divergence, rather than only masking the symptom?",
  criteria: { true: "the diff changes the timing or state logic that the register writes and the evidence implicate, for every scene and line", false: "the diff special-cases the symptom: a constant, a scene- or line-specific branch, or an edit away from the implicated logic" } };

export interface AttemptSensing { after(o: { diff: string }): Promise<void> }
export interface SenseOpts { paths: Pick<LoopPaths, "root" | "ledger">; attempt: string; incident: Incident; task: RepairTask; client?: SubqClient | null }

async function ask(client: SubqClient, field: string, key: string, q: SubqQuestion, state: Record<string, unknown>, o: SenseOpts, withImages: boolean): Promise<void> {
  const images = withImages ? evidenceImages(o.incident, o.paths.root) : [];
  const req = { model: SUBQ_MODEL, state, questions: { [key]: q }, ...(images.length ? { images } : {}) };
  const { reply, usd } = await askSubq(client, req, { ledger: o.paths.ledger, subject: { incident: o.incident.id, attempt: o.attempt }, purpose: field });
  const a = reply.body?.answers?.[key];
  if (reply.error || !a) { tlog("loop", "forecast.failed", { attempt: o.attempt, field, error: reply.error ?? `no ${key} answer` }); return; }
  const value = { ...answerProbs(a), ms: reply.wall_ms, usd: Number(usd.toPrecision(4)) };
  status("attempts.jsonl", o.attempt, field, value, o.paths.ledger);
  tlog("loop", field === FORECAST_FIELDS.pass ? "forecast.pass" : "forecast.mechanism", { attempt: o.attempt, incident: o.incident.id, ...value, cached: !!reply.cached, model: reply.body?.model ?? "" });
}

const quiet = (p: Promise<void>, attempt: string, field: string): Promise<void> =>
  p.catch((e) => { try { tlog("loop", "forecast.failed", { attempt, field, error: (e as Error).message }); } catch { /* telemetry is best-effort */ } });

const NOOP: AttemptSensing = { after: async () => {} };

/** See the file header. */
export function senseAttempt(o: SenseOpts): AttemptSensing {
  let client: SubqClient | null;
  try { client = o.client === undefined ? subqClient() : o.client; } catch { client = null; }
  if (!client) return NOOP;
  const c = client;
  const base = () => buildState(o.incident, o.paths.root);
  const task = { arm: o.task.arm, skills: o.task.skills, policies: o.task.policies ?? [], budget: o.task.budget };
  const pass = quiet((async () => ask(c, FORECAST_FIELDS.pass, PASS_KEY, PASS_QUESTION, { ...base(), task }, o, true))(), o.attempt, FORECAST_FIELDS.pass);
  return {
    async after({ diff }) {
      await pass;
      if (!diff?.trim()) return;
      const cut = diff.length > MECHANISM_DIFF_CHARS;
      await quiet((async () => ask(c, FORECAST_FIELDS.mechanism, MECHANISM_KEY, MECHANISM_QUESTION,
        { ...base(), diff: diff.slice(0, MECHANISM_DIFF_CHARS), ...(cut ? { diff_note: `cut at ${MECHANISM_DIFF_CHARS} of ${diff.length} characters` } : {}) }, o, true))(), o.attempt, FORECAST_FIELDS.mechanism);
    },
  };
}
