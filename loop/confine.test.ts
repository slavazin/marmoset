import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, chmodSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { seatbeltProfile, confinedCommand, confinePathsFor, profilePath, real, SANDBOX_EXEC, type ConfinePaths } from "./confine.ts";

const ROOT = resolve(import.meta.dirname, "..");
const base = realpathSync(mkdtempSync(join(tmpdir(), "confine-test-")));
const cache = join(base, "cache"), scratch = join(base, "scratch"), live = join(base, "lives", "ratchet-live");
const att = join(scratch, "ATT-0001"), other = join(scratch, "ATT-0002");
for (const d of [cache, att, `${att}.env`, `${att}.home`, other, live, join(base, "lives", "ratchet-live-cgb")]) mkdirSync(d, { recursive: true });
writeFileSync(join(att, "inside.txt"), "INSIDE");
writeFileSync(join(`${att}.env`, "rom.txt"), "ROM");
writeFileSync(join(other, "secret.txt"), "OTHER");
writeFileSync(join(cache, "canary.txt"), "CACHE");
writeFileSync(join(live, "canary.txt"), "LIVE");
process.env.RATCHET_CACHE = cache;
process.env.RATCHET_LIVE = live;
process.env.RATCHET_TELEMETRY_DIR = join(base, "telemetry");

const cp: ConfinePaths = confinePathsFor(att, `${att}.home`);
const sb = seatbeltProfile(cp);
const sandboxWorks = process.platform === "darwin" && spawnSync(SANDBOX_EXEC, ["-p", "(version 1)(allow default)", "/usr/bin/true"]).status === 0;
const sbx = (file: string, args: string[]) => spawnSync(SANDBOX_EXEC, ["-f", file, ...args], { encoding: "utf8" });

test("profile denies reads of the repo, its main checkout, the cache, both live clones and the scratch root, by real path", () => {
  const deny = sb.split("\n").find((l) => l.startsWith("(deny file-read*"))!;
  for (const p of [real(ROOT), real(cp.repos.at(-1)!), cache, live, join(base, "lives", "ratchet-live-cgb"), scratch]) assert.ok(deny.includes(`(subpath "${p}")`), p);
  assert.ok(!sb.includes('"/var/'), "no unresolved /var path");
});

test("profile allows reads of this attempt's dir, .env dir and HOME after the deny, and writes only to its dir and HOME after re-denying the scratch root", () => {
  const lines = sb.split("\n");
  const at = (pre: string) => lines.findIndex((l) => l.startsWith(pre));
  const allowRead = lines[at("(allow file-read* ")];
  for (const p of [att, `${att}.env`, `${att}.home`]) assert.ok(allowRead.includes(`(subpath "${p}")`), p);
  assert.ok(!allowRead.includes(other));
  assert.ok(at("(deny file-read*") < at("(allow file-read* "));
  const writes = lines.filter((l) => l.includes("file-write*"));
  assert.equal(writes[0], '(deny file-write* (subpath "/"))');
  assert.ok(writes[1].includes('(subpath "/private/tmp")') && writes[1].includes('(subpath "/private/var/folders")') && writes[1].includes('(literal "/dev/null")') && writes[1].includes('(literal "/dev/tty")'));
  assert.ok(writes[2].startsWith("(deny file-write*") && writes[2].includes(`(subpath "${scratch}")`));
  assert.equal(writes[3], `(allow file-write* (subpath "${att}") (subpath "${att}.home"))`);
});

test("profile denies network except localhost, outbound tcp 443 and the DNS socket", () => {
  const net = sb.split("\n").filter((l) => l.includes("network"));
  assert.equal(net[0], "(deny network*)");
  assert.equal(net[1], '(allow network* (remote ip "localhost:*"))');
  assert.equal(net[2], '(allow network-outbound (remote tcp "*:443"))');
  assert.ok(net[3].includes("mDNSResponder"));
});

