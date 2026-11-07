import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePlacebo, LENGTH_TOLERANCE } from "./placebo.ts";
import { frontmatterFor, parseSkill, slug, writeShadowSkill } from "./consolidate.ts";
import { nomination, REPLY } from "./fixtures/slow.ts";

const MARK = /placebo|twin|sham|control arm|decoy|dummy/i;

function keys(text: string): string[] {
  return (/^---\n([\s\S]*?)\n---/.exec(text)![1]).split("\n").map((l) => /^(\s*[a-z-]+):/.exec(l)?.[1]).filter(Boolean) as string[];
}

for (const mode of ["template", "another candidate"] as const) {
  test(`the twin from ${mode} has its own SKL id, the same frontmatter fields, a length within LENGTH_TOLERANCE, and no file marking it`, () => {
    const skills = mkdtempSync(join(tmpdir(), "ratchet-skills-"));
    const n = { ...nomination("fetcher-steps-not-delays", "tile-shift", ["OBS-0001", "OBS-0002"]) };
    const cand = writeShadowSkill(skills, frontmatterFor("SKL-0001", n as any), n.do, n.dont);
    const others: string[] = [];
    if (mode === "another candidate") {
      const m = { ...REPLY.nominations[1], paths: ["core/apu*.ts"] };
      others.push(writeShadowSkill(skills, frontmatterFor("SKL-0002", m as any), m.do, m.dont));
    }
    const twin = makePlacebo(cand, others, skills);
    assert.equal(twin.id, mode === "template" ? "SKL-0002" : "SKL-0003");
    assert.equal(twin.source.startsWith(mode === "template" ? "template" : "candidate"), true, twin.source);
    const ct = readFileSync(cand, "utf8"), tt = readFileSync(twin.path, "utf8");
    assert.deepEqual(keys(tt), keys(ct));
    const ratio = Buffer.byteLength(tt) / Buffer.byteLength(ct);
    assert.ok(Math.abs(ratio - 1) <= LENGTH_TOLERANCE, `length ratio ${ratio}`);
    const p = parseSkill(tt);
    assert.equal(p.fm.id, twin.id);
    assert.equal(p.fm.status, "shadow");
    assert.notEqual(p.fm.name, parseSkill(ct).fm.name);
    assert.match(p.fm.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.notEqual(p.fm.name, slug(p.do.split(/\s+/).slice(0, 5).join(" ")), "the twin is named by its own Do's first five words, which no consolidator name is");
    const dir = join(skills, "shadow", twin.id);
    for (const f of readdirSync(dir)) assert.ok(!MARK.test(readFileSync(join(dir, f), "utf8")), `${f} marks the twin`);
    assert.deepEqual(readdirSync(dir), ["SKILL.md"]);
  });
}

test("a candidate's twin is never another candidate whose activation paths overlap its own; a template from another subsystem stands in", () => {
  const skills = mkdtempSync(join(tmpdir(), "ratchet-skills-"));
  const n = nomination("fetcher-steps-not-delays", "tile-shift", ["OBS-0001", "OBS-0002"]);
  const cand = writeShadowSkill(skills, frontmatterFor("SKL-0001", n as any), n.do, n.dont);
  const m = REPLY.nominations[1]; // core/ppu*.ts, the candidate's own paths
  const other = writeShadowSkill(skills, frontmatterFor("SKL-0002", m as any), m.do, m.dont);
  const twin = makePlacebo(cand, [other], skills);
  assert.match(twin.source, /^template /);
  assert.ok(!parseSkill(readFileSync(twin.path, "utf8")).fm.activation.paths.some((p) => p.startsWith("core/ppu")));
});
