import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { WorkspaceRuntimeInstaller } from "../dist/workspace/runtime-install.js";
import { WorkspaceResourceStorage, workspaceResourceDirectory, workspaceStateHome } from "../dist/workspace/resource-context.js";
import { runtimeArchiveMember } from "../dist/workspace/runtime-archive.js";
import { resolveOfficialRuntimeArtifact } from "../dist/workspace/runtime-catalog.js";
import { native, tar, zip } from "./runtime-fixtures.mjs";
const temporary = [];
after(() => { for (const path of temporary) fs.rmSync(path, { recursive: true, force: true }); });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function storage(home) {
  if (!home) { home = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-runtime-install-"))); temporary.push(home); }
  const value = new WorkspaceResourceStorage(home, { schemaVersion: 1, workspaceId: `ws_${randomUUID()}`, authority: { kind: "local", localAuthorityId: randomUUID() } }); value.initialize(); return value;
}
async function fixture(options = {}) {
  const bytes = options.bytes ?? native(), archive = options.format === "zip" ? zip([{ name: "tool", bytes }]) : options.format === "tar.gz" ? tar([{ name: "tool", bytes }]) : bytes;
  let downloads = 0;
  const server = createServer((request, response) => { downloads++; if (options.hold) { response.writeHead(200); response.write(Buffer.from([0])); return; }
    if (options.redirect) { response.writeHead(302, { location: options.redirect }); response.end(); return; }
    response.writeHead(200, { "content-length": archive.length }); response.end(archive);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, resource = options.storage ?? storage();
  const descriptor = id => ({ runtimeId: id, version: "1.2.3", target: { platform: process.platform, arch: process.arch }, url: `${origin}/${id}`, sha256: options.badHash ? "f".repeat(64) : hash(archive), format: options.format ?? "raw", member: options.format ? "tool" : null, maxBytes: options.maxBytes ?? archive.length });
  const installer = new WorkspaceRuntimeInstaller(resource, { fixtureOrigin: origin, onChange: options.onChange, resolveArtifact: async id => ({ ...descriptor(id), ...options.descriptor }) });
  return { installer, resource, descriptor, downloads: () => downloads, async close() { await installer.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
async function settled(installer, id) {
  const until = Date.now() + 4000;
  while (Date.now() < until) { const operation = installer.list().operations.find(row => row.id === id); if (operation?.state !== "downloading") return operation; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error("Local installer did not settle");
}
for (const [id, format] of [["opencode", "zip"], ["codex", "tar.gz"], ["claude", undefined]]) test(`${id}: approve → local download → digest/native verification → scoped registration/restart`, async () => {
  const f = await fixture({ format }); try {
    const declined = await f.installer.propose(id, "client", () => {}); assert.equal(f.downloads(), 0); assert.equal(f.installer.approve(declined.id, false, "client").state, "declined"); assert.equal(f.downloads(), 0);
    const card = await f.installer.propose(id, "client", () => {}); assert.equal(card.sha256, f.descriptor(id).sha256); assert.equal(card.origin, new URL(f.descriptor(id).url).origin);
    assert.throws(() => f.installer.approve(card.id, true, "foreign"), /unsafe/); assert.equal(f.downloads(), 0);
    const receipt = f.installer.approve(card.id, true, "client"); assert.throws(() => f.installer.approve(card.id, true, "client"), /unsafe/);
    assert.equal((await settled(f.installer, receipt.operationId)).state, "registered"); assert.equal(f.downloads(), 1);
    const executable = f.installer.resolve(id, "1.2.3", card.sha256); assert.deepEqual(fs.readFileSync(executable.command), native());
    for (const key of ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR"]) assert.ok(executable.env[key].startsWith(f.resource.run(() => workspaceStateHome())));
    assert.equal(f.installer.list().options.find(row => row.runtimeId === id).generalAgentDriverAvailable, false);
    const reopened = new WorkspaceRuntimeInstaller(f.resource, { fixtureOrigin: card.origin });
    assert.equal(reopened.resolve(id, "1.2.3", card.sha256).command, executable.command); assert.equal(f.downloads(), 1); await reopened.close();
    if (process.platform !== "win32") fs.chmodSync(executable.command, 0o700); fs.writeFileSync(executable.command, native(process.platform, process.arch === "arm64" ? "x64" : "arm64")); if (process.platform !== "win32") fs.chmodSync(executable.command, 0o500);
    assert.throws(() => f.installer.resolve(id, "1.2.3", card.sha256), /unsafe/); assert.equal(f.installer.list().options.find(row => row.runtimeId === id).state, "integrity_failed");
  } finally { await f.close(); }
});
for (const [label, options] of [["wrong digest", { badHash: true }], ["wrong CPU", { bytes: native(process.platform, process.arch === "arm64" ? "x64" : "arm64") }], ["oversize", { maxBytes: 64 }], ["untrusted redirect", { redirect: "http://localhost:9/not-allowed" }]]) test(`${label}: failed verification never registers or resolves`, async () => {
  const f = await fixture(options); try { const card = await f.installer.propose("codex", "client", () => {}), receipt = f.installer.approve(card.id, true, "client");
    assert.equal((await settled(f.installer, receipt.operationId)).state, "failed"); assert.equal(f.installer.list().revision, 0); assert.throws(() => f.installer.resolve("codex", "1.2.3", card.sha256));
  } finally { await f.close(); }
});
test("stale approval, blocked source and close refuse without a download", async () => {
  const f = await fixture(); try { let current = true; const card = await f.installer.propose("claude", "client", () => { if (!current) throw new Error("stale"); }); current = false;
    assert.throws(() => f.installer.approve(card.id, true, "client"), /stale/); f.installer.dismiss("client"); assert.equal(f.downloads(), 0); await f.installer.close();
    await assert.rejects(f.installer.propose("codex", "client", () => {}));
  } finally { await f.close(); }
  for (const url of ["http://127.0.0.1:9/tool", "https://evil.invalid/tool", "https://github.com/tool?secret=x", "https://user:pass@github.com/tool"]) {
    const value = new WorkspaceRuntimeInstaller(storage(), { resolveArtifact: async id => ({ runtimeId: id, version: "1.2.3", target: { platform: process.platform, arch: process.arch }, url, sha256: "a".repeat(64), format: "raw", member: null, maxBytes: 128 }) });
    await assert.rejects(value.propose("codex", "client", () => {})); await value.close();
  }
});
test("cancel drains without registration; changing a foreground view does not retarget approved work", async () => {
  const f = await fixture({ hold: true }); try { let view = true; const card = await f.installer.propose("codex", "client", () => { assert.equal(view, true); }); const receipt = f.installer.approve(card.id, true, "client"); view = false;
    f.installer.cancel(receipt.operationId); assert.equal((await settled(f.installer, receipt.operationId)).state, "cancelled"); assert.equal(f.installer.list().revision, 0);
  } finally { await f.close(); }
});
test("copied registry and linked executable cannot cross Workspace boundaries", async () => {
  const f = await fixture(); try { const card = await f.installer.propose("claude", "client", () => {}), receipt = f.installer.approve(card.id, true, "client"); await settled(f.installer, receipt.operationId);
    const file = f.installer.resolve("claude", "1.2.3", card.sha256).command, copied = storage();
    const statePath = resource => resource.run(() => join(workspaceStateHome(), ".hara/runtime-installations-v1.json"));
    fs.copyFileSync(statePath(f.resource), statePath(copied)); if (process.platform !== "win32") fs.chmodSync(statePath(copied), 0o600);
    const other = new WorkspaceRuntimeInstaller(copied, { fixtureOrigin: card.origin }); assert.throws(() => other.list(), /unsafe/); await other.close();
    const link = `${file}-linked`; fs.linkSync(file, link); assert.throws(() => f.installer.resolve("claude", "1.2.3", card.sha256), /unsafe/); fs.unlinkSync(link);
    const kept = `${file}-kept`; fs.renameSync(file, kept); fs.symlinkSync(kept, file); assert.throws(() => f.installer.resolve("claude", "1.2.3", card.sha256), /unsafe/);
  } finally { await f.close(); }
});
test("metadata proposals are bounded, and close aborts their original fetches without creating cards", async () => {
  let requests = 0;
  const installer = new WorkspaceRuntimeInstaller(storage(), { resolveArtifact: async (_id, _target, signal) => {
    requests++; return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled metadata")), { once: true }));
  } });
  const pending = Array.from({ length: 16 }, () => assert.rejects(installer.propose("codex", "client", () => {}), /cancelled/));
  await assert.rejects(installer.propose("codex", "client", () => {}), /unsafe/); assert.equal(requests, 16);
  await installer.close(); await Promise.all(pending); assert.equal(installer.list().revision, 0);
});
test("unsafe pre-existing output is preserved, never overwritten; observer failure cannot undo a verified registration", async () => {
  const f = await fixture(); try {
    const descriptor = f.descriptor("codex"), directory = f.resource.run(() => workspaceResourceDirectory(["runtime-installations", "codex", descriptor.version, descriptor.sha256]));
    const file = join(directory, process.platform === "win32" ? "codex.exe" : "codex"); fs.writeFileSync(file, "partial-retained", { mode: 0o600 });
    const card = await f.installer.propose("codex", "client", () => {}), receipt = f.installer.approve(card.id, true, "client");
    assert.equal((await settled(f.installer, receipt.operationId)).state, "failed"); assert.equal(fs.readFileSync(file, "utf8"), "partial-retained"); assert.equal(f.installer.list().revision, 0);
  } finally { await f.close(); }
  const g = await fixture({ onChange() { throw new Error("observer disconnected"); } }); try {
    const card = await g.installer.propose("claude", "client", () => {}), receipt = g.installer.approve(card.id, true, "client");
    assert.equal((await settled(g.installer, receipt.operationId)).state, "registered"); assert.ok(g.installer.resolve("claude", "1.2.3", card.sha256));
  } finally { await g.close(); }
});
test("bounded archive reader rejects links/traversal/duplicate/malformed metadata, accepts inert exact members", () => {
  const bytes = native();
  for (const make of [tar, zip]) {
    assert.deepEqual(runtimeArchiveMember(make([{ name: "tool", bytes }]), make === tar ? "tar.gz" : "zip", "tool"), bytes);
    for (const entries of [[{ name: "../tool", bytes }], [{ name: "tool", bytes }, { name: "tool", bytes }], [{ name: "/tool", bytes }], [{ name: "tool", bytes, type: "2", mode: 0xa1ff }]]) assert.throws(() => runtimeArchiveMember(make(entries), make === tar ? "tar.gz" : "zip", "tool"));
  }
  assert.deepEqual(runtimeArchiveMember(zip([{ name: "tool", bytes, method: 8 }]), "zip", "tool"), bytes);
  const corrupt = zip([{ name: "tool", bytes }]); corrupt[31 + "tool".length] ^= 1; assert.throws(() => runtimeArchiveMember(corrupt, "zip", "tool"), /checksum/);
  for (const raw of [Buffer.alloc(0), Buffer.alloc(64)]) assert.throws(() => runtimeArchiveMember(raw, "zip", "tool"));
  assert.throws(() => runtimeArchiveMember(bytes, "raw", "tool"));
});
test("vendor catalog freezes stable release checksums; missing/ambiguous identity fails closed", async () => {
  for (const id of ["codex", "opencode", "claude"]) {
    const target = { platform: "darwin", arch: "arm64" }, checksum = "a".repeat(64), name = id === "codex" ? "codex-aarch64-apple-darwin.tar.gz" : "opencode-darwin-arm64.zip", repo = id === "codex" ? "openai/codex" : "anomalyco/opencode", tag = id === "codex" ? "rust-v1.2.3" : "v1.2.3";
    const read = async url => Buffer.from(url.endsWith("/stable") ? "1.2.3" : JSON.stringify(url.endsWith("manifest.json") ? { platforms: { "darwin-arm64": { checksum } } } : { tag_name: tag, assets: [{ name, size: 128, digest: `sha256:${checksum}`, browser_download_url: `https://github.com/${repo}/releases/download/${tag}/${name}` }] }));
    const descriptor = await resolveOfficialRuntimeArtifact(id, target, read); assert.equal(descriptor.sha256, checksum); assert.equal(descriptor.version, "1.2.3");
    await assert.rejects(resolveOfficialRuntimeArtifact(id, target, async () => Buffer.from("{}")));
    await assert.rejects(resolveOfficialRuntimeArtifact(id, { platform: "win32", arch: "arm64" }, read));
  }
});

test("Antigravity has no official download artifact", async () => {
 await assert.rejects(resolveOfficialRuntimeArtifact("agy",{platform:process.platform,arch:process.arch},async()=>{throw new Error("network must not be used")}),/local detection and registration/);
});