test("confined argv is sandbox-exec -f <ATT>.sb muse … --disable-sandbox, profile outside the readable dirs; unconfined argv is muse … without it", async () => {
  const { museArgs } = await import("./repair.ts");
  const on = confinedCommand("muse", museArgs("sid", 5, "seatbelt"), att, `${att}.home`, true);
  assert.equal(on.cmd, SANDBOX_EXEC);
  assert.deepEqual(on.argv.slice(0, 3), ["-f", profilePath(att), "muse"]);
  assert.equal(on.argv.at(-1), "--disable-sandbox");
  assert.equal(on.confine, "seatbelt");
  assert.equal(on.profile, `${att}.sb`);
  assert.match(on.sha256!, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(on.profile!, "utf8"), sb);
  const off = confinedCommand("muse", museArgs("sid", 5, "none"), att, `${att}.home`, false);
  assert.equal(off.cmd, "muse");
  assert.equal(off.confine, "none");
  assert.ok(!off.argv.includes("--disable-sandbox"));
  assert.ok(!museArgs("sid", 5).includes("--disable-sandbox"));
});

test("sandbox-exec with the profile: cat reads this attempt's files, is refused the repo, cache, live clone and a sibling scratch dir, and writes only inside", { skip: !sandboxWorks && "sandbox-exec refused in this shell" }, () => {
  const f = profilePath(att);
  writeFileSync(f, sb);
  assert.equal(sbx(f, ["/bin/cat", join(att, "inside.txt")]).stdout, "INSIDE");
  assert.equal(sbx(f, ["/bin/cat", join(`${att}.env`, "rom.txt")]).stdout, "ROM");
  for (const p of [join(ROOT, "package.json"), join(cache, "canary.txt"), join(live, "canary.txt"), join(other, "secret.txt"), f]) {
    const r = sbx(f, ["/bin/cat", p]);
    assert.equal(r.status, 1, p);
    assert.equal(r.stdout, "", p);
  }
  assert.equal(sbx(f, ["/bin/sh", "-c", `echo x > ${join(att, "w.txt")}`]).status, 0);
  assert.equal(sbx(f, ["/bin/sh", "-c", `echo x > ${join(other, "w.txt")}`]).status, 1);
  assert.ok(!existsSync(join(other, "w.txt")));
});

test("museCli.run on darwin spawns sandbox-exec, passes --disable-sandbox to the binary, and records confine seatbelt", { skip: !sandboxWorks && "sandbox-exec refused in this shell" }, async () => {
  const bin = join(base, "bin", "fake-muse");
  mkdirSync(join(base, "bin"), { recursive: true });
  writeFileSync(bin, `#!/bin/sh\necho "$@" > argv.txt\ncat ${join(cache, "canary.txt")} > cache-read.txt 2>/dev/null; echo $? > cache-exit.txt\n`);
  chmodSync(bin, 0o755);
  process.env.MUSE_BIN = bin;
  delete process.env.RATCHET_CONFINE;
  const { museCli } = await import(`./repair.ts?muse=${Date.now()}`);
  const env = { PATH: "/usr/bin:/bin", HOME: `${att}.home`, ATTEMPT_ID: "ATT-0001" };
  const out = await museCli.run({ cwd: att, env, sessionId: "sid", maxSteps: 3, wallS: 10, eventsFile: join(`${att}.home`, "events.jsonl") });
  assert.equal(out.confine, "seatbelt");
  assert.match(readFileSync(join(att, "argv.txt"), "utf8"), /^exec .* --trust-workspace --disable-sandbox\n$/);
  assert.equal(readFileSync(join(att, "cache-exit.txt"), "utf8").trim(), "1");
  assert.equal(readFileSync(join(att, "cache-read.txt"), "utf8"), "");
  const tel = readFileSync(join(base, "telemetry", "loop.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.kind === "confine");
  assert.equal(tel.data.profile, `${att}.sb`);
  assert.match(tel.data.sha256, /^[0-9a-f]{64}$/);
});

test("repairResidue swaps D-0018's read-open line for D-0021's lines only when the attempt reads confine seatbelt", async () => {
  const { repairResidue, REPAIR_RESIDUE } = await import("./gate-repair.ts");
  const iso = { home: "", skills_list: "", observers: "off" as const, web_tools: "off" as const };
  assert.deepEqual(repairResidue({ isolation: iso }), REPAIR_RESIDUE);
  const c = repairResidue({ isolation: { ...iso, confine: "seatbelt" } as typeof iso });
  assert.ok(!c.some((l) => l.includes("D-0018")));
  assert.ok(c.some((l) => l.includes("localhost")) && c.some((l) => l.includes("macOS only")));
  assert.equal(c.length, REPAIR_RESIDUE.length + 1);
});
