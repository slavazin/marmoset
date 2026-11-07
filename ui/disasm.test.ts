import { test } from "node:test";
import assert from "node:assert/strict";
import { disasm } from "./disasm.ts";

const at = (bytes: number[]) => (a: number) => bytes[a] ?? 0;

test("disasm decodes every opcode and CB opcode to a mnemonic of length 1..3 bytes", () => {
  for (let op = 0; op < 0x100; op++) {
    const r = disasm(at([op, 0x34, 0x12]), 0);
    assert.ok(r.text.length > 0 && r.len >= 1 && r.len <= 3, `op ${op.toString(16)}`);
    const cb = disasm(at([0xcb, op]), 0);
    assert.equal(cb.len, 2);
  }
});

test("disasm prints known SM83 encodings", () => {
  assert.deepEqual(disasm(at([0x00]), 0), { text: "NOP", len: 1 });
  assert.deepEqual(disasm(at([0xf0, 0x44]), 0), { text: "LDH A,($FF44)", len: 2 });
  assert.deepEqual(disasm(at([0xc3, 0x50, 0x01]), 0), { text: "JP $0150", len: 3 });
  assert.deepEqual(disasm(at([0x20, 0xfa]), 0), { text: "JR NZ,$FFFC", len: 2 });
  assert.deepEqual(disasm(at([0x76]), 0), { text: "HALT", len: 1 });
  assert.deepEqual(disasm(at([0x22]), 0), { text: "LD (HL+),A", len: 1 });
  assert.deepEqual(disasm(at([0xcb, 0x7c]), 0), { text: "BIT 7,H", len: 2 });
  assert.deepEqual(disasm(at([0xcb, 0x37]), 0), { text: "SWAP A", len: 2 });
  assert.deepEqual(disasm(at([0xff]), 0), { text: "RST $38", len: 1 });
  assert.equal(disasm(at([0xd3]), 0).text, "DB $D3");
});
