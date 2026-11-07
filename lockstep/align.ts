// The core side of `align: "counter"` (SPEC §5 S3, D-0007), one rule for lockstep, replay and the gate's
// frame producer (loop/frames-child.mjs carries a copy, since it runs under --permission with no read of this
// file). The compared frame at counter n is the frame completed before the VBlank that wrote n. A core's
// runFrame ends at LY 144 (SPEC §6.1), so the VBlank handler that writes n runs at the start of the next
// runFrame; core.frame() after runToCounter(n) is therefore one frame late, and counterStepper keeps the
// frame from before the runFrame that changed the counter to n. The counter is live only after it first
// changes following load, as oracle/frontend.py op_run_to_counter reads it. Truth-maker: lockstep/align.test.ts.
import type { Core } from "../src/schema.ts";
import { GAME_RAM } from "./diff.ts";

/** Unchanged frames of a live counter that read as a stall: SPEC §6.1 runToCounter's "5-frame stall". */
export const STALL_FRAMES = 5;
/** Frames from load allowed before the counter first changes: oracle/frontend.py STALL_FRAMES (600). */
export const LOAD_FRAMES = 600;

export interface CounterStepper {
  /** Runs frames until the live counter reads n; returns the compared frame, or null on a stall or overshoot. */
  to(n: number): Uint8Array | null;
}

export function counterStepper(core: Core, addr: number = GAME_RAM.addr): CounterStepper {
  const read = () => (core.read(addr) | (core.read(addr + 1) << 8)) & 0xffff;
  let live = false;
  let compared: Uint8Array | null = null;
  return {
    to(n: number): Uint8Array | null {
      const target = n & 0xffff;
      let cur = read();
      if (live && cur === target) return compared;
      let still = 0;
      for (;;) {
        if (live && cur > target) return null;
        const before = core.frame();
        core.runFrame();
        const nxt = read();
        if (nxt === cur) {
          if (++still >= (live ? STALL_FRAMES : LOAD_FRAMES)) return null;
        } else {
          still = 0;
          live = true;
        }
        cur = nxt;
        if (live && cur === target) return (compared = before);
      }
    },
  };
}
