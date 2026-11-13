import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
import { IMPORT_IMAGE_TOO_LARGE, IMPORT_LEFTOVER_AGE_MS, MAX_IMPORT_IMAGE_BYTES, sweepImportLeftovers } from "../dist/workspace/media.js";
import { MAX_IMPORT_CHUNK_BYTES, MediaImportSessions, parseMediaImportChunk } from "../dist/workspace/media-import.js";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const padded = (head, size) => Buffer.concat([head, Buffer.alloc(size - head.length, 7)]);
const split = bytes => { const out = []; for (let at = 0; at < bytes.length; at += MAX_IMPORT_CHUNK_BYTES) out.push(bytes.subarray(at, at + MAX_IMPORT_CHUNK_BYTES)); return out; };
const sources = () => fs.readFileSync(new URL("../src/serve/local-workspace.ts", import.meta.url), "utf8");

async function serve(t, extra = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-media-import-")));
  const handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0, cwd: root }, { root, version: "fixture", credentialVault: new MemoryCredentialVault(), ...extra });
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${handle.port}`), pending = new Map(); let serial = 0;
    socket.on("message", raw => { const value = JSON.parse(raw), wait = pending.get(value.id); if (wait) { pending.delete(value.id); value.error ? wait.reject(Error(value.error.message)) : wait.resolve(value.result); } });
    socket.on("close", () => { for (const wait of pending.values()) wait.reject(Error("socket closed")); pending.clear(); });
    await once(socket, "open");
    const rpc = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });
    return { socket, rpc };
  };
  const first = await connect(); const sockets = [first.socket];
  t.after(async () => { for (const socket of sockets) socket.terminate(); await handle.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const init = await first.rpc("initialize", { token: handle.token });
  const ws = await first.rpc("workspace.create", { label: "Paste", expectedRevision: init.workspace.revision });
  const scope = { workspaceId: ws.workspaceId, expectedGeneration: ws.resourceGeneration };
  const attachments = join(root, "project", ws.workspaceId, "attachments");
  const chunk = (bytes, mime, importId, index, extra = {}) => { const parts = split(bytes);
    return { ...scope, importId, mime, index, total: parts.length, bytes: bytes.length, chunkBase64: parts[index].toString("base64"), ...extra }; };
  const importAll = async (rpc, bytes, mime, importId = randomUUID()) => { const parts = split(bytes); let last;
    for (let index = 0; index < parts.length; index++) last = await rpc("workspace.media.import", chunk(bytes, mime, importId, index)); return last; };
  const second = async () => { const next = await connect(); sockets.push(next.socket); await next.rpc("initialize", { token: handle.token }); return next; };
  const leftovers = () => fs.existsSync(attachments) ? fs.readdirSync(attachments).filter(name => name.startsWith(".")) : [];
  return { root, handle, rpc: first.rpc, socket: first.socket, init, scope, attachments, chunk, importAll, second, leftovers };
}

test("a pasted image arrives in chunks under the RPC frame, lands in attachments/ under its content hash, and is registered and readable", async t => {
  const { rpc, init, scope, attachments, handle, importAll, chunk, leftovers } = await serve(t);
  assert(init.capabilities.includes("workspace.media.import.v1"));
  const result = await importAll(rpc, PNG, "image/png");
  assert.deepEqual(Object.keys(result).sort(), ["media", "path"]);
  assert.equal(result.path, join(attachments, `${hash(PNG)}.png`), "name is the content hash, never caller text");
  assert.deepEqual(fs.readFileSync(result.path), PNG);
  if (process.platform !== "win32") { assert.equal(fs.statSync(result.path).mode & 0o777, 0o600); assert.equal(fs.statSync(attachments).mode & 0o777, 0o700); }
  assert.equal(result.media.mime, "image/png"); assert.equal(result.media.bytes, PNG.length);
  assert.deepEqual(await rpc("workspace.media.describe", { ...scope, path: result.path }), { state: "ready", media: result.media }, "the path goes through the normal attachment flow");
  const served = await fetch(`http://127.0.0.1:${handle.port}/workspace-media/${result.media.id}`, { headers: { Authorization: `Bearer ${handle.token}` } });
  assert.equal(served.status, 200); assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);
  assert.deepEqual(await importAll(rpc, PNG, "image/png"), result, "the same image twice is one file and one registration");
  // Multi-chunk: intermediate chunks only acknowledge; exactly the limit is accepted.
  const big = padded(PNG, MAX_IMPORT_IMAGE_BYTES), id = randomUUID();
  assert.deepEqual(await rpc("workspace.media.import", chunk(big, "image/png", id, 0)), { received: 1 });
  assert.equal(fs.readdirSync(attachments).length, 1, "nothing is written before the last chunk");
  for (let index = 1; index < split(big).length - 1; index++) await rpc("workspace.media.import", chunk(big, "image/png", id, index));
  const done = await rpc("workspace.media.import", chunk(big, "image/png", id, split(big).length - 1));
  assert.equal(done.media.bytes, MAX_IMPORT_IMAGE_BYTES); assert.deepEqual(fs.readFileSync(done.path), big);
  const gif = await importAll(rpc, GIF, "image/gif"); assert.equal(gif.path, join(attachments, `${hash(GIF)}.gif`));
  assert.deepEqual(leftovers(), [], "no temp files remain");
});

