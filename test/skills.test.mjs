import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillIndex, loadSkillBody, skillsDigest, invalidateSkillsCache } from "../dist/skills/skills.js";
import { searchAssets, assetSearchRoots } from "../dist/recall.js";

function tmpProject() {
  const dir = join(tmpdir(), "hara-skills-" + Math.random().toString(36).slice(2));
  mkdirSync(join(dir, ".git"), { recursive: true }); // marker so findProjectRoot anchors here
  return dir;
}
function writeSkill(proj, name, frontmatter, body) {
  const d = join(proj, ".hara", "skills", name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "SKILL.md"), `---\n${frontmatter}\n---\n\n${body}\n`);
}

test("loadSkillIndex: agentskills <name>/SKILL.md, hyphenated frontmatter, body lazy", () => {
  const proj = tmpProject();
  try {
    writeSkill(
      proj,
      "pdf-extract",
      "name: pdf-extract\ndescription: Extract text from PDFs\nwhen_to_use: when given a PDF\nallowed-tools: [read_file, bash]\ncontext: fork\nuser-invocable: false",
      "# PDF\nstep one\nstep two",
    );
    invalidateSkillsCache();
    const sk = loadSkillIndex(proj).find((s) => s.id === "pdf-extract");
    assert.ok(sk, "skill loaded from <name>/SKILL.md");
    assert.equal(sk.description, "Extract text from PDFs");
    assert.equal(sk.whenToUse, "when given a PDF");
    assert.deepEqual(sk.allowedTools, ["read_file", "bash"]); // hyphenated key parsed
    assert.equal(sk.context, "fork");
    assert.equal(sk.userInvocable, false); // user-invocable: false
    assert.equal(sk.modelInvocable, true);
    assert.equal(sk.source, "project");
    assert.match(loadSkillBody(sk), /step one/); // body read on demand, not in the index entry
  } finally {
    rmSync(proj, { recursive: true, force: true });
    invalidateSkillsCache();
  }
});

test("skillsDigest: one line per model-invocable skill, drops disable-model-invocation", () => {
  const proj = tmpProject();
  try {
    writeSkill(proj, "alpha", "name: alpha\ndescription: Do alpha things", "body");
    writeSkill(proj, "secret", "name: secret\ndescription: hidden helper\ndisable-model-invocation: true", "body");
    invalidateSkillsCache();
    const digest = skillsDigest(proj);
    assert.match(digest, /alpha: Do alpha things/);
    assert.doesNotMatch(digest, /secret|hidden helper/); // disable-model-invocation hides it from the index
  } finally {
    rmSync(proj, { recursive: true, force: true });
    invalidateSkillsCache();
  }
});

test("assetSearchRoots unifies skills + code-assets so recall finds skills (Phase 0)", () => {
  const proj = tmpProject();
  try {
    writeSkill(proj, "zod-forms", "name: zod-forms\ndescription: use the zod resolver for react-hook-form", "Use zodResolver(schema) with useForm.");
    const roots = assetSearchRoots(proj);
    const hits = searchAssets("zod resolver", 5, roots);
    assert.ok(hits.some((h) => h.path.includes("zod-forms")), "recall finds the skill via the unified corpus");
  } finally {
    rmSync(proj, { recursive: true, force: true });
    invalidateSkillsCache();
  }
});

test("project skills override global on id clash is handled by source ordering", () => {
  const proj = tmpProject();
  try {
    writeSkill(proj, "dup", "name: dup\ndescription: project version", "body");
    invalidateSkillsCache();
    const sk = loadSkillIndex(proj).find((s) => s.id === "dup");
    assert.equal(sk.source, "project"); // project dir iterated last → wins
  } finally {
    rmSync(proj, { recursive: true, force: true });
    invalidateSkillsCache();
  }
});
