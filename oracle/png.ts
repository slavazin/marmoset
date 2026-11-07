// readPngShades: decodes a non-interlaced PNG (greyscale at 1/2/4/8 bits, or
// 8-bit RGB/RGBA) with node:zlib and maps it to DMG shades by the exact map of
// SPEC §5 S2 (#FFFFFF=0, #AAAAAA=1, #555555=2, #000000=3). Any other colour
// throws: a reference that holds one is a load error, never a nearest match.
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const SHADE_OF_RGB = new Map<number, number>([
  [0xffffff, 0],
  [0xaaaaaa, 1],
  [0x555555, 2],
  [0x000000, 3],
]);

export interface ShadeImage { width: number; height: number; shades: Uint8Array }

export function readPngShades(path: string): ShadeImage {
  const buf = readFileSync(path);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${path}: not a PNG`);
  let off = 8;
  let width = 0, height = 0, colourType = -1, depth = 8;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colourType = data[9];
      const interlace = data[12];
      const grey = colourType === 0 && [1, 2, 4, 8].includes(depth);
      const rgb = depth === 8 && (colourType === 2 || colourType === 6);
      if (interlace !== 0 || !(grey || rgb)) {
        throw new Error(`${path}: only non-interlaced greyscale, RGB8 or RGBA8 is read (depth ${depth}, type ${colourType}, interlace ${interlace})`);
      }
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const channels = colourType === 6 ? 4 : colourType === 2 ? 3 : 1;
  const bpp = Math.max(1, (channels * depth) >> 3);
  const stride = Math.ceil((width * channels * depth) / 8);
  const raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let v: number;
      switch (filter) {
        case 0: v = src[x]; break;
        case 1: v = src[x] + a; break;
        case 2: v = src[x] + b; break;
        case 3: v = src[x] + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v = src[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`${path}: bad filter ${filter} on row ${y}`);
      }
      px[y * stride + x] = v & 0xff;
    }
  }
  const shades = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const rgb = sampleRgb(px, i, width, stride, channels, depth);
    const s = SHADE_OF_RGB.get(rgb);
    if (s === undefined) throw new Error(`${path}: colour #${rgb.toString(16).padStart(6, "0")} at pixel ${i} is outside the shade map`);
    shades[i] = s;
  }
  return { width, height, shades };
}

function sampleRgb(px: Uint8Array, i: number, width: number, stride: number, channels: number, depth: number): number {
  if (channels === 1) {
    const x = i % width, y = (i / width) | 0;
    const bit = x * depth;
    const v = (px[y * stride + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
    const g = Math.round((v * 255) / ((1 << depth) - 1));
    return (g << 16) | (g << 8) | g;
  }
  return (px[i * channels] << 16) | (px[i * channels + 1] << 8) | px[i * channels + 2];
}
