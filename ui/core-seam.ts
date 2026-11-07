// The one import seam between the UI and a core. The static line below picks the core the page plays;
// swapping in S1's core is that one line (`../core/index.ts`, or a `pnpm core:bundle` output).
// A `?core=<url>` page parameter, or a §6.18 `core` event (N3 hot-swap), loads an ESM bundle at runtime instead.

import type { CreateCore, Handlers } from "../src/schema.ts";
import * as staticCore from "./fixtures/core.ts";

export interface CoreModule { createCore: CreateCore; HANDLERS: Handlers }

/** Loads the core module: the bundle at `bundleUrl` when given, else the static import above. */
export async function loadCore(bundleUrl?: string | null): Promise<{ mod: CoreModule; label: string }> {
  if (bundleUrl) {
    const mod = (await import(/* @vite-ignore */ bundleUrl)) as CoreModule;
    return { mod, label: bundleUrl };
  }
  return { mod: staticCore, label: "fixture core (ui/fixtures/core.ts)" };
}
