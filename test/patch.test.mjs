import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyEdits } from "../dist/tools/apply-core.js";
import { getTool } from "../dist/tools/registry.js";
import "../dist/tools/patch.js";

test("apply_patch: a mid-write failure rolls back — never leaves a half-patched tree", async () => {
  const d = mkdtempSync(join(tmpdir(), "hara-patch-rb-"));
  try {
    const a = join(d, "a.txt");
    writeFileSync(a, "original A\n");
    // change A (succeeds) then create a file UNDER a.txt — a.txt is a file, so mkdir fails in Phase 2,
    // AFTER A was written. True atomicity requires A to be rolled back.
    const res = await getTool("apply_patch").run(
      {
        changes: [
          { type: "update", path: "a.txt", content: "CHANGED A\n" },
          { type: "create", path: "a.txt/b.txt", content: "B\n" },
        ],
      },
      { cwd: d },
    );
    assert.match(res, /rolled back|failed/i, "reports the failure + rollback");
    assert.equal(readFileSync(a, "utf8"), "original A\n", "A is restored — not left half-patched");
    assert.ok(!existsSync(join(d, "a.txt", "b.txt")), "B was not created");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("applyEdits: sequential edits + replace_all", () => {
  const r = applyEdits("a b a", [{ old_string: "a", new_string: "X", replace_all: true }]);
  assert.ok(!("error" in r));
  assert.equal(r.text, "X b X");
  assert.equal(r.total, 2);
  const r2 = applyEdits("a\nb", [{ old_string: "a", new_string: "1" }, { old_string: "b", new_string: "2" }]);
  assert.equal(r2.text, "1\n2");
});

test("applyEdits: errors on not-found / identical / empty", () => {
  assert.ok("error" in applyEdits("hello", [{ old_string: "x", new_string: "y" }]));
  assert.ok("error" in applyEdits("ab", [{ old_string: "a", new_string: "a" }]));
  assert.ok("error" in applyEdits("ab", []));
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hara-patch-"));
  writeFileSync(join(dir, "a.txt"), "alpha");
  writeFileSync(join(dir, "b.txt"), "beta");
  return dir;
}

test("apply_patch: atomic — one bad change writes nothing", async () => {
  const dir = fixture();
  try {
    const out = await getTool("apply_patch").run(
      {
        changes: [
          { path: "a.txt", edits: [{ old_string: "alpha", new_string: "X" }] },
          { path: "b.txt", edits: [{ old_string: "NOPE", new_string: "Y" }] }, // fails
        ],
      },
      { cwd: dir },
    );
    assert.match(out, /Error/);
    assert.match(out, /Nothing written/);
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "alpha"); // unchanged despite being valid
    assert.equal(readFileSync(join(dir, "b.txt"), "utf8"), "beta");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("apply_patch: multi-file update + create + delete", async () => {
  const dir = fixture();
  try {
    const out = await getTool("apply_patch").run(
      {
        changes: [
          { path: "a.txt", edits: [{ old_string: "alpha", new_string: "ALPHA" }] },
          { path: "c.txt", type: "create", content: "gamma" },
          { path: "b.txt", type: "delete" },
        ],
      },
      { cwd: dir },
    );
    assert.match(out, /3 file/);
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "ALPHA");
    assert.equal(readFileSync(join(dir, "c.txt"), "utf8"), "gamma");
    assert.ok(!existsSync(join(dir, "b.txt")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
