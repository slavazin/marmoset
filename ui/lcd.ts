// LCD drawing: shade arrays (0..3, 0 = white) to a canvas in the N1 DMG green palette. Display only;
// no diff maths reads these colours (SPEC N1). Diffs compare shades or evidence PNG pixels, never palette RGB.

export const LCD_W = 160;
export const LCD_H = 144;
/** N1 palette, darkest first: #0f380f #306230 #8bac0f #9bbc0f. Shade 0 (white) maps to the lightest. */
export const DMG_PALETTE = ["#0f380f", "#306230", "#8bac0f", "#9bbc0f"] as const;

const rgb = DMG_PALETTE.map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]);
/** RGBA packed per shade (little-endian ABGR for a Uint32Array view of ImageData). */
const SHADE_ABGR = new Uint32Array(4).map((_, s) => {
  const [r, g, b] = rgb[3 - s];
  return (0xff << 24) | (b << 16) | (g << 8) | r;
});

export class Lcd {
  private ctx: CanvasRenderingContext2D;
  private img: ImageData;
  private px: Uint32Array;
  readonly canvas: HTMLCanvasElement;
  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.width = LCD_W; canvas.height = LCD_H;
    this.ctx = canvas.getContext("2d")!;
    this.img = this.ctx.createImageData(LCD_W, LCD_H);
    this.px = new Uint32Array(this.img.data.buffer);
  }
  draw(shades: Uint8Array): void {
    const n = Math.min(shades.length, this.px.length);
    for (let i = 0; i < n; i++) this.px[i] = SHADE_ABGR[shades[i] & 3];
    this.ctx.putImageData(this.img, 0, 0);
  }
}

/** Decodes a §6.18 frame event's shades_b64 into a 23,040-byte shade array. */
export function decodeShades(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Converts greyscale RGBA pixels (an evidence PNG drawn to a canvas) to shades: lighter is lower. */
export function greyToShades(rgba: Uint8ClampedArray): Uint8Array {
  const out = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = 3 - Math.min(3, Math.round(rgba[i * 4] / 85));
  return out;
}
