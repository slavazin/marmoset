// S19 cabinet: the gate lamps read the verdict record, the look switch's URL parameter, the spend gauge reads the
// meter, and the redesigned index.html keeps every id main.ts, replay.ts, telemetry-led.ts and present/mount.ts look up.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonl, Fold } from "../server/events.ts";
import { gateLamps, gateBanks, latestByKind, latestVerdict } from "./cards/gate-lamps.ts";
import { lookFromParam } from "./fx.ts";
import { historyTab } from "./present/history.ts";
import { readHistory } from "../server/history.ts";
import type { Verdict } from "../src/schema.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const verdicts = (() => {
  const f = new Fold();
  for (const r of parseJsonl(readFileSync(join(here, "fixtures/ledger/verdicts.jsonl"), "utf8")).records) f.apply(r);
  return f.all() as unknown as Verdict[];
})();

test("gate lamps list the verdict's check names in record order, then the outcome lamp lit by the decision", () => {
  for (const v of verdicts) {
    const html = gateLamps(v);
    const names = [...html.matchAll(/<li class="glamp (pass|fail)"[^>]*><i><\/i><span>([^<]*)<\/span>/g)].map((m) => [m[2], m[1]]);
    const outcome = v.subject.kind === "attempt" ? "merge" : "graduate";
    assert.deepEqual(names, [...v.checks.map((c) => [c.name, c.pass ? "pass" : "fail"]), [outcome, v.decision === "GRADUATE" ? "pass" : "fail"]], v.id);
    assert.match(html, v.decision === "GRADUATE" ? />GRADUATED</ : />REFUSED</);
  }
  assert.match(gateLamps(undefined), /no verdict in ledger\/verdicts\.jsonl/, "no verdict prints the empty state, never a lit lamp");
  assert.doesNotMatch(gateLamps(undefined), /glamp/);
});

test("the lamps show the latest verdict by at, not the last delivered", () => {
  const [a, b] = verdicts;
  assert.equal(latestVerdict([b, a])!.id, a.at > b.at ? a.id : b.id);
  assert.equal(latestVerdict([]), undefined);
});

test("the gate bay shows one bank per subject kind, the latest attempt verdict first, then the latest skill verdict", () => {
  const vs = latestByKind(verdicts);
  assert.deepEqual(vs.map((v) => v.subject.kind), ["attempt", "skill"]);
  for (const v of vs) assert.equal(v.id, latestVerdict(verdicts.filter((x) => x.subject.kind === v.subject.kind))!.id);
  assert.equal((gateBanks(vs).match(/class="gbank"/g) ?? []).length, vs.length);
  assert.match(gateBanks([]), /no verdict in ledger/);
});

test("?look= aliases: compact and handheld pick the handheld look, wide and cabinet the cabinet look, anything else none", () => {
  assert.equal(lookFromParam("compact"), "handheld");
  assert.equal(lookFromParam("handheld"), "handheld");
  assert.equal(lookFromParam("wide"), "cabinet");
  assert.equal(lookFromParam("cabinet"), "cabinet");
  assert.equal(lookFromParam(null), null);
  assert.equal(lookFromParam("Compact"), null);
});

test("the History spend gauge fills to the meter's usd over stop_usd and marks ask_usd, from the record", async () => {
  const root = join(here, "..");
  const h = await readHistory({ ledger: join(root, "ui/fixtures/ledger"), runs: join(root, "ui/fixtures/runs"), skills: join(root, "skills"), live: join(root, "no-live-clone"), registers: join(root, "ledger"), root });
  const meter = { priced_usd: 1, attempts_usd: 1, attempts_n: 1, calls_usd: 0, calls_n: 0, offset_usd: 0, owner_read_usd: null, override: null, usd: 30, source: "priced", ask_usd: 40, stop_usd: 120 };
  const html = historyTab({ ...h, meter } as never);
  assert.match(html, /class="gauge "/, "below ask: no level class");
  assert.match(html, /class="gfill" style="width:25%"/);
  assert.match(html, /class="gmark" style="left:33%"/);
  const over = historyTab({ ...h, meter: { ...meter, usd: 50 } } as never);
  assert.match(over, /class="gauge ask"/);
  assert.doesNotMatch(historyTab({ ...h, meter: { ...meter, stop_usd: 0 } } as never), /class="gauge/, "no stop line, no gauge");
});

test("index.html keeps every id the UI scripts look up", () => {
  const html = readFileSync(join(here, "index.html"), "utf8");
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const created = new Set<string>();
  const wanted = new Set<string>();
  for (const f of ["main.ts", "replay.ts", "telemetry-led.ts", "fx.ts"]) {
    const src = readFileSync(join(here, f), "utf8");
    for (const m of src.matchAll(/\bid="([\w-]+)"/g)) created.add(m[1]);
    for (const m of src.matchAll(/\$(?:<\w+>)?\("([\w-]+)"\)/g)) wanted.add(m[1]);
  }
  assert.ok(wanted.size > 20, "the grep finds the lookups");
  const missing = [...wanted].filter((id) => !ids.has(id) && !created.has(id));
  assert.deepEqual(missing, []);
  for (const id of ["gatelamps", "cabinet", "logmod", "gridtoggle", "looktoggle"]) assert.ok(ids.has(id), id);
  assert.ok(readdirSync(here).includes("style.css"));
});
