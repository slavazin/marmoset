// Bundles tools/replay.ts into tools/replay.mjs with esbuild: one ESM file for Node 22+, pngjs and the S2
// scorer inside, node builtins external. V's ROM globs from splits.json are compiled in (suites/score.ts
// vGlobs), so the bundle still refuses V in a scratch repo without splits.json. lockstep/lockstep.test.ts
// asserts the committed bundle equals a fresh build, so a splits.json V change without a rebuild fails a test.
import { build } from "esbuild";
import { resolve } from "node:path";
import { vGlobs } from "../suites/score.ts";

const REPO = resolve(import.meta.dirname, "..");
export const REPLAY_OUT = resolve(REPO, "tools", "replay.mjs");

/** Builds the bundle; with write false it returns the text without touching tools/replay.mjs. */
export async function bundleReplay(write = true): Promise<string> {
  const r = await build({
    entryPoints: [resolve(REPO, "tools", "replay.ts")],
    bundle: true, platform: "node", format: "esm", target: "node22",
    outfile: REPLAY_OUT, write, logLevel: "silent", legalComments: "none",
    define: { __RATCHET_V_GLOBS__: JSON.stringify(vGlobs()) },
    // pngjs is CommonJS and requires node builtins; an ESM bundle needs a real require for them.
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  });
  return r.outputFiles?.[0]?.text ?? "";
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await bundleReplay();
  console.log(`wrote ${REPLAY_OUT}`);
}
