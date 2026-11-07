import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const script = join(root, "scripts", "collect-runs.sh");
const LOGO = Buffer.from("ceed6666cc0d000b", "hex");
const run = (args: string[]) => spawnSync("bash", [script, ...args], { encoding: "utf8" });

function worktree(): string {
  const w = mkdtempSync(join(tmpdir(), "ratchet-wt-"));
  const r = join(w, "runs", "RUN-0004");
  mkdirSync(join(r, "ledger"), { recursive: true });
  mkdirSync(join(r, "telemetry"), { recursive: true });
  writeFileSync(join(r, "manifest.json"), "{}");
  writeFileSync(join(r, "ledger", "attempts.jsonl"), "{}\n");
  writeFileSync(join(r, "telemetry", "ui.jsonl"), "{}\n");
  writeFileSync(join(r, "copy.gb"), "rom");
  writeFileSync(join(r, "Copy Two.GBC"), "rom");
  const hidden = Buffer.alloc(0x150); LOGO.copy(hidden, 0x104);
  writeFileSync(join(r, "renamed.bin"), hidden);
  symlinkSync(join(r, "copy.gb"), join(r, "link.dat"));
  mkdirSync(join(w, "evidence", "incidents", "INC-0001"), { recursive: true });
  writeFileSync(join(w, "evidence", "incidents", "INC-0001", "core.png"), "png");
  mkdirSync(join(w, "runs", "RUN-0001"), { recursive: true });
  writeFileSync(join(w, "runs", "RUN-0001", "muse-native.jsonl"), "{}\n");
  writeFileSync(join(w, "runs", "RUN-0001", "spend-override.json"), "{}");
  return w;
}

test("collect-runs copies a run, its outside evidence and a glob of files, leaving out ROM bytes by name, letter case and header", () => {
  const w = worktree(), dest = mkdtempSync(join(tmpdir(), "ratchet-dest-"));
  mkdirSync(join(dest, "RUN-0001"));
  writeFileSync(join(dest, "RUN-0001", "spend-override.json"), "main");
  const r = run(["--dest", dest, `RUN-0004=${w}/runs/RUN-0004`, `RUN-0004=${w}/evidence/incidents:evidence/incidents`, `RUN-0001=${w}/runs/RUN-0001:.:muse-native*`]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(dest, "RUN-0004", "ledger", "attempts.jsonl")));
  assert.ok(existsSync(join(dest, "RUN-0004", "evidence", "incidents", "INC-0001", "core.png")));
  assert.ok(existsSync(join(dest, "RUN-0001", "muse-native.jsonl")));
  assert.equal(readFileSync(join(dest, "RUN-0001", "spend-override.json"), "utf8"), "main", "the glob kept spend-override.json out");
  for (const f of ["copy.gb", "Copy Two.GBC", "renamed.bin", "link.dat"]) assert.ok(!existsSync(join(dest, "RUN-0004", f)), `${f} left out`);
  assert.match(r.stderr, /left out ROM bytes: .*renamed\.bin/);
});

test("collect-runs refuses to overwrite any existing target and copies nothing when one exists", () => {
  const w = worktree(), dest = mkdtempSync(join(tmpdir(), "ratchet-dest-"));
  mkdirSync(join(dest, "RUN-0004"));
  writeFileSync(join(dest, "RUN-0004", "manifest.json"), "kept");
  const r = run(["--dest", dest, `RUN-0004=${w}/runs/RUN-0004`]);
  assert.equal(r.status, 3);
  assert.equal(readFileSync(join(dest, "RUN-0004", "manifest.json"), "utf8"), "kept");
  assert.ok(!existsSync(join(dest, "RUN-0004", "ledger")), "nothing copied");
});

test("collect-runs refuses a bad run id, a missing source and a sub dir that climbs out of the run", () => {
  const w = worktree(), dest = mkdtempSync(join(tmpdir(), "ratchet-dest-"));
  assert.equal(run(["--dest", dest, `RUN-4=${w}/runs/RUN-0004`]).status, 2);
  assert.equal(run(["--dest", dest, `RUN-0004=${w}/nope`]).status, 2);
  assert.equal(run(["--dest", dest, `RUN-0004=${w}/runs/RUN-0004:../RUN-0001`]).status, 2);
  assert.equal(run(["--dest", dest]).status, 2);
});

test(".gitignore keeps RUN-0004's evidence and telemetry, and every runs/**/start/ state, out of git", () => {
  const ignored = (p: string) => { try { execFileSync("git", ["-C", root, "check-ignore", "-q", "--no-index", p]); return true; } catch { return false; } };
  assert.ok(ignored("runs/RUN-0004/evidence/incidents/INC-0001/core.png"));
  assert.ok(ignored("runs/RUN-0004/telemetry/ui.jsonl"));
  assert.ok(ignored("runs/RUN-0004/start/abc/title.json"));
  assert.ok(!ignored("runs/RUN-0004/ledger/attempts.jsonl"));
  assert.ok(!ignored("runs/RUN-0002/evidence/incidents/INC-0001/core.png"));
});
