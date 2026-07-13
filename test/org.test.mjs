import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoles, scaffoldRoles, subagentToolFilter, roleToolFilter } from "../dist/org/roles.js";
import { routeByKeywords, parseRoleId, buildDispatchPrompt } from "../dist/org/router.js";

// Hermetic HOME: loadRoles merges ~/.hara/roles + ~/.hara/org-roles (os.homedir() honors $HOME), so a
// developer's real global roles (e.g. the converted Claude-Code pack) must not leak into these tests.
process.env.HOME = mkdtempSync(join(tmpdir(), "hara-test-home-"));

test("subagentToolFilter: a write-granting role can NOT give a fan-out sub-agent edit/exec (no gate bypass)", () => {
  const ro = (n) => n === "read_file" || n === "grep" || n === "ls"; // the read-kind predicate
  const writeRole = subagentToolFilter({ allowTools: ["edit_file", "bash", "read_file"] }, ro);
  assert.equal(writeRole("edit_file"), false, "role can't grant edit to a sub-agent");
  assert.equal(writeRole("bash"), false, "role can't grant bash to a sub-agent");
  assert.equal(writeRole("read_file"), true, "a read tool the role allows is fine");
  assert.equal(writeRole("grep"), false, "a read tool the role didn't allow is narrowed out");
  const noRole = subagentToolFilter(undefined, ro);
  assert.equal(noRole("read_file"), true);
  assert.equal(noRole("edit_file"), false, "default sub-agent is read-only");
  const denyRole = subagentToolFilter({ denyTools: ["grep"] }, ro);
  assert.equal(denyRole("read_file"), true);
  assert.equal(denyRole("grep"), false, "denied even though read");
  assert.equal(denyRole("edit_file"), false, "still never write/exec");
});

function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), "hara-org-"));
  mkdirSync(join(dir, ".git"));
  scaffoldRoles(dir);
  return dir;
}

test("org: scaffold + load roles (frontmatter + tool restriction)", () => {
  const dir = freshRepo();
  try {
    const roles = loadRoles(dir);
    assert.deepEqual(roles.map((r) => r.id).sort(), ["docs", "implementer", "reviewer"]);
    const reviewer = roles.find((r) => r.id === "reviewer");
    assert.deepEqual(reviewer.allowTools, ["read_file", "grep", "glob", "ls", "codebase_search"]);
    assert.equal(reviewer.readOnly, true);
    assert.ok(reviewer.system.length > 0);
    assert.ok(reviewer.owns.includes("review"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reviewer/readOnly roles cannot smuggle writes through an allowed bash tool", () => {
  const filter = roleToolFilter({ id: "reviewer", description: "", owns: [], rejects: [], allowTools: ["read_file", "bash"], readOnly: true, system: "review" });
  assert.equal(filter("read_file"), true);
  for (const tool of ["bash", "edit_file", "write_file", "apply_patch", "computer", "external_agent", "memory_write", "send_file", "task"]) {
    assert.equal(filter(tool), false, `${tool} cannot bypass a read-only role even when dynamically registered`);
  }
});

test("role policies intersect allowTools and denyTools so an explicit deny always wins", () => {
  const role = { id: "mixed", description: "", owns: [], rejects: [], allowTools: ["read_file", "grep"], denyTools: ["grep"], system: "mixed" };
  const normal = roleToolFilter(role);
  assert.equal(normal("read_file"), true);
  assert.equal(normal("grep"), false, "deny wins over the simultaneous allow");
  assert.equal(normal("ls"), false, "the allow-list still narrows everything else");

  const sub = subagentToolFilter(role, () => true);
  assert.equal(sub("read_file"), true);
  assert.equal(sub("grep"), false, "sub-agents apply the same deny-over-allow rule");
});

test("org: keyword routing picks the owning role", () => {
  const dir = freshRepo();
  try {
    const roles = loadRoles(dir);
    assert.equal(routeByKeywords("please review the auth code for security bugs", roles)?.role.id, "reviewer");
    assert.equal(routeByKeywords("implement a new feature to add caching", roles)?.role.id, "implementer");
    assert.equal(routeByKeywords("update the readme docs", roles)?.role.id, "docs");
    assert.equal(routeByKeywords("xyzzy nothing matches here", roles), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("org: parseRoleId + dispatch prompt", () => {
  const dir = freshRepo();
  try {
    const roles = loadRoles(dir);
    assert.equal(parseRoleId("reviewer", roles)?.id, "reviewer");
    assert.equal(parseRoleId("I'd route this to the docs role", roles)?.id, "docs");
    assert.equal(parseRoleId("no such thing", roles), null);
    assert.ok(buildDispatchPrompt("x", roles).includes("implementer"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Claude-Code `.claude/agents` interop: tool-name translation + model-alias sanitizing ──

test("claudeTools: CC names map to hara names; 'All tools' means unrestricted", async () => {
  const { claudeTools } = await import("../dist/org/roles.js");
  assert.deepEqual(
    claudeTools("Read, Edit, Write, Bash, Grep, Glob"),
    ["read_file", "edit_file", "write_file", "bash", "grep", "glob"],
    "comma-string CC tools translate to hara tool names",
  );
  assert.deepEqual(claudeTools(["WebFetch", "read_file"]), ["web_fetch", "read_file"], "arrays + already-hara names pass through");
  assert.equal(claudeTools("All tools"), undefined, "'All tools' → unrestricted (no allowTools)");
  assert.equal(claudeTools("*"), undefined, "'*' → unrestricted");
  assert.equal(claudeTools(""), undefined, "empty → undefined");
});

test("loadRoles: a Claude-Code agent file yields usable hara allowTools + drops CC model aliases", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-cc-"));
  const ccDir = join(dir, ".claude", "agents");
  mkdirSync(ccDir, { recursive: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    join(ccDir, "cfo.md"),
    `---\nname: cfo\ndescription: finance data steward\ntools: Read, Edit, Write, Bash, Grep, Glob\nmodel: sonnet\n---\nYou are the CFO.`,
  );
  const roles = loadRoles(dir);
  const cfo = roles.find((r) => r.id === "cfo");
  assert.ok(cfo, "CC agent picked up from .claude/agents");
  assert.deepEqual(cfo.allowTools, ["read_file", "edit_file", "write_file", "bash", "grep", "glob"], "tools translated to hara names (the zero-toolbox bug)");
  assert.equal(cfo.model, undefined, "CC 'sonnet' alias dropped → inherit the session model");
  assert.equal(cfo.system, "You are the CFO.", "body becomes the persona");
  rmSync(dir, { recursive: true, force: true });
});
