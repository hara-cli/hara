import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
const { WindowsDpapiCredentialVault, bundledWindowsCredentialWorker, CredentialVaultError } = await import(process.env.HARA_VAULT_CANARY_MODULE || "../dist/workspace/windows-credential-vault.js");
const native = process.platform === "win32" && process.arch === "x64" && process.env.GITHUB_ACTIONS === "true" && process.env.HARA_WINDOWS_VAULT_CANARY === "1";
test("Windows adapter refuses unsupported platforms before resolving any helper", { skip: process.platform === "win32" }, () => {
  assert.throws(() => new WindowsDpapiCredentialVault(os.tmpdir()), e => e instanceof CredentialVaultError && e.code === "unsupported");
});
test("vault errors expose only stable code and retry", () => {
  assert.equal(new CredentialVaultError("write_unconfirmed").retry, "readback_only");
  assert.equal(new CredentialVaultError("unsupported").retry, "none");
  assert.equal(new CredentialVaultError("access_denied").retry, "explicit_user_only");
});
test("real Windows DPAPI worker and Node adapter boundary", { skip: !native, timeout: 180_000 }, async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "hara-vault-canary-"));
  const canonical = fs.realpathSync.native(home).replaceAll("/", "\\");
  const ns = createHash("sha256").update("hara-host-home-v1\0").update(canonical).digest("hex");
  const root = path.join(process.env.LOCALAPPDATA, "Hara", "credential-vault", "v1", ns);
  const bundle = bundledWindowsCredentialWorker(); const vault = new WindowsDpapiCredentialVault(home);
  const refs = new Set();
  const remember = ref => { refs.add(ref); return ref; };
  const filename = ref => path.join(root, createHash("sha256").update(ref).digest("hex") + ".bin");
  const secret = "canary-" + randomBytes(24).toString("hex");
  const code = expected => e => e instanceof CredentialVaultError && e.code === expected && !e.message.includes(secret);
  t.after(() => { for (const ref of refs) vault.remove(ref); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); });
  await t.test("probe uses real CurrentUser DPAPI; absent is distinct from backend failure", () => {
    vault.probe(); assert.equal(vault.get("canary:absent"), undefined);
  });
  await t.test("full UTF16 limit, Unicode, lone surrogates, escaping and immutable old refs roundtrip", () => {
    for (const [i, value] of [secret, "x".repeat(16384), "🐧".repeat(8192), "\ud800a\udfff", `q'"\\z`].entries()) {
      const ref = remember(`canary:unicode.${i}`); vault.set(ref, value);
      assert.ok(vault.get(ref) === value, "exact UTF16 value preserved");
      assert.ok(!fs.readFileSync(filename(ref)).includes(Buffer.from(value, "utf16le")), "disk contains ciphertext");
    }
    const old = remember("canary:old"); const next = remember("canary:next"); vault.set(old, secret); vault.set(next, secret + "2");
    assert.ok(vault.get(old) === secret, "old ref preserved"); vault.set(next, secret + "3"); assert.ok(vault.get(next) === secret + "3", "same-ref replacement confirmed");
  });
  await t.test("one bounded frame accepts 256 maximum UTF16 keys; invalid batches do not mutate", () => {
    const entries = Array.from({ length: 256 }, (_, i) => ({ ref: remember(`batch:max.${i}`.padEnd(240, "r")), key: "🐧".repeat(8192) }));
    vault.setMany(entries); for (const entry of entries) assert.ok(vault.get(entry.ref) === entry.key, "batch exact readback");
    assert.throws(() => vault.setMany([...entries, { ref: "batch:extra", key: secret }]), code("invalid_request"));
    assert.throws(() => vault.setMany([{ ref: "a:x", key: secret }, { ref: "b:x", key: secret }]), code("invalid_request"));
    for (const key of ["", "x".repeat(16385), "has space", "nul\0", "tab\t", "x\u200ay"]) assert.throws(() => vault.set("invalid:key", key), code("invalid_request"));
    assert.equal(vault.get("invalid:key"), undefined);
  });
  await t.test("ciphertext corruption and wrong reference fail without deleting originals", () => {
    const a = remember("binding:a"), b = remember("binding:b"); vault.set(a, secret); vault.set(b, secret + "b");
    const original = fs.readFileSync(filename(a)), other = fs.readFileSync(filename(b));
    const corrupt = Buffer.from(original); corrupt[corrupt.length - 1] ^= 1;
    fs.writeFileSync(filename(a), corrupt); assert.throws(() => vault.get(a), code("credential_unreadable"));
    assert.ok(fs.readFileSync(filename(a)).equals(corrupt), "unreadable original preserved");
    fs.writeFileSync(filename(a), original); fs.writeFileSync(filename(b), original);
    assert.throws(() => vault.get(b), code("credential_unreadable")); fs.writeFileSync(filename(b), other);
    assert.ok(vault.get(a) === secret, "original remains readable");
  });
  await t.test("a ciphertext from another Host-home namespace cannot be silently rebound", () => {
    const second = fs.mkdtempSync(path.join(os.tmpdir(), "hara-vault-other-")); const otherVault = new WindowsDpapiCredentialVault(second);
    const otherCanonical = fs.realpathSync.native(second).replaceAll("/", "\\");
    const otherNs = createHash("sha256").update("hara-host-home-v1\0").update(otherCanonical).digest("hex");
    const otherRoot = path.join(path.dirname(root), otherNs); const ref = remember("binding:home");
    try { vault.set(ref, secret); otherVault.set(ref, secret + "other");
      fs.writeFileSync(path.join(otherRoot, path.basename(filename(ref))), fs.readFileSync(filename(ref)));
      assert.throws(() => otherVault.get(ref), code("credential_unreadable"));
    } finally { otherVault.remove(ref); fs.rmSync(otherRoot, { recursive: true, force: true }); fs.rmSync(second, { recursive: true, force: true }); }
  });
  await t.test("private DACL rejects a broadened file ACL, then recovers only after explicit repair", () => {
    const ref = remember("security:acl"); vault.set(ref, secret); const file = filename(ref);
    const run = args => { const r = spawnSync("icacls.exe", args, { windowsHide: true, stdio: "pipe" }); assert.ok(!r.error && r.status === 0, "fixture ACL command"); };
    run([file, "/grant", "*S-1-1-0:(R)"]);
    try { assert.throws(() => vault.get(ref), code("access_denied")); }
    finally { run([file, "/remove:g", "*S-1-1-0"]); }
    assert.ok(vault.get(ref) === secret, "repaired private ACL accepted");
  });
  await t.test("actual file IO refuses hardlinks and file symlinks", () => {
    const ref = remember("security:links"); vault.set(ref, secret); const file = filename(ref); const extra = file + ".extra";
    fs.linkSync(file, extra); try { assert.throws(() => vault.get(ref), code("access_denied")); assert.throws(() => vault.remove(ref), code("access_denied")); }
    finally { fs.unlinkSync(extra); }
    fs.renameSync(file, extra); try { fs.symlinkSync(extra, file, "file"); assert.throws(() => vault.get(ref), code("access_denied")); }
    finally { if (fs.existsSync(file)) fs.unlinkSync(file); fs.renameSync(extra, file); }
    assert.ok(vault.get(ref) === secret, "link refusal preserved original ciphertext");
  });
  await t.test("namespace junction is refused at actual directory open", () => {
    const saved = root + ".original"; fs.renameSync(root, saved);
    try { fs.symlinkSync(saved, root, "junction"); assert.throws(() => vault.get("canary:absent"), code("access_denied")); }
    finally { if (fs.existsSync(root)) fs.rmdirSync(root); fs.renameSync(saved, root); }
  });
  await t.test("native framing rejects oversized, truncated and trailing requests without echo", () => {
    const bad = [Buffer.from([255,255,255,127]), Buffer.alloc(60), Buffer.concat([Buffer.from([55,0,0,0]), Buffer.alloc(55), Buffer.from([1])])];
    for (const input of bad) { const result = spawnSync(bundle.path, [], { input, timeout: 5000, maxBuffer: 1024, windowsHide: true });
      assert.ok(result.status !== 0 && result.stdout?.length === 0 && result.stderr?.length === 0, "invalid frame is silent and fails"); }
  });
  await t.test("helper tamper or missing bundle never falls back or executes", () => {
    const invalid = new WindowsDpapiCredentialVault(home, { ...bundle, sha256: "0".repeat(64) });
    assert.throws(() => invalid.set("invalid:helper", secret), code("unavailable")); assert.equal(vault.get("invalid:helper"), undefined);
  });
  await t.test("timeouts, truncated replies, output overflow and exits retain unknown state without retry", () => {
    const fixtureSource = process.env.HARA_VAULT_FAILURE_FIXTURE;
    assert.ok(fixtureSource && path.isAbsolute(fixtureSource), "compiled fixture supplied by CI");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hara-vault-failure-"));
    const helper = path.join(dir, "hara-credential-worker.exe"); fs.copyFileSync(fixtureSource, helper);
    const failing = new WindowsDpapiCredentialVault(home, { path: helper, sha256: createHash("sha256").update(fs.readFileSync(helper)).digest("hex") });
    const attempt = (mode, op, expected) => {
      fs.writeFileSync(path.join(dir, "mode"), mode); fs.writeFileSync(path.join(dir, "counter"), Buffer.alloc(4));
      assert.throws(op, code(expected));
      assert.equal(fs.readFileSync(path.join(dir, "counter")).readUInt32LE(), 1, "one dispatch, no automatic retry");
    };
    try {
      attempt("timeout", () => failing.set("unknown:timeout", secret), "write_unconfirmed");
      attempt("exit", () => failing.setMany([{ ref: "unknown:a", key: secret }, { ref: "unknown:b", key: secret }]), "write_unconfirmed");
      attempt("exit", () => failing.remove("unknown:remove"), "cleanup_unconfirmed");
      attempt("invalid", () => failing.get("unknown:get"), "unavailable");
      attempt("oversize", () => failing.set("unknown:overflow", secret), "write_unconfirmed");
      assert.equal(vault.get("unknown:timeout"), undefined, "failure fixture did not touch the real vault");
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  await t.test("remove is confirmed and missing removal is idempotent", () => {
    const ref = remember("canary:remove"); vault.set(ref, secret); vault.remove(ref); vault.remove(ref); assert.equal(vault.get(ref), undefined);
  });
});
