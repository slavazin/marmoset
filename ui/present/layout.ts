// Geometry and timing for the presentation tabs (S14): pixel sizes of the How-it-works diagram, its grid of stage
// positions, and how long a loop stage stays highlighted. No figure lives here: ui/present/present.test.ts asserts
// every exported number is named for a unit or a grid count (_PX, _MS, GRID_), and that the templates under
// ui/present/ carry no numeric literal, so every coordinate a template draws comes from the functions below.

/** Stage box width and height in the diagram's SVG user units. */
export const BOX_W_PX = 152;
export const BOX_H_PX = 46;
/** Gaps between grid columns and rows, and the margin around the drawing. */
export const GAP_X_PX = 26;
export const GAP_Y_PX = 58;
export const PAD_PX = 14;
/** Height of one listed line inside a box (gate checks, trial arms). */
export const LINE_PX = 14;
/** Arrowhead half-size. */
export const HEAD_PX = 5;

/**
 * How long a loop stage (incident, repair, gate, verdict, trial, hook, V read) stays highlighted before frame and
 * player events may move the highlight back to play or lockstep. 6 s: long enough to read in a video frame.
 */
export const STAGE_HOLD_MS = 6000;
/** Debounce between a ledger event and the History tab's refetch of /api/history. */
export const HISTORY_REFETCH_MS = 400;

/** Grid cell [column, row] of each stage box. Row 0 is the fast loop, row 1 the slow loop, row 2 the outcomes of the slow loop. */
export const STAGE_GRID = {
  play: [0, 0], lockstep: [1, 0], incident: [2, 0], packet: [3, 0], gate: [4, 0], graduate: [5, 0], refuse: [5, 0],
  observation: [5, 1], consolidator: [4, 1], trial: [3, 1], skill: [2, 1], hook: [1, 1],
  tombstone: [3, 2], vread: [2, 2],
} as const satisfies Record<string, readonly [number, number]>;
export type StageId = keyof typeof STAGE_GRID;

/** Columns and rows the diagram spans. */
export const GRID_COLS = Math.max(...Object.values(STAGE_GRID).map(([c]) => c)) + 1;
export const GRID_ROWS = Math.max(...Object.values(STAGE_GRID).map(([, r]) => r)) + 1;

/** Corner radius of a stage box; offset of an arrow label from its arrow; the SVG origin. */
export const RX_PX = 3;
export const LABEL_DX_PX = 5;
export const LABEL_DY_PX = 4;
export const ORIGIN_PX = 0;

/** Height of a box that lists `lines` lines below its title (none when omitted). */
export const boxH = (lines?: number): number => BOX_H_PX + (lines ?? 0) * LINE_PX;
/** Per row, the most lines any box in that row lists. */
export function rowTalls(cells: { row: number; lines?: number }[]): number[] {
  const tall = Array.from({ length: GRID_ROWS }, () => 0);
  for (const c of cells) tall[c.row] = Math.max(tall[c.row], c.lines ?? 0);
  return tall;
}
/** The grid row of a stage. */
export const rowOf = (id: StageId): number => STAGE_GRID[id][1];
/** The last element of a non-empty sequence. */
export const last = <T>(xs: T[]): T => xs[xs.length - 1];
/** Consecutive pairs of a sequence: [a, b, c] → [[a, b], [b, c]]. */
export function pairs<T>(xs: T[]): [T, T][] {
  return xs.slice(1).map((x, i) => [xs[i], x]);
}
/** Top of a grid row; `tall` is the line count of each row's tallest box, so a row starts below the tallest box above it. */
export function rowY(row: number, tall: number[]): number {
  let y = PAD_PX;
  for (let r = 0; r < row; r++) y += boxH(tall[r] ?? 0) + GAP_Y_PX;
  return y;
}
export const colX = (col: number): number => PAD_PX + col * (BOX_W_PX + GAP_X_PX);
export const midX = (col: number): number => colX(col) + BOX_W_PX / 2;
export const rightX = (col: number): number => colX(col) + BOX_W_PX;
export const half = (h: number): number => h / 2;
export const titleY = (top: number): number => top + LINE_PX + HEAD_PX;
export const subY = (top: number): number => top + LINE_PX * 2 + HEAD_PX;
export const lineY = (top: number, i: number): number => top + BOX_H_PX + i * LINE_PX;
export const textX = (col: number): number => colX(col) + HEAD_PX * 2;
export const viewW = (): number => PAD_PX * 2 + GRID_COLS * BOX_W_PX + (GRID_COLS - 1) * GAP_X_PX;
export const viewH = (tall: number[]): number => rowY(GRID_ROWS, tall) - GAP_Y_PX + PAD_PX;
/** Vertical middle of the gap above `row`. */
export const gapAbove = (row: number, tall: number[]): number => rowY(row, tall) - GAP_Y_PX / 2;
/** An arrowhead with its tip at (x, y), pointing r, l, u or d, as SVG polygon points. */
export function arrowHead(x: number, y: number, dir: "r" | "l" | "u" | "d"): string {
  const h = HEAD_PX;
  const pts = {
    r: [[x, y], [x - h * 2, y - h], [x - h * 2, y + h]],
    l: [[x, y], [x + h * 2, y - h], [x + h * 2, y + h]],
    u: [[x, y], [x - h, y + h * 2], [x + h, y + h * 2]],
    d: [[x, y], [x - h, y - h * 2], [x + h, y - h * 2]],
  }[dir];
  return pts.map((p) => p.join(",")).join(" ");
}
