import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoles, scaffoldRoles } from "../dist/org/roles.js";
import { routeByKeywords, parseRoleId, buildDispatchPrompt } from "../dist/org/router.js";

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
