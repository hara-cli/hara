import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
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

test("subdirHint: a local AGENTS.md symlink to .env is never injected", () => {
  const cwd = tmpProject();
  try {
    mkdirSync(join(cwd, "pkg", "secret"), { recursive: true });
    writeFileSync(join(cwd, ".env"), "SUBDIR_SECRET=must-not-leak\n");
    symlinkSync(join(cwd, ".env"), join(cwd, "pkg", "secret", "AGENTS.md"));
    const hint = subdirHint({ path: "pkg/secret/code.ts" }, cwd);
    assert.doesNotMatch(hint, /must-not-leak/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("subdirHint: oversized local instructions retain their prefix and marker within the 8 KiB total budget", () => {
  const cwd = tmpProject();
  try {
    mkdirSync(join(cwd, "pkg", "large"), { recursive: true });
    writeFileSync(join(cwd, "pkg", "large", "AGENTS.md"), `LOCAL-PREFIX\n${"约束🙂".repeat(8_000)}\nLOCAL-TAIL-MUST-DROP`);
    const hint = subdirHint({ path: "pkg/large/code.ts" }, cwd);
    assert.match(hint, /LOCAL-PREFIX/);
    assert.match(hint, /truncated to subdirectory-context budget/);
    assert.doesNotMatch(hint, /LOCAL-TAIL-MUST-DROP/);
    assert.ok(Buffer.byteLength(hint, "utf8") <= 8 * 1024);
    assert.doesNotMatch(hint, /�$/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
