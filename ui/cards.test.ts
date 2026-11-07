import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonl, Fold } from "../server/events.ts";
import { verdictCard } from "./cards/verdict-card.ts";
import { incidentCard } from "./cards/incident-card.ts";
import { decidingCheck, fmtReading } from "./format.ts";
import { decodeGrey } from "./fixtures/png.ts";
import type { Verdict, Incident, Attempt } from "../src/schema.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const cardsDir = join(here, "cards");

/** Numeric literals in source after comments, import lines and string-free identifiers are set aside. */
export function numericLiterals(src: string): string[] {
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/^\s*import .*$/gm, "");
  return code.match(/(?<![\w$.])(?:0[xob][0-9a-f_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)n?(?![\w$])/gi) ?? [];
}

const load = <T>(file: string): T[] => {
  const f = new Fold();
  for (const r of parseJsonl(readFileSync(join(here, "fixtures/ledger", file), "utf8")).records) f.apply(r);
  return f.all() as unknown as T[];
};

test("ui/cards/*.ts card templates contain no numeric literal", () => {
  const files = readdirSync(cardsDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  assert.ok(files.length >= 2, "verdict and incident card templates exist");
  for (const f of files) assert.deepEqual(numericLiterals(readFileSync(join(cardsDir, f), "utf8")), [], `${f} carries a figure literal`);
});

test("the numeric-literal grep flags a planted literal and passes identifiers with digits", () => {
  assert.deepEqual(numericLiterals("const s = `${v.pass} of 15 · ${x0}`;"), ["15"]);
  assert.deepEqual(numericLiterals("const p = 0.951; // 7 in a comment"), ["0.951"]);
  assert.deepEqual(numericLiterals("import x from './a1.ts';\nconst y = x0 + v.y1;"), []);
});

test("a verdict card from ledger verdicts.jsonl stamps its decision and prints the deciding check's reading from the record", () => {
  const verdicts = load<Verdict>("verdicts.jsonl");
  const attempts = new Map(load<Attempt>("attempts.jsonl").map((a) => [a.id, a]));
  assert.ok(verdicts.some((v) => v.decision === "GRADUATE") && verdicts.some((v) => v.decision === "REFUSE"));
  for (const v of verdicts) {
    const html = verdictCard(v, attempts.get(v.subject.id), undefined);
    assert.match(html, v.decision === "GRADUATE" ? />GRADUATED</ : />REFUSED</);
    const c = decidingCheck(v)!;
    assert.ok(html.includes(c.name), `${v.id} names its deciding check`);
    const reading = fmtReading(c.reading).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    assert.ok(html.includes(reading), `${v.id} prints its deciding reading`);
  }
  const refused = verdicts.find((v) => v.id === "VER-0001")!;
  assert.equal(decidingCheck(refused)!.name, "H-no-regress", "a REFUSE is decided by its first failing check");
});

test("an incident's evidence PNGs (core.png, oracle.png) differ in exactly the incident record's pixel count", () => {
  const inc = load<Incident>("incidents.jsonl").find((i) => i.id === "INC-0001")!;
  const dir = join(here, "fixtures", inc.files.dir);
  const a = decodeGrey(readFileSync(join(dir, "core.png")));
  const b = decodeGrey(readFileSync(join(dir, "oracle.png")));
  assert.equal(a.width * a.height, b.grey.length);
  let n = 0;
  for (let i = 0; i < a.grey.length; i++) if (a.grey[i] !== b.grey[i]) n++;
  assert.equal(n, inc.pixels);
  assert.equal(inc.status, "repaired", "a status record flips the incident; the last one written wins");
  assert.match(incidentCard(inc, false), new RegExp(`${inc.pixels} px`));
});