test("over 3.6 MB is refused on the first chunk with image_too_large, and no further chunk is taken", async t => {
  const { rpc, scope, attachments } = await serve(t);
  const id = randomUUID(), declared = MAX_IMPORT_IMAGE_BYTES + 1, total = Math.ceil(declared / MAX_IMPORT_CHUNK_BYTES);
  const first = { ...scope, importId: id, mime: "image/png", index: 0, total, bytes: declared, chunkBase64: padded(PNG, MAX_IMPORT_CHUNK_BYTES).toString("base64") };
  await assert.rejects(rpc("workspace.media.import", first), error => error.message === IMPORT_IMAGE_TOO_LARGE);
  assert.match(IMPORT_IMAGE_TOO_LARGE, /^image_too_large: images are limited to 3\.6 MB \(3600000 bytes\)$/);
  await assert.rejects(rpc("workspace.media.import", { ...first, index: 1 }), error => error.message === IMPORT_IMAGE_TOO_LARGE, "later chunks of it are refused too");
  const small = padded(PNG, MAX_IMPORT_CHUNK_BYTES * 2);
  await assert.rejects(rpc("workspace.media.import", { ...first, index: 1, total: 2, bytes: small.length, chunkBase64: small.subarray(MAX_IMPORT_CHUNK_BYTES).toString("base64") }), /import_aborted: chunk out of order/, "nothing was staged for it");
  assert.equal(fs.existsSync(attachments) ? fs.readdirSync(attachments).length : 0, 0);
});

test("chunks out of order, duplicated, or not matching the import discard the whole import; a new import replaces an abandoned one", async t => {
  const { rpc, chunk, attachments, leftovers } = await serve(t);
  const big = padded(PNG, MAX_IMPORT_CHUNK_BYTES * 3), id = randomUUID();
  await rpc("workspace.media.import", chunk(big, "image/png", id, 0));
  await assert.rejects(rpc("workspace.media.import", chunk(big, "image/png", id, 2)), /import_aborted: chunk out of order/);
  await assert.rejects(rpc("workspace.media.import", chunk(big, "image/png", id, 1)), /import_aborted: chunk out of order/, "the import is gone");
  const dup = randomUUID();
  await rpc("workspace.media.import", chunk(big, "image/png", dup, 0));
  await assert.rejects(rpc("workspace.media.import", chunk(big, "image/png", dup, 0)), /import_aborted: duplicate chunk/);
  await assert.rejects(rpc("workspace.media.import", chunk(big, "image/png", dup, 1)), /import_aborted: chunk out of order/);
  const shift = randomUUID();
  await rpc("workspace.media.import", chunk(big, "image/png", shift, 0));
  await assert.rejects(rpc("workspace.media.import", chunk(big, "image/png", shift, 1, { mime: "image/gif" })), /import_aborted: chunk does not match/);
  const short = randomUUID();
  await rpc("workspace.media.import", chunk(big, "image/png", short, 0));
  await assert.rejects(rpc("workspace.media.import", chunk(big, "image/png", short, 1, { chunkBase64: PNG.toString("base64") })), /import_aborted: chunk size/);
  // One import per connection: a new import's first chunk replaces an abandoned one (review of Desk #103, M1),
  // so a user who switched workspace mid-paste can paste again at once.
  const a = randomUUID(), b = randomUUID();
  await rpc("workspace.media.import", chunk(big, "image/png", a, 0));
  assert.equal((await rpc("workspace.media.import", chunk(PNG, "image/png", b, 0))).media.bytes, PNG.length, "the new image imports at once");
  await assert.rejects(rpc("workspace.media.import", chunk(big, "image/png", a, 1)), /import_aborted: chunk out of order/, "the abandoned import is gone");
  const c = randomUUID(), d = randomUUID();
  await rpc("workspace.media.import", chunk(big, "image/png", c, 0));
  await assert.rejects(rpc("workspace.media.import", chunk(big, "image/png", d, 1)), /import_aborted: unknown import/, "a new import must start at chunk 0");
  await assert.rejects(rpc("workspace.media.import", chunk(big, "image/png", c, 1)), /import_aborted: chunk out of order/, "and the staged one is dropped");
  assert.equal(fs.readdirSync(attachments).length, 1); assert.deepEqual(leftovers(), []);
});

