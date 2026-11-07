// `pnpm oracle:smoke`: dmg-acid2 against its DMG reference under align
// "frame", then cgb-acid2 against its CGB reference in RGB (D-0019), then
// counter.gb's 600 compared frames hashed on two separate oracle processes. Exits 1 on any mismatch. The checks live in exported functions
// that oracle/oracle.test.ts also reads.
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OracleClient, sha256 } from "./client.ts";
import { readPngRgb, readPngShades } from "./png.ts";

export const ROMS = process.env.RATCHET_ROMS ?? join(homedir(), ".cache", "ratchet", "roms");
export const ACID2_ROM = join(ROMS, "dmg-acid2", "dmg-acid2.gb");
export const ACID2_REF = join(ROMS, "dmg-acid2", "dmg-acid2-dmg.png");
export const COUNTER_ROM = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "counter.gb");

// ACID2_FRAMES: frames run from load before dmg-acid2's frame is compared.
// SameBoy's DMG boot ROM spends 85 frames before a cartridge's first write
// (counter.gb's first_write_frame, oracle info); dmg-acid2 draws its final
// image within a few frames after that, so 300 frames clears both.
export const ACID2_FRAMES = 300;
export const CGB_ACID2_ROM = join(ROMS, "cgb-acid2", "cgb-acid2.gbc");
export const CGB_ACID2_REF = join(ROMS, "cgb-acid2", "cgb-acid2.png");
// CGB_ACID2_FRAMES: frames run from load before cgb-acid2's frame is compared.
// Read 2026-11-07, sampling every 10 frames: SameBoy's CGB boot ROM and the
// test differ from the reference through frame 200 and match exactly from
// frame 210 on (checked to 270). 400 leaves margin past the CGB boot animation.
export const CGB_ACID2_FRAMES = 400;
// COUNTER_FRAMES: the counters hashed per smoke run (SPEC §5 S3 Looks like).
export const COUNTER_FRAMES = 600;

export async function acid2Diff(): Promise<{ pixels: number; colours: number[] }> {
  const ref = readPngShades(ACID2_REF);
  const oracle = OracleClient.spawn();
  try {
    await oracle.load(ACID2_ROM, "frame");
    const r = await oracle.runToCounter(ACID2_FRAMES);
    if (r.stalled) throw new Error(`dmg-acid2 stalled at frame ${r.counter}`);
    const res = await oracle.request({ op: "colours" });
    if (!res.ok) throw new Error(res.error);
    const shades = await oracle.frame();
    let pixels = 0;
    for (let i = 0; i < shades.length; i++) if (shades[i] !== ref.shades[i]) pixels++;
    return { pixels, colours: res.colours as number[] };
  } finally {
    await oracle.close();
  }
}

/**
 * cgb-acid2 under SameBoy as a CPU CGB C (D-0019), its RGB888 frame against its reference PNG, compared RGB to RGB.
 * Both use the (x << 3) | (x >> 2) RGB555 expansion (cgb-acid2 README; SameBoy with colour correction off).
 */
export async function cgbAcid2Diff(): Promise<{ pixels: number; rgb: Uint8Array }> {
  const ref = readPngRgb(CGB_ACID2_REF);
  const oracle = OracleClient.spawn();
  try {
    await oracle.load(CGB_ACID2_ROM, "frame", "CGB");
    const r = await oracle.runToCounter(CGB_ACID2_FRAMES);
    if (r.stalled) throw new Error(`cgb-acid2 stalled at frame ${r.counter}`);
    const rgb = await oracle.frameRgb();
    return { pixels: rgbDiffPixels(rgb, ref.rgb), rgb };
  } finally {
    await oracle.close();
  }
}

/** Pixels whose R, G or B differ between two RGB888 frames of equal length. */
export function rgbDiffPixels(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) throw new Error(`RGB frames differ in length: ${a.length} vs ${b.length}`);
  let pixels = 0;
  for (let i = 0; i < a.length; i += 3) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) pixels++;
  return pixels;
}

export async function counterHashes(frames = COUNTER_FRAMES): Promise<string[]> {
  const oracle = OracleClient.spawn();
  try {
    await oracle.load(COUNTER_ROM, "counter");
    const hashes: string[] = [];
    for (let n = 1; n <= frames; n++) {
      const r = await oracle.runToCounter(n);
      if (r.stalled) throw new Error(`counter.gb stalled at ${r.counter} before ${n}`);
      hashes.push(sha256(await oracle.frame()));
    }
    return hashes;
  } finally {
    await oracle.close();
  }
}

async function main(): Promise<void> {
  const acid = await acid2Diff();
  if (acid.pixels !== 0) {
    console.log(`dmg-acid2 DIFF ${acid.pixels} px (align frame)`);
    process.exit(1);
  }
  console.log("dmg-acid2 EXACT (align frame)");
  const cgb = await cgbAcid2Diff();
  if (cgb.pixels !== 0) {
    console.log(`cgb-acid2 DIFF ${cgb.pixels} px (align frame, CGB)`);
    process.exit(1);
  }
  console.log("cgb-acid2 EXACT (align frame, CGB)");
  const [a, b] = await Promise.all([counterHashes(), counterHashes()]);
  const same = a.length === b.length && a.every((h, i) => h === b[i]);
  if (!same) {
    const at = a.findIndex((h, i) => h !== b[i]);
    console.log(`counter.gb ${COUNTER_FRAMES} frames, nondeterministic at counter ${at + 1}`);
    process.exit(1);
  }
  console.log(`counter.gb ${COUNTER_FRAMES} frames, ${a.length} hashes, deterministic`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
