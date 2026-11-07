// scripts/core-bundle.ts on core/: the bundle is one ESM file that exports createCore and HANDLERS and runs a frame.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type { CreateCore, Handlers } from "../src/schema.ts";
import { bundleCore } from "./core-bundle.ts";

const ROOT = resolve(import.meta.dirname, "..");

test("bundleCore(core) writes an import-free ESM file whose HANDLERS equals core/'s and whose createCore runs game.gb one frame", async () => {
  const out = await bundleCore(join(ROOT, "core"), join(mkdtempSync(join(tmpdir(), "core-bundle-")), "core.js"));
  assert.doesNotMatch(readFileSync(out, "utf8"), /^\s*import\s/m, "the bundle imports another module");
  const mod = (await import(pathToFileURL(out).href)) as { createCore: CreateCore; HANDLERS: Handlers };
  const direct = (await import("../core/index.ts")) as { HANDLERS: Handlers };
  assert.deepEqual(mod.HANDLERS, direct.HANDLERS);
  const core = mod.createCore(new Uint8Array(readFileSync(join(ROOT, "game", "game.gb"))));
  core.runFrame();
  assert.equal(core.frame().length, 160 * 144);
});