test("a forged mime (bytes that are not that image) is refused after the last chunk and nothing is written", async t => {
  const { rpc, importAll, attachments, leftovers } = await serve(t);
  await assert.rejects(importAll(rpc, PNG, "image/jpeg"), /media unavailable/);
  await assert.rejects(importAll(rpc, padded(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), 200_000), "image/png"), /media unavailable/);
  await assert.rejects(importAll(rpc, GIF, "image/webp"), /media unavailable/);
  assert.equal(fs.existsSync(attachments) ? fs.readdirSync(attachments).length : 0, 0); assert.deepEqual(leftovers(), []);
});

test("requests are strict: extra fields, other types, bad ids and non-canonical base64 are refused", async t => {
  const { rpc, chunk } = await serve(t);
  const ok = chunk(PNG, "image/png", randomUUID(), 0);
  await assert.rejects(rpc("workspace.media.import", { ...ok, name: "../../evil.png" }), /unsupported/, "callers cannot name the file");
  await assert.rejects(rpc("workspace.media.import", { ...ok, path: "/tmp/x.png" }), /unsupported/);
  for (const mime of ["image/svg+xml", "text/plain", "application/pdf", "video/mp4", "image/heic", "", "constructor", "__proto__"]) await assert.rejects(rpc("workspace.media.import", { ...ok, mime }), /Invalid Workspace media import/, mime);
  for (const bad of [{ importId: "x" }, { index: -1 }, { index: 1 }, { total: 0 }, { total: 2 }, { bytes: 0 }, { index: 0.5 }, { chunkBase64: "" }, { chunkBase64: ok.chunkBase64.replace(/=+$/, "") }, { chunkBase64: ` ${ok.chunkBase64}` },
    { chunkBase64: "A".repeat(Math.ceil(MAX_IMPORT_CHUNK_BYTES / 3) * 4 + 4) }]) await assert.rejects(rpc("workspace.media.import", { ...ok, ...bad }), /Invalid Workspace media import/, JSON.stringify(bad).slice(0, 60));
});

test("a stale generation is refused and drops what was staged", async t => {
  const { rpc, chunk } = await serve(t);
  const big = padded(PNG, MAX_IMPORT_CHUNK_BYTES * 2), id = randomUUID();
  await assert.rejects(rpc("workspace.media.import", chunk(big, "image/png", id, 0, { expectedGeneration: "stale" })), /generation changed/);
  await rpc("workspace.media.import", chunk(big, "image/png", id, 0));
  await assert.rejects(rpc("workspace.media.import", chunk(big, "image/png", id, 1, { expectedGeneration: "stale" })), /generation changed/);
  await assert.rejects(rpc("workspace.media.import", chunk(big, "image/png", id, 1)), /import_aborted: chunk out of order/, "staged chunks were dropped");
  const sessions = new MediaImportSessions(60_000), parsed = parseMediaImportChunk(chunk(big, "image/png", id, 0));
  sessions.accept("c", parsed);
  assert.throws(() => sessions.accept("c", { ...parseMediaImportChunk(chunk(big, "image/png", id, 1)), generation: "g2" }), /import_aborted: workspace generation changed/);
  assert.equal(sessions.has("c"), false);
});

test("60 seconds without a chunk drops the import (shortened here)", async t => {
  const { rpc, chunk } = await serve(t, { mediaImportIdleMs: 150 });
  const big = padded(PNG, MAX_IMPORT_CHUNK_BYTES * 2), id = randomUUID();
  await rpc("workspace.media.import", chunk(big, "image/png", id, 0));
  await new Promise(resolve => setTimeout(resolve, 400));
  await assert.rejects(rpc("workspace.media.import", chunk(big, "image/png", id, 1)), /import_aborted: chunk out of order/);
  assert.match(sources(), /new MediaImportSessions\(input\.mediaImportIdleMs\)/); assert.match(fs.readFileSync(new URL("../src/workspace/media-import.ts", import.meta.url), "utf8"), /MEDIA_IMPORT_IDLE_MS = 60_000/);
});

