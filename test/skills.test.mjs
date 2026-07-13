import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillIndex, loadSkillBody, scaffoldSkills, skillsDigest, invalidateSkillsCache } from "../dist/skills/skills.js";
import { searchAssets, assetSearchRoots } from "../dist/recall.js";
import { getTool } from "../dist/tools/registry.js";
import "../dist/tools/memory.js";

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

test("skills: SKILL.md symlink to .env is absent from both index and body", () => {
  const proj = tmpProject();
  try {
    const secret = join(proj, ".env");
    writeFileSync(secret, "---\nname: stolen\ndescription: must-not-leak\n---\nSECRET_BODY\n");
    const dir = join(proj, ".hara", "skills", "stolen");
    mkdirSync(dir, { recursive: true });
    symlinkSync(secret, join(dir, "SKILL.md"));
    invalidateSkillsCache();
    assert.equal(loadSkillIndex(proj).some((skill) => skill.id === "stolen"), false);
    assert.doesNotMatch(skillsDigest(proj), /must-not-leak|SECRET_BODY/);
  } finally {
    rmSync(proj, { recursive: true, force: true });
    invalidateSkillsCache();
  }
});

test("skills: skill_create and scaffold refuse symlinks to .env and preserve the target", async () => {
  const proj = tmpProject();
  try {
    const secret = join(proj, ".env");
    const original = "SKILL_WRITE_SECRET=preserve-me\n";
    writeFileSync(secret, original);

    const createDir = join(proj, ".hara", "skills", "linked-skill");
    mkdirSync(createDir, { recursive: true });
    symlinkSync(secret, join(createDir, "SKILL.md"));
    const result = await getTool("skill_create").run({
      name: "linked-skill",
      description: "a safe description",
      body: "safe instructions",
      scope: "project",
    }, { cwd: proj });
    assert.match(result, /^Error: cannot save skill .*protected environment file/i);

    const scaffoldDir = join(proj, ".hara", "skills", "verify-change");
    mkdirSync(scaffoldDir, { recursive: true });
    symlinkSync(secret, join(scaffoldDir, "SKILL.md"));
    await assert.rejects(scaffoldSkills(proj), /protected|environment file/i);
    assert.equal(readFileSync(secret, "utf8"), original, "the symlink target remains byte-for-byte unchanged");
  } finally {
    rmSync(proj, { recursive: true, force: true });
    invalidateSkillsCache();
  }
});

test("skills: skill_create and scaffold reject hard-linked targets and preserve .env", async () => {
  const proj = tmpProject();
  try {
    const secret = join(proj, ".env");
    const original = "SKILL_HARDLINK_SECRET=preserve-me\n";
    writeFileSync(secret, original);

    const createDir = join(proj, ".hara", "skills", "hardlinked-skill");
    mkdirSync(createDir, { recursive: true });
    linkSync(secret, join(createDir, "SKILL.md"));
    const result = await getTool("skill_create").run({
      name: "hardlinked-skill",
      description: "a safe description",
      body: "safe instructions",
      scope: "project",
    }, { cwd: proj });
    assert.match(result, /^Error: cannot save skill .*(hard link|protected)/i);

    const scaffoldDir = join(proj, ".hara", "skills", "verify-change");
    mkdirSync(scaffoldDir, { recursive: true });
    linkSync(secret, join(scaffoldDir, "SKILL.md"));
    await assert.rejects(scaffoldSkills(proj), /hard link|protected/i);
    assert.equal(readFileSync(secret, "utf8"), original, "the hard-link target remains byte-for-byte unchanged");
  } finally {
    rmSync(proj, { recursive: true, force: true });
    invalidateSkillsCache();
  }
});

test("skills: skill_create stays bound to the original parent when a skills symlink is retargeted", async () => {
  const proj = tmpProject();
  const first = join(proj, "first-skills");
  const second = join(proj, "second-skills");
  const alias = join(proj, ".hara", "skills");
  try {
    mkdirSync(first);
    mkdirSync(second);
    mkdirSync(join(proj, ".hara"), { recursive: true });
    symlinkSync(first, alias);

    const pending = getTool("skill_create").run({
      name: "parent-retarget",
      description: "a safe reusable procedure",
      body: "perform the safe procedure",
      scope: "project",
    }, { cwd: proj });
    unlinkSync(alias);
    symlinkSync(second, alias);
    const result = await pending;

    assert.match(result, /^Saved project skill/);
    assert.match(readFileSync(join(first, "parent-retarget", "SKILL.md"), "utf8"), /perform the safe procedure/);
    assert.equal(existsSync(join(second, "parent-retarget", "SKILL.md")), false, "retargeted parent receives no write");
  } finally {
    rmSync(proj, { recursive: true, force: true });
    invalidateSkillsCache();
  }
});

test("skills: scaffold stays bound to the original parent when a skills symlink is retargeted", async () => {
  const proj = tmpProject();
  const first = join(proj, "first-skills");
  const second = join(proj, "second-skills");
  const alias = join(proj, ".hara", "skills");
  try {
    mkdirSync(first);
    mkdirSync(second);
    mkdirSync(join(proj, ".hara"), { recursive: true });
    symlinkSync(first, alias);

    const pending = scaffoldSkills(proj);
    unlinkSync(alias);
    symlinkSync(second, alias);
    await pending;

    assert.match(readFileSync(join(first, "verify-change", "SKILL.md"), "utf8"), /name: verify-change/);
    assert.equal(existsSync(join(second, "verify-change", "SKILL.md")), false, "retargeted parent receives no write");
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
