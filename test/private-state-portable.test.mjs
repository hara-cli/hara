import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { optionalPosixOpenFlag } from "../dist/fs-open-flags.js";
import { tightenPrivateDescriptorMode } from "../dist/fs-permissions.js";
import { sameOpenedFileIdentity } from "../dist/fs-identity.js";
import {
  PrivateStateConflictError,
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

test("Windows omits inapplicable descriptor chmod while POSIX remains fail-closed", () => {
  let calls = 0;
  const writeMode = (fd, mode) => {
    calls += 1;
    assert.equal(fd, 7);
    assert.equal(mode, 0o600);
  };
  tightenPrivateDescriptorMode(7, 0o600, "win32", writeMode);
  assert.equal(calls, 0, "Windows must not call fchmod on a native handle");

  tightenPrivateDescriptorMode(7, 0o600, "linux", writeMode);
  assert.equal(calls, 1, "POSIX keeps the descriptor-based mode fence");
  assert.throws(
    () => tightenPrivateDescriptorMode(7, 0o600, "darwin", () => {
      throw new Error("mode repair failed");
    }),
    /mode repair failed/,
    "POSIX mode failures must not be weakened to best-effort",
  );
});

test("Windows opened-file identity ignores synthetic device/mode but retains inode and link-count fences", () => {
  const expected = { dev: 7, ino: 11, mode: 0o600, nlink: 2 };
  assert.equal(
    privateStateFileIdentityMatches({ ...expected, dev: 0, mode: 0o666 }, expected, "win32"),
    true,
  );
  assert.equal(
    privateStateFileIdentityMatches({ ...expected, mode: 0o666 }, expected, "linux"),
    false,
  );
  assert.equal(sameOpenedFileIdentity({ dev: 0, ino: 11 }, expected, "win32"), true);
  assert.equal(sameOpenedFileIdentity({ dev: 0, ino: 11 }, expected, "linux"), false);
  for (const [field, value] of [["ino", 12], ["nlink", 1]]) {
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
    assert.throws(
      () => writePrivateStateFileSync(binding, '{"model":"stale"}\n', { expectedText: "{}\n" }),
      (error) => error instanceof PrivateStateConflictError,
    );
    assert.equal(
      readPrivateStateFileSnapshotSync(binding.path)?.text,
      '{"model":"test"}\n',
      "a stale compare-and-swap cannot overwrite current private state",
    );
    assert.deepEqual(
      readdirSync(join(home, ".hara")).filter((name) => name.startsWith(".hara-private-") || name.startsWith(".hara-claim-")),
      [],
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
