// A8 fence cost: lock entries skip directory fsync, read-side fences are deduplicated only inside one
// synchronous frame, and tracked directories are re-verified by a pinned component chain. Every negative
// case here must keep failing closed; the counters prove the cost actually went away.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs, {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { bindPrivateHaraStateFile, withPrivateStateLockSync, writePrivateStateFileSync } from "../dist/security/private-state.js";
import {
  WorkspaceResourceStorage, bindWorkspaceResourceFile, inspectWorkspaceResourceFile, workspaceResourceCommitGuard,
  workspaceResourceDirectory, workspaceResourceScopeKey, workspaceStateHome,
} from "../dist/workspace/resource-context.js";

const temporary = [];
after(() => { for (const target of temporary) rmSync(target, { recursive: true, force: true }); });
function dir(prefix = "hara-a8-") { const value = realpathSync.native(mkdtempSync(join(tmpdir(), prefix))); temporary.push(value); return value; }
const scope = () => ({ schemaVersion: 1, workspaceId: `ws_${randomUUID()}`, authority: { kind: "local", localAuthorityId: randomUUID() } });

/** Storage whose authority callback counts full fences (checkAuthority runs once per full assertCurrent). */
function fixture() {
  const home = dir(), s = scope();
  const fence = { full: 0, revoked: false, flag: undefined };
  const storage = new WorkspaceResourceStorage(home, s, () => {
    fence.full++;
    if (fence.revoked) throw new Error("synthetic authority revoked");
    if (fence.flag && fs.readFileSync(fence.flag, "utf8") === "revoked\n") throw new Error("synthetic catalog revoked");
  });
  storage.initialize();
  const partition = join(home, ".hara", "workspace-data", "v1", workspaceResourceScopeKey(s));
  const state = storage.run(() => workspaceStateHome());
  return { home, storage, fence, marker: join(partition, "scope.json"), state };
}

function deadPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid;
    child.once("error", reject);
    child.once("close", () => resolve(pid));
  });
}

function counting(owner, key, run) {
  const original = owner[key];
  let calls = 0;
  owner[key] = function (...args) { calls++; return original.apply(this, args); };
  if (owner === fs) syncBuiltinESMExports();
  try { run(); } finally { owner[key] = original; if (owner === fs) syncBuiltinESMExports(); }
  return calls;
}

const lockArtifacts = directory => readdirSync(directory).filter(name => name.includes(".hara-lock-") || name.endsWith(".lock") || name.endsWith(".reclaim"));

// ---------------------------------------------------------------- 1. lock entries

test("A8-1 a lock acquire+release fsyncs only the record bytes, never the directory", () => {
  const home = dir();
  withPrivateStateLockSync(home, ["locks"], "warm", () => {}); // create directories outside the count
  const calls = counting(fs, "fsyncSync", () => withPrivateStateLockSync(home, ["locks"], "probe", () => {}));
  assert.equal(calls, 1, "exactly the staged lock record content fsync remains");
  assert.deepEqual(lockArtifacts(join(home, ".hara", "locks")), []);
});

test("A8-1 power-loss residue: a complete dead-owner record without companion is reclaimed", async () => {
  const home = dir(), pid = await deadPid();
  withPrivateStateLockSync(home, ["locks"], "warm", () => {});
  const directory = join(home, ".hara", "locks");
  writeFileSync(join(directory, "r.lock"), `${JSON.stringify({ pid, token: randomUUID() })}\n`, { mode: 0o600 });
  let ran = false;
  withPrivateStateLockSync(home, ["locks"], "r", () => { ran = true; }, { attempts: 50, waitMs: 1 });
  assert.equal(ran, true);
  assert.deepEqual(lockArtifacts(directory), []);
});

test("A8-1 power-loss residue: an orphan companion alone does not block or alias a new owner", async () => {
  const home = dir(), pid = await deadPid();
  withPrivateStateLockSync(home, ["locks"], "warm", () => {});
  const directory = join(home, ".hara", "locks"), token = randomUUID();
  const orphan = join(directory, `.hara-lock-${pid}-${token}.tmp`);
  writeFileSync(orphan, `${JSON.stringify({ pid, token })}\n`, { mode: 0o600 });
  let ran = false;
  withPrivateStateLockSync(home, ["locks"], "r", () => { ran = true; }, { attempts: 5, waitMs: 1 });
  assert.equal(ran, true);
  assert.equal(existsSync(join(directory, "r.lock")), false, "the new owner released its own entry");
  assert.equal(existsSync(orphan), true, "an unrelated orphan is never mistaken for ownership");
});

