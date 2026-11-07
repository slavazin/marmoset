// pnpm roms:fetch — downloads c-sp/game-boy-test-roms v7.0 into $RATCHET_ROMS (default ~/.cache/ratchet/roms),
// outside every worktree. Idempotent: a present VERSION marker skips the download. ROMs are never committed (AGENTS.md rule 8).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const VERSION = "v7.0";
const URL = `https://github.com/c-sp/game-boy-test-roms/releases/download/${VERSION}/game-boy-test-roms-${VERSION}.zip`;

export function romsDir(): string {
  const v = process.env.RATCHET_ROMS;
  return v ? v.replace(/^~(?=\/|$)/, homedir()) : join(homedir(), ".cache", "ratchet", "roms");
}

const dir = romsDir();
const marker = join(dir, "VERSION");
if (existsSync(marker)) {
  console.log(`roms present at ${dir}`);
} else {
  mkdirSync(dir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "ratchet-roms-"));
  const zip = join(tmp, "roms.zip");
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${URL}`);
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync("unzip", ["-q", "-o", zip, "-d", dir], { stdio: "inherit" });
  rmSync(tmp, { recursive: true, force: true });
  writeFileSync(marker, VERSION + "\n");
  console.log(`roms ${VERSION} fetched into ${dir}`);
}
