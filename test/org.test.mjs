import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoles, scaffoldRoles, subagentToolFilter } from "../dist/org/roles.js";
import { routeByKeywords, parseRoleId, buildDispatchPrompt } from "../dist/org/router.js";

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
    assert.deepEqual(reviewer.allowTools, ["read_file", "bash"]);
    assert.ok(reviewer.system.length > 0);
    assert.ok(reviewer.owns.includes("review"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
