import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeExecutionPolicy } from "../dist/agent-runtime/execution-policy.js";

const sha = value => createHash("sha256").update(value).digest("hex");
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "snapshot-safety-")));
  const work = join(root, "work"), home = join(root, "account"), outside = join(root, "outside");
  for (const path of [work, home, outside]) fs.mkdirSync(path);
  const policies = [];
  t.after(async () => {
    for (const policy of policies) await policy.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, work, home, outside, policy(tier = "full-protected") {
    const policy = createRuntimeExecutionPolicy({ runtimeId: "codex", tier, accountHome: home, workRoot: work, lifetime: "resident" });
    policies.push(policy); return policy;
  } };
}
function patchFs(t, overrides) {
  const originals = Object.fromEntries(Object.keys(overrides).map(key => [key, fs[key]]));
  Object.assign(fs, overrides); syncBuiltinESMExports();
  let restored = false;
  const restore = () => { if (!restored) { restored = true; Object.assign(fs, originals); syncBuiltinESMExports(); } };
  t.after(restore); return restore;
}

test("snapshot catches same-size content changes with restored mtime and keeps attempt evidence scoped", t => {
  const f = fixture(t), file = join(f.work, "answer.txt");
  fs.writeFileSync(file, "before"); fs.utimesSync(file, 1000000000, 1000000000);
  const before = fs.statSync(file, { bigint: true }), policy = f.policy();
  fs.writeFileSync(file, "after!"); fs.utimesSync(file, 1000000000, 1000000000);
  assert.equal(fs.statSync(file, { bigint: true }).mtimeNs, before.mtimeNs);
  assert.equal(policy.canCompleteConversation(), false);
  const evidence = policy.collectWorkspaceEvidence();
  assert.deepEqual(evidence.changes, [{ path: "answer.txt", change: "changed", before: sha("before"), after: sha("after!") }]);
  assert.equal(policy.collectWorkspaceEvidence().id, evidence.id);
  policy.beginAttempt("next-boundary");
  assert.equal(policy.collectWorkspaceEvidence(), null);
  assert.equal(policy.canCompleteConversation(), true);
  fs.writeFileSync(file, "later!");
  const next = policy.collectWorkspaceEvidence();
  assert.equal(next.attemptKey, "next-boundary"); assert.notEqual(next.id, evidence.id);
  assert.equal(next.changes[0].before, sha("after!"));
});

test("unchanged stat tuples never substitute for reading content (persistent mmap regression)", t => {
  // Darwin mmap can change bytes a second time without changing ctime/mtime before msync.
  // Replay the observed tuple deterministically; a real APFS canary is retained with the review evidence.
  const f = fixture(t), file = join(f.work, "mapped.txt"); fs.writeFileSync(file, "before");
  const originalLstat = fs.lstatSync, originalFstat = fs.fstatSync;
  const numberStamp = originalLstat(file), bigintStamp = originalLstat(file, { bigint: true });
  patchFs(t, {
    lstatSync(path, options) { return path === file ? options?.bigint ? bigintStamp : numberStamp : originalLstat(path, options); },
    fstatSync(fd, options) {
      const actual = originalFstat(fd, options);
      return actual.ino === (options?.bigint ? bigintStamp.ino : numberStamp.ino) ? options?.bigint ? bigintStamp : numberStamp : actual;
    },
  });
  const policy = f.policy(); assert.equal(policy.canCompleteConversation(), true);
  fs.writeFileSync(file, "after!");
  assert.equal(fs.lstatSync(file, { bigint: true }), bigintStamp);
  assert.equal(policy.canCompleteConversation(), false);
  const evidence = policy.collectWorkspaceEvidence();
  assert.equal(evidence.changes[0].before, sha("before"));
  assert.equal(evidence.changes[0].after, sha("after!"));
});

for (const mutation of ["mode", "inode"]) test(`snapshot rejects ${mutation}-only mutation and cannot credit a mixed diff`, t => {
  const f = fixture(t), file = join(f.work, "unchanged.txt"); fs.writeFileSync(file, "same", { mode: 0o644 });
  const original = fs.statSync(file, { bigint: true }), policy = f.policy();
  if (mutation === "mode") fs.chmodSync(file, 0o600);
  else { const replacement = join(f.work, "replacement"); fs.writeFileSync(replacement, "same", { mode: 0o644 }); fs.renameSync(replacement, file); }
  const changed = fs.statSync(file, { bigint: true });
  assert.notEqual(mutation === "mode" ? changed.mode : changed.ino, mutation === "mode" ? original.mode : original.ino);
  assert.equal(policy.canCompleteConversation(), false);
  assert.equal(policy.collectWorkspaceEvidence(), null);
  fs.writeFileSync(join(f.work, "other.txt"), "actual content effect");
  assert.equal(policy.collectWorkspaceEvidence(), null);
  policy.beginAttempt("acknowledged-new-baseline"); assert.equal(policy.canCompleteConversation(), true);
  fs.writeFileSync(join(f.work, "other.txt"), "new attempt effect");
  assert.equal(policy.collectWorkspaceEvidence().attemptKey, "acknowledged-new-baseline");
});

