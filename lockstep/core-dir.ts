// loadCreateCore: imports createCore from a core directory's index.ts (or index.mjs / index.js, the
// shape core:bundle emits). lockstep/run.ts, lockstep/suite.ts callers and tools/replay.mjs load cores through it.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CreateCore } from "../src/schema.ts";

export async function loadCreateCore(coreDir: string): Promise<CreateCore> {
  const entry = ["index.ts", "index.mjs", "index.js"].map((f) => join(resolve(coreDir), f)).find((p) => existsSync(p));
  if (!entry) throw new Error(`${coreDir}: no index.ts, index.mjs or index.js`);
  const mod = (await import(pathToFileURL(entry).href)) as { createCore?: CreateCore };
  if (typeof mod.createCore !== "function") throw new Error(`${entry}: exports no createCore`);
  return mod.createCore;
}
