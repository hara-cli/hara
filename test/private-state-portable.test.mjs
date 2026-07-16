import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { optionalPosixOpenFlag } from "../dist/fs-open-flags.js";
import {
  bindPrivateHaraStateFile,
  privateStateFileIdentityMatches,
  readPrivateStateFileSnapshotSync,
  writePrivateStateFileSync,
} from "../dist/security/private-state.js";

test("Windows never receives POSIX-only open flags exposed by an alternate runtime", () => {
  for (const flag of ["O_DIRECTORY", "O_NOFOLLOW", "O_NONBLOCK"]) {
    assert.equal(optionalPosixOpenFlag(flag, "win32"), 0, `${flag} must be omitted on Windows`);
  }
});

test("Windows file identity ignores synthetic mode but retains dev, inode and link-count fences", () => {
  const expected = { dev: 7, ino: 11, mode: 0o600, nlink: 2 };
  assert.equal(
    privateStateFileIdentityMatches({ ...expected, mode: 0o666 }, expected, "win32"),
    true,
  );
  assert.equal(
    privateStateFileIdentityMatches({ ...expected, mode: 0o666 }, expected, "linux"),
    false,
  );
  for (const [field, value] of [["dev", 8], ["ino", 12], ["nlink", 1]]) {
    assert.equal(
      privateStateFileIdentityMatches({ ...expected, [field]: value }, expected, "win32"),
      false,
      `${field} remains a Windows identity fence`,
    );
  }
});

test("private-state creates and replaces a file without leaking staging entries", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-private-portable-"));
  try {
    const binding = bindPrivateHaraStateFile(home, [], "config.json");
    writePrivateStateFileSync(binding, "{}\n");
    assert.equal(readPrivateStateFileSnapshotSync(binding.path)?.text, "{}\n");

    writePrivateStateFileSync(binding, '{"model":"test"}\n');
    assert.equal(readPrivateStateFileSnapshotSync(binding.path)?.text, '{"model":"test"}\n');
    assert.deepEqual(
      readdirSync(join(home, ".hara")).filter((name) => name.startsWith(".hara-private-") || name.startsWith(".hara-claim-")),
      [],
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
