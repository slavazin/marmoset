// The frame producer the gate's isolated replay runs (loop/replay-seam.ts isolatedReplayer). It is started as
// `node --permission --allow-fs-read=<core dir> --allow-fs-read=<rom> --allow-fs-read=<this file> frames-child.mjs
//  <coreDir> <romPath> <align> <from> <to> <inputs JSON> <ramAddr> <ramLen>`, so the core under test can read only
// its own directory and the ROM: never the oracle cache, the evidence dir or the admitted traces (S5-F6).
// For n = 1 … to it sets the mask held at n-1 and runs to counter n (align counter) or one frame (align frame);
// at counter n the frame it writes is the one completed before the VBlank that wrote n, with the counter live
// only after its first change: a copy of lockstep/align.ts counterStepper, the rule's home, which this child
// cannot read under --permission;
// for n ≥ from it writes one JSON line {n, ram, frame} (hex game RAM, base64 shades), or {n, stall: true} and exits.
// S22 extensions: <ramAddr> may be a JSON list of {addr, len} ranges (a games-registry map, lockstep/games.ts), whose
// bytes `ram` concatenates; the counter is then read at the first range's address. An optional 9th argument is a
// start directory (also passed to --allow-fs-read) holding core.bin, the start state in the core's snapshot format
// (lockstep/start-state.ts coreSnapshotOf), and check.json {pc, wram_hex}: the child restores core.bin and exits
// with {error} unless the core then reads that PC and that WRAM, so a core whose snapshot layout differs refuses.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [coreDir, romPath, align, fromS, toS, inputsS, ramAddrS, ramLenS, startDir] = process.argv.slice(2);
const from = Number(fromS), to = Number(toS);
const ranges = ramAddrS.startsWith("[") ? JSON.parse(ramAddrS) : [{ addr: Number(ramAddrS), len: Number(ramLenS) }];
const ramAddr = ranges[0].addr, ramLen = ranges.reduce((s, r) => s + r.len, 0);
const inputs = JSON.parse(inputsS).sort((a, b) => a.from_counter - b.from_counter);
const maskAt = (k) => { let m = 0; for (const e of inputs) { if (e.from_counter <= k) m = e.mask; else break; } return m; };

const mod = await import(pathToFileURL(join(coreDir, "index.ts")).href);
const core = mod.createCore(new Uint8Array(readFileSync(romPath)));
if (startDir) {
  core.restore(new Uint8Array(readFileSync(join(startDir, "core.bin"))));
  const check = JSON.parse(readFileSync(join(startDir, "check.json"), "utf8"));
  const wram = Buffer.alloc(0x2000);
  for (let i = 0; i < 0x2000; i++) wram[i] = core.read(0xc000 + i) & 0xff;
  if (core.cpu.pc !== check.pc || wram.toString("hex") !== check.wram_hex) {
    process.stdout.write(JSON.stringify({ error: "start state did not load into this core" }) + "\n");
    process.exit(3);
  }
}
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const STALL_FRAMES = 5, LOAD_FRAMES = 600; // lockstep/align.ts
const readCounter = () => (core.read(ramAddr) | (core.read(ramAddr + 1) << 8)) & 0xffff;
let live = false, compared = null;
const toCounter = (target) => {
  let cur = readCounter(), still = 0;
  if (live && cur === target) return compared;
  for (;;) {
    if (live && cur > target) return null;
    const before = core.frame();
    core.runFrame();
    const nxt = readCounter();
    if (nxt === cur) { if (++still >= (live ? STALL_FRAMES : LOAD_FRAMES)) return null; } else { still = 0; live = true; }
    cur = nxt;
    if (live && cur === target) return (compared = before);
  }
};
for (let n = 1; n <= to; n++) {
  core.setButtons(maskAt(n - 1));
  const f = align === "counter" ? toCounter(n & 0xffff) : (core.runFrame(), core.frame());
  if (!f) { out({ n, stall: true }); break; }
  if (n < from) continue;
  const ram = Buffer.alloc(ramLen);
  let k = 0;
  for (const r of ranges) for (let i = 0; i < r.len; i++) ram[k++] = core.read(r.addr + i) & 0xff;
  out({ n, ram: ram.toString("hex"), frame: Buffer.from(f).toString("base64") });
}