test("A8-1 torn or empty lock records still fail closed (why the record fsync stays)", () => {
  for (const text of ["", "{\"pid\":", "\0\0\0\0"]) {
    const home = dir();
    withPrivateStateLockSync(home, ["locks"], "warm", () => {});
    const lock = join(home, ".hara", "locks", "r.lock");
    writeFileSync(lock, text, { mode: 0o600 });
    assert.throws(() => withPrivateStateLockSync(home, ["locks"], "r", () => assert.fail("must not run"), { attempts: 3, waitMs: 1 }), /busy|binary/, "fails closed (busy, or refused as binary)");
    assert.equal(existsSync(lock), true, "a malformed record is preserved, not reclaimed");
  }
});

test("A8-1 symlinked, hard-linked and non-private lock entries are still refused", async () => {
  const pid = await deadPid();
  const cases = {
    symlink: (lock, directory) => { const target = join(directory, "elsewhere"); writeFileSync(target, `${JSON.stringify({ pid, token: randomUUID() })}\n`, { mode: 0o600 }); symlinkSync(target, lock); },
    hardlink: (lock, directory) => { const target = join(directory, "elsewhere"); writeFileSync(target, `${JSON.stringify({ pid, token: randomUUID() })}\n`, { mode: 0o600 }); linkSync(target, lock); },
    mode: lock => writeFileSync(lock, `${JSON.stringify({ pid, token: randomUUID() })}\n`, { mode: 0o644 }),
  };
  for (const [name, plant] of Object.entries(cases)) {
    const home = dir();
    withPrivateStateLockSync(home, ["locks"], "warm", () => {});
    const directory = join(home, ".hara", "locks"), lock = join(directory, "r.lock");
    plant(lock, directory);
    if (name === "mode") chmodSync(lock, 0o644);
    assert.throws(() => withPrivateStateLockSync(home, ["locks"], "r", () => assert.fail(`${name} lock must not run`), { attempts: 3, waitMs: 1 }), `${name} lock refused`);
    assert.equal(fs.lstatSync(lock) !== undefined, true, `${name} entry is preserved for inspection`);
  }
});

// ---------------------------------------------------------------- 2. synchronous frame

test("A8-2 one synchronous run() frame does two full fences however many reads it makes", () => {
  const f = fixture();
  const path = f.storage.run(() => join(workspaceStateHome(), ".hara", "frame", "file.json"));
  f.storage.run(() => { workspaceResourceDirectory(["frame"]); writePrivateStateFileSync(bindWorkspaceResourceFile(path), "{}\n", { expectedMissing: true }); });
  f.storage.run(() => inspectWorkspaceResourceFile(path, 4096)); // warm the binding cache
  f.fence.full = 0;
  const seen = f.storage.run(() => {
    for (let i = 0; i < 5; i++) workspaceStateHome();
    for (let i = 0; i < 3; i++) assert.equal(inspectWorkspaceResourceFile(path, 4096).snapshot.text, "{}\n");
    return workspaceStateHome();
  });
  assert.equal(seen, f.state);
  assert.equal(f.fence.full, 2, "entry + exit only");
});

test("A8-2 frame dedup never crosses an await: the continuation re-fences and sees revocation", async () => {
  const f = fixture();
  f.fence.full = 0;
  await f.storage.run(async () => {
    workspaceStateHome();
    assert.equal(f.fence.full, 1, "synchronous prefix is inside the entry-fenced frame");
    await Promise.resolve();
    workspaceStateHome();
    assert.equal(f.fence.full, 2, "after await there is no frame: full fence");
    f.fence.revoked = true;
    await new Promise(resolve => setImmediate(resolve));
    assert.throws(() => workspaceStateHome(), /synthetic authority revoked/);
  }).then(() => assert.fail("settlement fence must reject"), error => assert.match(String(error), /synthetic authority revoked/));
});

test("A8-2 a marker replaced across await is caught by the next read, not by a stale frame", async () => {
  const f = fixture();
  await assert.rejects(f.storage.run(async () => {
    workspaceStateHome();
    await Promise.resolve();
    writeFileSync(f.marker, "{\"replaced\":true}\n");
    workspaceStateHome();
    assert.fail("replaced marker must be rejected");
  }), /scope marker changed/);
});

