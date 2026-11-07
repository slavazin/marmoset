// pnpm core:bundle <dir> <out.js>
// Bundles <dir>/index.ts into one browser ESM file with esbuild, exporting createCore and HANDLERS (SPEC §6.1).
// S6 loads the output through `?core=<url>` (ui/core-seam.ts); N3 hot-swaps it. scripts/core-bundle.test.ts
// imports a bundle of core/ and reads both exports.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "esbuild";

/** Builds the bundle; resolves to the output path. Throws when <dir>/index.ts is absent. */
export async function bundleCore(dir: string, out: string): Promise<string> {
  const entry = resolve(dir, "index.ts");
  if (!existsSync(entry)) throw new Error(`${entry}: no such file`);
  const outfile = resolve(out);
  await build({ entryPoints: [entry], outfile, bundle: true, format: "esm", platform: "browser", target: "es2022", logLevel: "warning" });
  return outfile;
}

if (import.meta.main) {
  const [dir, out] = process.argv.slice(2);
  if (!dir || !out) {
    console.error("usage: pnpm core:bundle <dir> <out.js>");
    process.exitCode = 1;
  } else {
    console.log(await bundleCore(dir, out));
  }
}
