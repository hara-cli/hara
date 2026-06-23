import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { subdirHint } from "../dist/context/subdir-hints.js";

function tmpProject() {
  const root = mkdtempSync(join(tmpdir(), "hara-subdir-"));
  writeFileSync(join(root, "package.json"), "{}"); // project-root marker
  return root;
}

test("subdirHint: loads a touched subdir's AGENTS.md once, then nothing for the same dir", () => {
  const cwd = tmpProject();
  try {
    mkdirSync(join(cwd, "pkg", "api"), { recursive: true });
    writeFileSync(join(cwd, "pkg", "api", "AGENTS.md"), "API package: use fastify.");
    const h1 = subdirHint({ path: "pkg/api/server.ts" }, cwd);
    assert.match(h1, /API package: use fastify/);
    assert.match(h1, /pkg\/api/);
    assert.equal(subdirHint({ path: "pkg/api/other.ts" }, cwd), ""); // same dir → already loaded
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("subdirHint: CLAUDE.md via a shell-command path; ignores cwd-level + outside paths + no-path", () => {
  const cwd = tmpProject();
  try {
    mkdirSync(join(cwd, "growth"), { recursive: true });
    writeFileSync(join(cwd, "growth", "CLAUDE.md"), "Growth: ASO rules here.");
    assert.match(subdirHint({ command: "cat growth/keywords.md" }, cwd), /Growth: ASO rules here/);
    assert.equal(subdirHint({ path: "README.md" }, cwd), ""); // file at cwd → already covered by startup load
    assert.equal(subdirHint({ path: "/etc/hosts" }, cwd), ""); // outside the project
    assert.equal(subdirHint({}, cwd), ""); // no path in the call
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