test("content plus permission mutation is unknown; an atomic content replacement with unchanged access remains a real effect", t => {
  const f = fixture(t), file = join(f.work, "answer.txt"); fs.writeFileSync(file, "before", { mode: 0o644 });
  const policy = f.policy();
  fs.writeFileSync(file, "after!"); fs.chmodSync(file, 0o600);
  assert.equal(policy.collectWorkspaceEvidence(), null);
  policy.beginAttempt("atomic-attempt");
  const replacement = join(f.work, "replacement"); fs.writeFileSync(replacement, "atomic", { mode: 0o600 }); fs.renameSync(replacement, file);
  assert.deepEqual(policy.collectWorkspaceEvidence().changes, [{ path: "answer.txt", change: "changed", before: sha("after!"), after: sha("atomic") }]);
});

for (const link of ["symbolic", "hard"]) test(`snapshot refuses a ${link} replacement even alongside a real file effect`, t => {
  const f = fixture(t), file = join(f.work, "answer.txt"), target = join(f.outside, "outside.txt");
  fs.writeFileSync(file, "before"); fs.writeFileSync(target, "after!");
  const policy = f.policy(); fs.unlinkSync(file);
  if (link === "symbolic") fs.symlinkSync(target, file); else fs.linkSync(target, file);
  fs.writeFileSync(join(f.work, "other.txt"), "real effect");
  assert.equal(policy.canCompleteConversation(), false);
  assert.equal(policy.collectWorkspaceEvidence(), null);
  if (link === "hard") assert.throws(() => f.policy(), /unsafe linked files/u);
  assert.equal(fs.readFileSync(target, "utf8"), "after!");
});

for (const mutation of ["mode", "inode"]) test(`snapshot invalidates ${mutation} change during content observation`, t => {
  const f = fixture(t), file = join(f.work, "answer.txt"); fs.writeFileSync(file, "before", { mode: 0o644 });
  const policy = f.policy(), expectedInode = fs.statSync(file).ino;
  fs.writeFileSync(file, "after!");
  const originalRead = fs.readFileSync, originalFstat = fs.fstatSync;
  let injected = false;
  patchFs(t, { readFileSync(fd, ...args) {
    const data = originalRead(fd, ...args);
    if (!injected && typeof fd === "number" && originalFstat(fd).ino === expectedInode) {
      injected = true;
      if (mutation === "mode") fs.chmodSync(file, 0o600);
      else { const replacement = join(f.outside, "replacement"); fs.writeFileSync(replacement, "after!", { mode: 0o644 }); fs.renameSync(file, join(f.outside, "saved-before")); fs.renameSync(replacement, file); }
    }
    return data;
  } });
  assert.equal(policy.collectWorkspaceEvidence(), null);
  assert.equal(injected, true);
});

test("snapshot rejects symlink parent swaps and keeps outside-delete risk observation", t => {
  const f = fixture(t), nested = join(f.work, "nested"), away = join(f.outside, "moved");
  fs.mkdirSync(nested); fs.writeFileSync(join(nested, "file.txt"), "before");
  const policy = f.policy(); fs.renameSync(nested, away); fs.symlinkSync(away, nested);
  assert.equal(policy.canCompleteConversation(), false); assert.equal(policy.collectWorkspaceEvidence(), null);
  policy.observeNativeEvent({ type: "file", status: "completed", path: "../outside/moved", operation: "delete" });
  assert.equal(policy.risks[0].kind, "outside-workspace-delete");
});

for (const limit of ["per-file", "total-bytes", "file-count"]) test(`snapshot stays incomplete beyond the ${limit} bound`, t => {
  const f = fixture(t);
  if (limit === "per-file") fs.writeFileSync(join(f.work, "large.txt"), Buffer.alloc(4 * 1024 * 1024 + 1));
  else if (limit === "total-bytes") {
    for (let i = 0; i < 8; i++) fs.writeFileSync(join(f.work, `f${i}.txt`), Buffer.alloc(4 * 1024 * 1024));
    fs.writeFileSync(join(f.work, "extra.txt"), "x");
  } else for (let i = 0; i < 4001; i++) fs.writeFileSync(join(f.work, `f${i}.txt`), "");
  const policy = f.policy();
  assert.equal(policy.canCompleteConversation(), false);
  fs.writeFileSync(join(f.work, "effect.txt"), "actual effect cannot repair an incomplete baseline");
  assert.equal(policy.collectWorkspaceEvidence(), null);
});

test("snapshot neither opens ignored credentials nor lets a native event invent N1", t => {
  const f = fixture(t);
  for (const name of [".env", "auth.json", ".credentials.json", "credentials.json", "oauth_creds.json"]) fs.writeFileSync(join(f.work, name), "SYNTHETIC_SECRET");
  const originalOpen = fs.openSync;
  patchFs(t, { openSync(path, ...args) { assert.ok(!String(path).startsWith(f.work + "/"), "credential-only fixture must not be opened"); return originalOpen(path, ...args); } });
  const policy = f.policy(); assert.equal(policy.canCompleteConversation(), true);
  policy.observeNativeEvent({ type: "file", status: "completed", path: "invented.txt", operation: "write" });
  assert.equal(policy.collectWorkspaceEvidence(), null); assert.equal(policy.canCompleteConversation(), false);
});

test("controlled tier and invalidated policies cannot issue workspace evidence", t => {
  const f = fixture(t), controlled = f.policy("controlled"), invalid = f.policy(); invalid.invalidateEvidence();
  fs.writeFileSync(join(f.work, "actual.txt"), "actual");
  assert.equal(controlled.collectWorkspaceEvidence(), null); assert.equal(invalid.collectWorkspaceEvidence(), null);
  assert.equal(invalid.canCompleteConversation(), false);
});
