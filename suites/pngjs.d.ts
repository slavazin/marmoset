// The slice of pngjs 7.0.0 that suites/ calls: synchronous decode to and encode from 8-bit RGBA.
declare module "pngjs" {
  export interface PNGImage { width: number; height: number; data: Buffer }
  export const PNG: {
    new (opts: { width: number; height: number }): PNGImage;
    sync: { read(buf: Buffer): PNGImage; write(png: PNGImage): Buffer };
  };
}
