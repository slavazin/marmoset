import { test } from "node:test";
import assert from "node:assert/strict";
import * as schema from "./schema.ts";

test("src/schema.ts loads and exports the §6.0 id prefixes and the §6.17 RAM contract", () => {
  assert.deepEqual([...schema.ID_PREFIXES], ["INC", "ATT", "VER", "OBS", "SKL", "FIR", "D", "BEL", "TRC", "RUN", "SPT", "STR", "POL"]);
  assert.equal(schema.GAME_RAM.counter, 0xc0f0);
});
