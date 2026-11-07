// SM83 (DMG CPU) disassembler for the metadata panel: decodes the instruction at an address from bus reads.
// Decodes by the opcode's x/y/z/p/q fields; covered for every opcode by ui/disasm.test.ts.

const R8 = ["B", "C", "D", "E", "H", "L", "(HL)", "A"];
const R16 = ["BC", "DE", "HL", "SP"];
const R16STK = ["BC", "DE", "HL", "AF"];
const R16MEM = ["BC", "DE", "HL+", "HL-"];
const CC = ["NZ", "Z", "NC", "C"];
const ALU = ["ADD A,", "ADC A,", "SUB ", "SBC A,", "AND ", "XOR ", "OR ", "CP "];
const ACC = ["RLCA", "RRCA", "RLA", "RRA", "DAA", "CPL", "SCF", "CCF"];
const ROT = ["RLC", "RRC", "RL", "RR", "SLA", "SRA", "SWAP", "SRL"];

const hex = (v: number, w: number) => "$" + v.toString(16).toUpperCase().padStart(w, "0");
const s8 = (v: number) => (v & 0x80 ? v - 0x100 : v);

/** Returns the mnemonic and byte length of the instruction at `addr`. */
export function disasm(read: (a: number) => number, addr: number): { text: string; len: number } {
  const op = read(addr) & 0xff;
  const n8 = () => read((addr + 1) & 0xffff) & 0xff;
  const n16 = () => n8() | ((read((addr + 2) & 0xffff) & 0xff) << 8);
  const x = op >> 6, y = (op >> 3) & 7, z = op & 7, p = y >> 1, q = y & 1;
  const one = (text: string) => ({ text, len: 1 });
  const two = (text: string) => ({ text, len: 2 });
  const three = (text: string) => ({ text, len: 3 });
  const rel = () => hex((addr + 2 + s8(n8())) & 0xffff, 4);
  const bad = one(`DB ${hex(op, 2)}`);

  if (x === 0) {
    if (z === 0) {
      if (y === 0) return one("NOP");
      if (y === 1) return three(`LD (${hex(n16(), 4)}),SP`);
      if (y === 2) return two("STOP");
      if (y === 3) return two(`JR ${rel()}`);
      return two(`JR ${CC[y - 4]},${rel()}`);
    }
    if (z === 1) return q ? one(`ADD HL,${R16[p]}`) : three(`LD ${R16[p]},${hex(n16(), 4)}`);
    if (z === 2) return one(q ? `LD A,(${R16MEM[p]})` : `LD (${R16MEM[p]}),A`);
    if (z === 3) return one(`${q ? "DEC" : "INC"} ${R16[p]}`);
    if (z === 4) return one(`INC ${R8[y]}`);
    if (z === 5) return one(`DEC ${R8[y]}`);
    if (z === 6) return two(`LD ${R8[y]},${hex(n8(), 2)}`);
    return one(ACC[y]);
  }
  if (x === 1) return one(op === 0x76 ? "HALT" : `LD ${R8[y]},${R8[z]}`);
  if (x === 2) return one(`${ALU[y]}${R8[z]}`);
  // x === 3
  switch (z) {
    case 0:
      if (y < 4) return one(`RET ${CC[y]}`);
      if (y === 4) return two(`LDH (${hex(0xff00 | n8(), 4)}),A`);
      if (y === 5) return two(`ADD SP,${s8(n8())}`);
      if (y === 6) return two(`LDH A,(${hex(0xff00 | n8(), 4)})`);
      return two(`LD HL,SP${s8(n8()) < 0 ? "" : "+"}${s8(n8())}`);
    case 1:
      if (!q) return one(`POP ${R16STK[p]}`);
      return one(["RET", "RETI", "JP HL", "LD SP,HL"][p]);
    case 2:
      if (y < 4) return three(`JP ${CC[y]},${hex(n16(), 4)}`);
      if (y === 4) return one("LD (C),A");
      if (y === 5) return three(`LD (${hex(n16(), 4)}),A`);
      if (y === 6) return one("LD A,(C)");
      return three(`LD A,(${hex(n16(), 4)})`);
    case 3:
      if (y === 0) return three(`JP ${hex(n16(), 4)}`);
      if (y === 1) {
        const cb = n8(); const cx = cb >> 6, cy = (cb >> 3) & 7, cz = cb & 7;
        if (cx === 0) return two(`${ROT[cy]} ${R8[cz]}`);
        return two(`${["", "BIT", "RES", "SET"][cx]} ${cy},${R8[cz]}`);
      }
      if (y === 6) return one("DI");
      if (y === 7) return one("EI");
      return bad;
    case 4:
      return y < 4 ? three(`CALL ${CC[y]},${hex(n16(), 4)}`) : bad;
    case 5:
      if (!q) return one(`PUSH ${R16STK[p]}`);
      return p === 0 ? three(`CALL ${hex(n16(), 4)}`) : bad;
    case 6:
      return two(`${ALU[y]}${hex(n8(), 2)}`);
    default:
      return one(`RST ${hex(y * 8, 2)}`);
  }
}
