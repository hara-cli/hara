import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteText, FileChangedError } from "../dist/fs-write.js";

function fixture() {
  return mkdtempSync(join(tmpdir(), "hara-atomic-write-"));
}

test("atomicWriteText preserves mode and refuses to overwrite a stale edit base", async () => {
  const dir = fixture();
  try {
    const path = join(dir, "script.sh");
    writeFileSync(path, "old\n");
    chmodSync(path, 0o755);

    await assert.rejects(
      atomicWriteText(path, "new\n", { expected: "different\n" }),
      (error) => error instanceof FileChangedError,
    );
    assert.equal(readFileSync(path, "utf8"), "old\n", "stale writes leave the destination untouched");
    assert.ok(!readdirSync(dir).some((name) => name.includes(".hara-")), "failed writes clean their staging file");

    await atomicWriteText(path, "new\n", { expected: "old\n" });
    assert.equal(readFileSync(path, "utf8"), "new\n");
    assert.equal(lstatSync(path).mode & 0o777, 0o755, "executable bit survives replacement");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWriteText create-if-absent never clobbers and edits through symlinks", async () => {
  const dir = fixture();
  try {
    const target = join(dir, "target.txt");
    const link = join(dir, "link.txt");
    writeFileSync(target, "target-v1");
    symlinkSync(target, link);

    await atomicWriteText(link, "target-v2", { expected: "target-v1" });
    assert.ok(lstatSync(link).isSymbolicLink(), "editing a symlink does not replace the link itself");
    assert.equal(readFileSync(target, "utf8"), "target-v2");

    await assert.rejects(
      atomicWriteText(target, "clobbered", { expected: null }),
      (error) => error instanceof FileChangedError,
    );
    assert.equal(readFileSync(target, "utf8"), "target-v2", "create-if-absent preserves the existing file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
