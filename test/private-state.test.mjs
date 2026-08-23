import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  linkSync,
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

test("private-state migration does not chmod an external hard-link target", { skip: process.platform === "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "hara-private-hardlink-"));
  const state = join(home, ".hara");
  const outside = join(home, "outside.json");
  mkdirSync(state);
  writeFileSync(outside, "{}\n");
  chmodSync(outside, 0o644);
  linkSync(outside, join(state, "config.json"));

  try {
    tightenPrivateHaraState(home);
    assert.equal(mode(outside), 0o644, "migration leaves the external inode mode untouched");
  } finally {
    resetPrivateHaraStateForTests();
    rmSync(home, { recursive: true, force: true });
  }
});

test("private-state migration leaves already-private file ctime unchanged", { skip: process.platform === "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "hara-private-stable-mode-"));
  const state = join(home, ".hara");
  const receipt = join(state, "plugin-receipt.json");
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(receipt, "{}\n", { mode: 0o600 });
  chmodSync(state, 0o700);
  chmodSync(receipt, 0o600);
  const before = statSync(receipt, { bigint: true }).ctimeNs;

  try {
    tightenPrivateHaraState(home);
    assert.equal(
      statSync(receipt, { bigint: true }).ctimeNs,
      before,
      "a correct 0600 receipt is not touched and remains valid for concurrent CAS removal",
    );
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
