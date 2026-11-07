// Minimal PNG codec for 8-bit greyscale images: encodes shade arrays for fixtures and decodes evidence PNGs in tests.
import { deflateSync, inflateSync, crc32 } from "node:zlib";

/** Grey level each DMG shade 0..3 is written as (0 = white), matching the core's frame() convention. */
export const SHADE_GREY = [255, 170, 85, 0] as const;

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

export function encodeGrey(width: number, height: number, grey: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth; colour type, compression, filter, interlace stay 0
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) raw.set(grey.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** Decodes an 8-bit greyscale PNG written by encodeGrey (filter type 0 rows only). */
export function decodeGrey(png: Buffer): { width: number; height: number; grey: Uint8Array } {
  let off = 8; let width = 0; let height = 0; const idat: Buffer[] = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off); const type = png.toString("ascii", off + 4, off + 8);
    const data = png.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); }
    if (type === "IDAT") idat.push(data);
    off += len + 12;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const grey = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) grey.set(raw.subarray(y * (width + 1) + 1, (y + 1) * (width + 1)), y * width);
  return { width, height, grey };
}