test("disconnecting drops the staged import; another connection cannot continue it", async t => {
  const { rpc, socket, chunk, second } = await serve(t);
  const big = padded(PNG, MAX_IMPORT_CHUNK_BYTES * 2), id = randomUUID();
  await rpc("workspace.media.import", chunk(big, "image/png", id, 0));
  socket.terminate(); await once(socket, "close");
  const other = await second();
  await assert.rejects(other.rpc("workspace.media.import", chunk(big, "image/png", id, 1)), /import_aborted: chunk out of order/);
  assert.match(sources(), /ws\.on\("close", \(\) => \{ mediaImports\.discard\(client\.id\);/);
  const sessions = new MediaImportSessions(60_000), staged = parseMediaImportChunk(chunk(big, "image/png", id, 0));
  sessions.accept("c", staged); sessions.discard("c");
  assert.equal(sessions.has("c"), false); assert.ok(staged.chunk.every(byte => byte === 0), "dropped bytes are wiped");
});

test("import never follows a link: a planted link under the hash name or as attachments/ itself is refused and its target untouched", { skip: process.platform === "win32" }, async t => {
  const { rpc, root, attachments, importAll, leftovers } = await serve(t);
  const outside = join(root, "outside.png"); fs.writeFileSync(outside, "keep");
  fs.mkdirSync(attachments, { mode: 0o700 });
  fs.symlinkSync(outside, join(attachments, `${hash(PNG)}.png`));
  await assert.rejects(importAll(rpc, PNG, "image/png"), /media unavailable/);
  assert.equal(fs.readFileSync(outside, "utf8"), "keep");
  assert.ok(fs.lstatSync(join(attachments, `${hash(PNG)}.png`)).isSymbolicLink(), "the planted link is refused, not replaced");
  assert.deepEqual(leftovers(), []);
  fs.rmSync(attachments, { recursive: true });
  const elsewhere = join(root, "elsewhere"); fs.mkdirSync(elsewhere, { mode: 0o700 });
  fs.symlinkSync(elsewhere, attachments);
  await assert.rejects(importAll(rpc, PNG, "image/png"), /not a real directory|refusing/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test("a torn earlier file under the hash name is atomically replaced; a hard-linked one is refused", { skip: process.platform === "win32" }, async t => {
  const { rpc, root, attachments, importAll, leftovers } = await serve(t);
  fs.mkdirSync(attachments, { mode: 0o700 });
  const target = join(attachments, `${hash(PNG)}.png`);
  fs.writeFileSync(target, PNG.subarray(0, 10), { mode: 0o600 });
  assert.deepEqual(fs.readFileSync((await importAll(rpc, PNG, "image/png")).path), PNG);
  fs.rmSync(target); const other = join(root, "other.png"); fs.writeFileSync(other, PNG); fs.linkSync(other, target);
  await assert.rejects(importAll(rpc, PNG, "image/png"), /media unavailable/);
  assert.deepEqual(fs.readFileSync(other), PNG); assert.deepEqual(leftovers(), []);
});

test("a non-canonical padding character and a last chunk short of the declared size are refused (review of #70, N1)", async t => {
  const { rpc, chunk, attachments } = await serve(t);
  const canonical = PNG.toString("base64"); assert.match(canonical, /[A-Za-z0-9+/]==$/);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", at = canonical.length - 3;
  const forged = canonical.slice(0, at) + alphabet[alphabet.indexOf(canonical[at]) + 1] + "==";
  assert.deepEqual(Buffer.from(forged, "base64"), PNG, "Node decodes it to the same bytes");
  await assert.rejects(rpc("workspace.media.import", chunk(PNG, "image/png", randomUUID(), 0, { chunkBase64: forged })), /Invalid Workspace media import/);
  await assert.rejects(rpc("workspace.media.import", chunk(PNG, "image/png", randomUUID(), 0, { bytes: PNG.length + 5 })), /import_aborted: final size does not match/);
  assert.equal(fs.existsSync(attachments) ? fs.readdirSync(attachments).length : 0, 0);
});

test("temp files left by a crashed import are removed when the workspace is opened again, and nothing else (review of #70, N3)", { skip: process.platform === "win32" }, async () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-media-sweep-")));
  const open = async () => {
    const handle = await startLocalWorkspaceServe({ host: "127.0.0.1", port: 0, cwd: root }, { root, version: "fixture", credentialVault: new MemoryCredentialVault() });
    const socket = new WebSocket(`ws://127.0.0.1:${handle.port}`), pending = new Map(); let serial = 0;
    socket.on("message", raw => { const value = JSON.parse(raw), wait = pending.get(value.id); if (wait) { pending.delete(value.id); value.error ? wait.reject(Error(value.error.message)) : wait.resolve(value.result); } });
    await once(socket, "open");
    const rpc = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); });
    const init = await rpc("initialize", { token: handle.token });
    return { rpc, init, close: async () => { socket.terminate(); await handle.close(); } };
  };
  try {
    const first = await open(), ws = await first.rpc("workspace.create", { label: "Sweep", expectedRevision: first.init.workspace.revision });
    const attachments = join(root, "project", ws.workspaceId, "attachments");
    const kept = await (async () => { const id = randomUUID(); return first.rpc("workspace.media.import", { workspaceId: ws.workspaceId, expectedGeneration: ws.resourceGeneration, importId: id, mime: "image/png", index: 0, total: 1, bytes: PNG.length, chunkBase64: PNG.toString("base64") }); })();
    await first.close();
    const outside = join(root, "outside.txt"); fs.writeFileSync(outside, "keep");
    const debris = `.import-${"a".repeat(32)}`, linked = `.import-${"b".repeat(32)}`, folder = `.import-${"c".repeat(32)}`, fresh = `.import-${"d".repeat(32)}`, suffixed = `.import-${"e".repeat(32)}.png`;
    fs.writeFileSync(join(attachments, debris), "partial"); fs.symlinkSync(outside, join(attachments, linked)); fs.mkdirSync(join(attachments, folder));
    fs.writeFileSync(join(attachments, ".import-short"), "not ours"); fs.writeFileSync(join(attachments, "notes.txt"), "user file");
    fs.writeFileSync(join(attachments, suffixed), "same prefix, longer name"); fs.writeFileSync(join(attachments, fresh), "another Host is writing this");
    const old = new Date(Date.now() - 60 * 60_000);
    for (const name of [debris, folder, suffixed, ".import-short"]) fs.utimesSync(join(attachments, name), old, old);
    fs.lutimesSync(join(attachments, linked), old, old);
    const second = await open();
    await second.rpc("workspace.snapshot", { workspaceId: ws.workspaceId, agentId: null });
    assert.deepEqual(fs.readdirSync(attachments).sort(), [folder, ".import-short", suffixed, fresh, `${hash(PNG)}.png`, "notes.txt"].sort(),
      "only old, exact temp names that are files or links go; a prefix-alike name (review of #72, ②) and a fresh temp file another Host may be writing stay");
    assert.equal(fs.readFileSync(outside, "utf8"), "keep", "a link is removed, never followed");
    assert.deepEqual(fs.readFileSync(kept.path), PNG);
    await second.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the sweep never reaches through attachments/ when it is itself a link (review of #72, ①)", { skip: process.platform === "win32" }, () => {
  const root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "hara-media-sweep-link-")));
  try {
    const target = join(root, "elsewhere"), attachments = join(root, "attachments"); fs.mkdirSync(target);
    const name = `.import-${"f".repeat(32)}`, old = new Date(Date.now() - 60 * 60_000);
    fs.writeFileSync(join(target, name), "not ours"); fs.utimesSync(join(target, name), old, old);
    fs.symlinkSync(target, attachments);
    assert.equal(sweepImportLeftovers(attachments), 0);
    assert.deepEqual(fs.readdirSync(target), [name], "the linked directory's contents are untouched");
    fs.rmSync(attachments); fs.renameSync(target, attachments);
    assert.equal(sweepImportLeftovers(attachments), 1, "the same file in a real attachments/ is swept");
    fs.writeFileSync(join(attachments, name), "fresh");
    assert.equal(sweepImportLeftovers(attachments), 0, "a temp file younger than 10 minutes is kept");
    assert.equal(sweepImportLeftovers(attachments, Date.now() + IMPORT_LEFTOVER_AGE_MS + 1000), 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the sweep runs when a workspace context is opened (source)", () => {
  const host = fs.readFileSync(new URL("../src/workspace/local-host.ts", import.meta.url), "utf8");
  assert.match(host, /const project = storage\.run\(\(\) => ensurePrivateStateSubdirectory\(this\.root, \["project", row\.scope\.workspaceId\]\)\.path\);\n.*\n\s+storage\.run\(\(\) => sweepImportLeftovers\(join\(project, "attachments"\)\)\);/);
});
