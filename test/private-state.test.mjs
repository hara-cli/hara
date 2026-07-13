import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensurePrivateHaraState,
  resetPrivateHaraStateForTests,
  tightenPrivateHaraState,
} from "../dist/security/private-state.js";

const mode = (path) => statSync(path).mode & 0o777;

test("private-state rejects a symlinked ~/.hara root without chmodding its target", { skip: process.platform === "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "hara-private-root-link-"));
  const target = join(home, "unrelated");
  mkdirSync(target);
  chmodSync(target, 0o777);
  symlinkSync(target, join(home, ".hara"));

  try {
    assert.throws(() => tightenPrivateHaraState(home), /\.hara.*symbolic link/i);
    assert.equal(mode(target), 0o777, "the symlink target must remain untouched");
  } finally {
    resetPrivateHaraStateForTests();
    rmSync(home, { recursive: true, force: true });
  }
});

test("private-state cap failures are explicit and a later startup call retries", { skip: process.platform === "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "hara-private-cap-"));
  const state = join(home, ".hara");
  const sessions = join(state, "sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "one.json"), "{}\n");
  writeFileSync(join(sessions, "two.json"), "{}\n");
  chmodSync(state, 0o777);
  chmodSync(sessions, 0o777);
  chmodSync(join(sessions, "one.json"), 0o666);
  chmodSync(join(sessions, "two.json"), 0o666);

  try {
    assert.throws(
      () => ensurePrivateHaraState(home, 2),
      /migration exceeded 2 entries.*incomplete permission repair/i,
    );
    unlinkSync(join(sessions, "two.json"));
    chmodSync(sessions, 0o777);
    chmodSync(join(sessions, "one.json"), 0o666);

    ensurePrivateHaraState(home, 2);
    assert.equal(mode(state), 0o700);
    assert.equal(mode(sessions), 0o700);
    assert.equal(mode(join(sessions, "one.json")), 0o600);

    chmodSync(join(sessions, "one.json"), 0o666);
    ensurePrivateHaraState(home, 2);
    assert.equal(mode(join(sessions, "one.json")), 0o666, "successful migration is cached only after completion");
  } finally {
    resetPrivateHaraStateForTests();
    rmSync(home, { recursive: true, force: true });
  }
});
