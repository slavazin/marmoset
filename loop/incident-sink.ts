// The ledger-backed IncidentSink (lockstep/incidents.ts interface): it replaces JsonlIncidentSink so that
// ledger/incidents.jsonl is appended only through loop/ledger.ts (AGENTS.md rule 2).

import { all, appendNew, ledgerDir } from "./ledger.ts";
import type { IncidentSink } from "../lockstep/incidents.ts";
import type { Incident } from "../src/schema.ts";

export class LedgerIncidentSink implements IncidentSink {
  readonly dir: string;
  constructor(dir = ledgerDir()) { this.dir = dir; }
  open(): Incident[] { return all<Incident>("incidents.jsonl", this.dir).filter((i) => i.status === "open"); }
  record(make: (id: string) => Incident): Incident { return appendNew("incidents.jsonl", "INC", make, this.dir); }
}