test("A8-2 continuations queued from inside a frame never inherit it (FIFO microtasks)", async () => {
  const f = fixture();
  const observed = [];
  f.storage.run(() => {
    queueMicrotask(() => { try { workspaceStateHome(); observed.push("ok"); } catch (error) { observed.push(String(error)); } });
    Promise.resolve().then(() => { try { workspaceStateHome(); observed.push("ok"); } catch (error) { observed.push(String(error)); } });
  });
  f.fence.revoked = true; // after the frame closed, before any queued continuation runs
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed.length, 2);
  for (const result of observed) assert.match(result, /synthetic authority revoked/);
});

test("A8-2 the commit guard and a binding's assertCurrent are never deduplicated", () => {
  const f = fixture();
  const path = f.storage.run(() => join(workspaceStateHome(), ".hara", "g.json"));
  f.storage.run(() => bindWorkspaceResourceFile(path));
  let checkedInside = false;
  assert.throws(() => f.storage.run(() => {
    const guard = workspaceResourceCommitGuard(), binding = bindWorkspaceResourceFile(path);
    const before = f.fence.full;
    guard(); guard(); binding.assertCurrent();
    assert.equal(f.fence.full, before + 3);
    workspaceStateHome();
    assert.equal(f.fence.full, before + 3, "only the read-side fence is framed");
    writeFileSync(f.marker, "{\"replaced\":true}\n");
    assert.throws(() => guard(), /scope marker changed/, "commit guard sees a cross-process change inside the frame");
    assert.throws(() => writePrivateStateFileSync(binding, "{}\n", { expectedMissing: true, assertCurrent: guard }), /scope marker changed/);
    assert.equal(existsSync(path), false, "nothing was committed");
    checkedInside = true;
  }), /scope marker changed/, "and the frame exit still fails");
  assert.equal(checkedInside, true);
});

test("A8-2 a cross-process change inside a frame is rejected at frame exit and the result is discarded", () => {
  const f = fixture();
  assert.throws(() => f.storage.run(() => {
    workspaceStateHome();
    writeFileSync(f.marker, "{\"replaced\":true}\n");
    workspaceStateHome(); // framed read; the exit fence below decides
    return "must-not-escape";
  }), /scope marker changed/);
  assert.throws(() => f.storage.run(() => {}), /scope marker changed/, "and every later entry fails");
});

test("A8-2 an in-process private-state write inside the frame forces the next read to fence fully", () => {
  const f = fixture();
  const flagHome = dir();
  const flag = bindPrivateHaraStateFile(flagHome, ["catalog"], "flag.json");
  writePrivateStateFileSync(flag, "active\n", { expectedMissing: true });
  f.fence.flag = flag.path;
  assert.throws(() => f.storage.run(() => {
    workspaceStateHome();
    const before = f.fence.full;
    workspaceStateHome();
    assert.equal(f.fence.full, before, "deduplicated while nothing was mutated in-process");
    writePrivateStateFileSync(flag, "revoked\n", { expectedText: "active\n" }); // in-process revocation
    workspaceStateHome();
    assert.fail("in-process revocation must be seen inside the same frame");
  }), /synthetic catalog revoked/);
});

test("A8-2 leaf directory identity is still checked on every framed read (inode, symlink, permission)", () => {
  const mutations = {
    inode: (directory) => { renameSync(directory, `${directory}.moved`); mkdirSync(directory, { mode: 0o700 }); },
    symlink: (directory) => { renameSync(directory, `${directory}.moved`); symlinkSync(`${directory}.moved`, directory); },
    permission: (directory) => chmodSync(directory, 0o755),
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const f = fixture();
    const directory = f.storage.run(() => workspaceResourceDirectory(["leaf"]));
    const path = join(directory, "file.json");
    f.storage.run(() => writePrivateStateFileSync(bindWorkspaceResourceFile(path), "{}\n", { expectedMissing: true }));
    let reachedAfterMutation = false;
    assert.throws(() => f.storage.run(() => {
      inspectWorkspaceResourceFile(path, 4096);
      mutate(directory);
      try { inspectWorkspaceResourceFile(path, 4096); } catch (error) { reachedAfterMutation = true; throw error; }
      assert.fail(`${name}: framed read after mutation must fail immediately`);
    }), `${name} rejected`);
    assert.equal(reachedAfterMutation, true, `${name}: the read itself failed, not only the exit fence`);
  }
});

// ---------------------------------------------------------------- 3. pinned component chain
