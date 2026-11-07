// `pnpm oracle:smoke`: dmg-acid2 against its DMG reference under align
// "frame", then counter.gb's 600 compared frames hashed on two separate oracle
// processes. Exits 1 on any mismatch. The checks live in exported functions
// that oracle/oracle.test.ts also reads.
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OracleClient, sha256 } from "./client.ts";
import { readPngShades } from "./png.ts";

export const ROMS = process.env.RATCHET_ROMS ?? join(homedir(), ".cache", "ratchet", "roms");
export const ACID2_ROM = join(ROMS, "dmg-acid2", "dmg-acid2.gb");
export const ACID2_REF = join(ROMS, "dmg-acid2", "dmg-acid2-dmg.png");
export const COUNTER_ROM = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "counter.gb");

// ACID2_FRAMES: frames run from load before dmg-acid2's frame is compared.
// SameBoy's DMG boot ROM spends 85 frames before a cartridge's first write
// (counter.gb's first_write_frame, oracle info); dmg-acid2 draws its final
// image within a few frames after that, so 300 frames clears both.
export const ACID2_FRAMES = 300;
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
