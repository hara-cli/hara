import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalize, isReadOnlyCommand, splitCompound, matchesPattern, decideCommand, loadPermissionRules } from "../dist/security/permissions.js";

test("canonicalize: unwrap bash -lc, strip env assignments + benign wrappers", () => {
  assert.equal(canonicalize(`bash -lc "npm test"`), "npm test");
  assert.equal(canonicalize("NODE_ENV=production npm run build"), "npm run build");
  assert.equal(canonicalize("timeout 30 npm test"), "npm test");
  assert.equal(canonicalize("  ls   -la  "), "ls -la");
});

test("isReadOnlyCommand: read-only yes; mutating / redirect / danger-flag no", () => {
  assert.equal(isReadOnlyCommand("ls -la"), true);
  assert.equal(isReadOnlyCommand("git status"), true);
  assert.equal(isReadOnlyCommand("grep -r foo src"), true);
  assert.equal(isReadOnlyCommand("git push"), false); // not a read-only git subcommand
  assert.equal(isReadOnlyCommand("cat a > b"), false); // output redirection
  assert.equal(isReadOnlyCommand("sed -i s/a/b/ f"), false); // -i in-place danger flag
  assert.equal(isReadOnlyCommand("rm -rf x"), false);
});

test("splitCompound: splits top-level operators; fails closed on substitution / unbalanced quotes", () => {
  assert.deepEqual(splitCompound("npm test && git commit"), ["npm test", "git commit"]);
  assert.deepEqual(splitCompound("ls | grep x ; pwd"), ["ls", "grep x", "pwd"]);
  assert.equal(splitCompound("echo $(rm -rf /)"), null); // command substitution
  assert.equal(splitCompound("echo `whoami`"), null); // backtick
  assert.equal(splitCompound(`echo "unbalanced`), null); // unbalanced quote
});

test("matchesPattern: exact, prefix, glob", () => {
  assert.equal(matchesPattern("npm test", "npm test"), true);
  assert.equal(matchesPattern("npm test -- --watch", "npm test"), true); // prefix match
  assert.equal(matchesPattern("npm install", "npm test"), false);
  assert.equal(matchesPattern("npm run lint", "npm run *"), true); // glob
  assert.equal(matchesPattern("git push origin main", "git push"), true);
});

test("decideCommand: deny > allow > read-only > ask; strictest part wins; substitution fails closed", () => {
  const rules = { allow: ["npm test", "git commit"], deny: ["git push", "rm -rf"], readonlyAutorun: true };
  assert.equal(decideCommand("npm test", rules), "allow");
  assert.equal(decideCommand("ls -la", rules), "allow"); // read-only autorun
  assert.equal(decideCommand("git push origin main", rules), "deny");
  assert.equal(decideCommand("npm publish", rules), "ask"); // unknown → ask
  assert.equal(decideCommand("npm test && git push", rules), "deny"); // strictest part (deny) wins
  assert.equal(decideCommand("npm test && npm publish", rules), "ask"); // allow + ask → ask
  assert.equal(decideCommand("echo $(rm -rf /)", rules), "ask"); // unparseable → fail closed to ask, never allow
  assert.equal(decideCommand("rm -rf /tmp/x", rules), "deny");
  const noAutorun = { allow: [], deny: [], readonlyAutorun: false };
  assert.equal(decideCommand("ls", noAutorun), "ask"); // read-only autorun off → ask
});

test("loadPermissionRules: merges global + project (deny union), project readonlyAutorun overrides", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-perm-"));
  const proj = mkdtempSync(join(tmpdir(), "hara-projperm-"));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    mkdirSync(join(home, ".hara"), { recursive: true });
    writeFileSync(join(home, ".hara", "permissions.json"), JSON.stringify({ allow: ["npm test"], deny: ["sudo"], readonlyAutorun: true }));
    writeFileSync(join(proj, "package.json"), "{}"); // project-root marker
    mkdirSync(join(proj, ".hara"), { recursive: true });
    writeFileSync(join(proj, ".hara", "permissions.json"), JSON.stringify({ allow: ["cargo build"], deny: ["git push"], readonlyAutorun: false }));
    const r = loadPermissionRules(proj);
    assert.deepEqual(r.allow.sort(), ["cargo build", "npm test"]);
    assert.deepEqual(r.deny.sort(), ["git push", "sudo"]);
    assert.equal(r.readonlyAutorun, false); // project overrides global
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});
