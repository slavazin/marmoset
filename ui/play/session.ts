// The Play tab's DOM-free parts (S18): the visitor key map, the button mask a visitor holds, the frame pacer and the
// play-session telemetry. The Play tab is outside the experiment: nothing here calls POST /api/input, /api/event or
// /api/trace/reset, and the one route it posts to, POST /api/play-session, writes a `ui` telemetry record carrying a
// start or a stop and a duration, never a button (server/index.ts; ui/play/play.test.ts reads both properties).

/** DMG CPU clock (Hz) and T-cycles per frame; the frame period is their ratio (~16.74 ms), the derivation ui/main.ts paces the live LCD with. */
export const CPU_HZ = 4_194_304;
export const FRAME_CYCLES = 154 * 456;
export const FRAME_MS = (FRAME_CYCLES / CPU_HZ) * 1000;
/** Most emulated frames run per animation frame; past it the backlog is dropped, so a stalled tab resumes without a burst. */
export const MAX_CATCHUP = 3;

/** Fewest emulated frames a press is held; a game that reads the joypad once per frame and acts on the change between two reads sees a tap. */
export const MIN_HOLD_FRAMES = 2;

/** Keyboard code → joypad bit (§6.1 setButtons: bit0 right, 1 left, 2 up, 3 down, 4 A, 5 B, 6 select, 7 start). */
export const PLAY_KEYMAP: Readonly<Record<string, number>> = {
  ArrowRight: 0, ArrowLeft: 1, ArrowUp: 2, ArrowDown: 3,
  KeyZ: 4, KeyX: 5, ShiftLeft: 6, ShiftRight: 6, Backspace: 6, Enter: 7,
};
/** The key legend the Play tab shows, one row per joypad button. */
export const PLAY_LEGEND: [string, string][] = [
  ["D-pad", "arrow keys"], ["A", "Z"], ["B", "X"], ["Start", "Enter"], ["Select", "Shift or Backspace"],
];

/** The minimal key-event shape the handler reads; a DOM KeyboardEvent satisfies it. */
export interface KeyLike { type: string; code: string; repeat?: boolean; target?: unknown; preventDefault(): void; stopImmediatePropagation(): void }

/**
 * The visitor's held buttons. Keys and touch buttons set bits; `onMask` receives every change. Holds no reference to
 * any network seam: a mask leaves only through `onMask`, which ui/play/play.ts wires to core.setButtons alone.
 * A press is held for at least MIN_HOLD_FRAMES emulated frames: a release that arrives sooner (a tap, or a keydown
 * and keyup inside one animation frame) takes effect at the `frameDone` call that completes the hold.
 */
export class PlayInput {
  mask = 0;
  private onMask: (mask: number) => void;
  /** Frames each bit has been held since its press; a bit absent here is not down. */
  private held = new Map<number, number>();
  private releaseOwed = new Set<number>();
  constructor(onMask: (mask: number) => void) { this.onMask = onMask; }
  set(bit: number, down: boolean): void {
    if (down) {
      this.releaseOwed.delete(bit);
      if (!this.held.has(bit)) this.held.set(bit, 0);
    } else if (this.held.has(bit)) {
      if (this.held.get(bit)! < MIN_HOLD_FRAMES) { this.releaseOwed.add(bit); return; }
      this.held.delete(bit);
    }
    this.emit();
  }
  /** Counts one emulated frame against every held bit and applies the releases whose hold is complete. */
  frameDone(): void {
    for (const [b, n] of this.held) this.held.set(b, n + 1);
    for (const b of this.releaseOwed) if (this.held.get(b)! >= MIN_HOLD_FRAMES) { this.held.delete(b); this.releaseOwed.delete(b); }
    this.emit();
  }
  clear(): void { this.held.clear(); this.releaseOwed.clear(); this.emit(); }
  private emit(): void {
    let next = 0;
    for (const b of this.held.keys()) next |= 1 << b;
    if (next === this.mask) return;
    this.mask = next;
    this.onMask(next);
  }
}

/**
 * A capture-phase window key handler. While `active()` holds, a mapped key sets or clears a Play bit and the event
 * stops there, so ui/main.ts's window keydown listener (the live view's, which posts /api/input) never sees it.
 * A keyup is passed on to the live view after the Play bit clears: it only releases a live key held before the
 * switch. While `active()` is false the handler does nothing, so a key on the live view never reaches Play.
 */
export function playKeyHandler(input: PlayInput, active: () => boolean): (e: KeyLike) => void {
  return (e) => {
    if (!active()) return;
    const bit = PLAY_KEYMAP[e.code];
    if (bit === undefined) return;
    const tag = (e.target as { tagName?: string } | undefined)?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    e.preventDefault();
    if (e.type === "keydown") { e.stopImmediatePropagation(); input.set(bit, true); }
    else if (e.type === "keyup") input.set(bit, false);
  };
}

/** Accumulates animation-frame time into whole emulated frames at FRAME_MS, at most MAX_CATCHUP per call. */
export class FramePacer {
  private acc = 0;
  private last: number | null = null;
  /** Emulated frames owed at animation timestamp `t` (ms). */
  due(t: number): number {
    if (this.last !== null) this.acc += t - this.last;
    this.last = t;
    let n = 0;
    while (this.acc >= FRAME_MS && n < MAX_CATCHUP) { this.acc -= FRAME_MS; n++; }
    if (n === MAX_CATCHUP) this.acc = 0;
    return n;
  }
  /** Forgets the last timestamp; a resume after pause starts from zero owed. */
  reset(): void { this.acc = 0; this.last = null; }
}

/** Body of POST /api/play-session; the route in server/index.ts refuses any other field set. */
export type PlaySessionBody = { op: "start" } | { op: "stop"; duration_ms: number };
export type Poster = (path: string, body: PlaySessionBody) => void;

/** One visit to the Play tab: `start` posts a start record, `stop` posts a stop with the whole milliseconds since. */
export class PlaySession {
  private startedAt: number | null = null;
  private post: Poster;
  private now: () => number;
  constructor(post: Poster, now: () => number = () => performance.now()) { this.post = post; this.now = now; }
  get open(): boolean { return this.startedAt !== null; }
  start(): void {
    if (this.startedAt !== null) return;
    this.startedAt = this.now();
    this.post("/api/play-session", { op: "start" });
  }
  stop(): void {
    if (this.startedAt === null) return;
    const duration_ms = Math.max(0, Math.round(this.now() - this.startedAt));
    this.startedAt = null;
    this.post("/api/play-session", { op: "stop", duration_ms });
  }
}

/** The largest whole multiple of the 160×144 LCD that fits `w`×`h` CSS pixels, never below 1. */
export function integerScale(w: number, h: number, lcdW: number, lcdH: number): number {
  return Math.max(1, Math.floor(Math.min(w / lcdW, h / lcdH)));
}
