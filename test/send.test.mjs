import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, writeFileSync, readFileSync, existsSync, lstatSync, rmSync, statSync, symlinkSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// send_file self-gates on HARA_GATEWAY at import time → set it (and an outbox) before importing the module.
process.env.HARA_GATEWAY = "test";
const dir = mkdtempSync(join(tmpdir(), "hara-send-"));
const outbox = join(dir, "outbox.txt");
process.env.HARA_GATEWAY_OUTBOX = outbox;

const { getTool } = await import("../dist/tools/registry.js");
await import("../dist/tools/send.js"); // registers send_file because HARA_GATEWAY is set
const {
  OUTBOUND_BATCH_MAX_BYTES,
  OUTBOUND_BATCH_MAX_FILES,
  OUTBOUND_FILE_MAX_BYTES,
  cleanupOutboundSnapshot,
  cleanupOutboundSnapshots,
  consumeOutboundSnapshots,
} = await import("../dist/gateway/outbound-files.js");
const { telegramAdapter } = await import("../dist/gateway/telegram.js");

test("send_file: queues an owner-only immutable snapshot rather than the source pathname", async () => {
  const tool = getTool("send_file");
  assert.ok(tool, "send_file is registered when HARA_GATEWAY is set");
  const f = join(dir, "pic.png");
  writeFileSync(f, "x");
  const r = await tool.run({ path: f }, { cwd: dir });
  assert.match(r, /Queued/);
  const queued = readFileSync(outbox, "utf8").trim();
  assert.notEqual(queued, f, "the mutable source path never enters the queue");
  assert.match(queued, /pic-[0-9a-f-]{36}\.png$/i, "the snapshot keeps a recognizable attachment stem");
  assert.equal(readFileSync(queued, "utf8"), "x");
  assert.equal(statSync(queued).mode & 0o777, 0o600);
  assert.equal(statSync(outbox).mode & 0o777, 0o600);
  const files = await consumeOutboundSnapshots(outbox);
  assert.equal(files.length, 1);
  assert.equal(files[0].snapshotPath, queued);
  assert.equal(files[0].safeName, "pic.png");
  assert.equal(files[0].bytes.toString(), "x");
  cleanupOutboundSnapshot(queued);
});

test("send_file: nonexistent file → error, nothing queued", async () => {
  const before = existsSync(outbox) ? readFileSync(outbox, "utf8") : "";
  const r = await getTool("send_file").run({ path: join(dir, "nope.png") }, { cwd: dir });
  assert.match(r, /No such file/);
  assert.equal(existsSync(outbox) ? readFileSync(outbox, "utf8") : "", before);
});

test("send_file: resolves a relative path against cwd", async () => {
  writeFileSync(join(dir, "rel.txt"), "y");
  const r = await getTool("send_file").run({ path: "rel.txt" }, { cwd: dir });
  assert.match(r, /Queued/);
  const [snapshot] = await consumeOutboundSnapshots(outbox);
  assert.ok(snapshot);
  assert.equal(snapshot.bytes.toString(), "y");
  cleanupOutboundSnapshot(snapshot.snapshotPath);
});

test("send_file: replacing the source after queueing cannot change what the gateway sends", async () => {
  const source = join(dir, "report.txt");
  const secret = join(dir, ".env");
  writeFileSync(source, "verified report\n");
  writeFileSync(secret, "TOKEN=TOCTOU_SECRET_MUST_NOT_LEAK\n");
  const r = await getTool("send_file").run({ path: source }, { cwd: dir });
  assert.match(r, /Queued/);
  const queued = readFileSync(outbox, "utf8").trim();
  rmSync(source);
  symlinkSync(secret, source);
  // Even an injected raw source path is ignored; only the verified snapshot is returned to the adapter.
  appendFileSync(outbox, source + "\n");
  const files = await consumeOutboundSnapshots(outbox);
  assert.equal(files.length, 1);
  assert.equal(files[0].snapshotPath, queued);
  assert.equal(files[0].bytes.toString(), "verified report\n");
  assert.doesNotMatch(files[0].bytes.toString(), /TOCTOU_SECRET/);
  cleanupOutboundSnapshot(files[0].snapshotPath);
});

test("send_file: replacing a consumed snapshot with a .env symlink cannot change adapter bytes", async () => {
  const source = join(dir, "adapter-report.txt");
  const secret = join(dir, ".env.adapter-test");
  writeFileSync(source, "adapter-safe-bytes\n");
  writeFileSync(secret, "TOKEN=ADAPTER_TOCTOU_SECRET_MUST_NOT_LEAK\n");
  assert.match(await getTool("send_file").run({ path: source }, { cwd: dir }), /Queued/);
  const [payload] = await consumeOutboundSnapshots(outbox);
  assert.ok(payload);

  rmSync(payload.snapshotPath);
  symlinkSync(secret, payload.snapshotPath);
  let uploaded;
  let uploadedName;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const part = init?.body?.get?.("document");
    uploaded = Buffer.from(await part.arrayBuffer());
    uploadedName = part.name;
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  try {
    await telegramAdapter("test-token").sendFile("chat", payload);
  } finally {
    globalThis.fetch = previousFetch;
  }

  assert.equal(uploaded.toString(), "adapter-safe-bytes\n");
  assert.equal(uploadedName, "adapter-report.txt");
  assert.doesNotMatch(uploaded.toString(), /ADAPTER_TOCTOU_SECRET/);
  cleanupOutboundSnapshot(payload.snapshotPath);
  assert.equal(readFileSync(secret, "utf8"), "TOKEN=ADAPTER_TOCTOU_SECRET_MUST_NOT_LEAK\n");
  assert.equal(lstatSync(payload.snapshotPath).isSymbolicLink(), true, "cleanup refuses a replacement identity");
  rmSync(payload.snapshotPath);
});

test("send_file: enforces per-file, batch-byte, and batch-count limits", async () => {
  const oversized = join(dir, "oversized.bin");
  writeFileSync(oversized, "");
  truncateSync(oversized, OUTBOUND_FILE_MAX_BYTES + 1);
  const before = existsSync(outbox) ? readFileSync(outbox, "utf8") : "";
  assert.match(await getTool("send_file").run({ path: oversized }, { cwd: dir }), /exceeds.*gateway send limit/i);
  assert.equal(existsSync(outbox) ? readFileSync(outbox, "utf8") : "", before);

  const halfPlusOne = Math.floor(OUTBOUND_BATCH_MAX_BYTES / 2) + 1;
  for (const [index, name] of ["batch-a.bin", "batch-b.bin"].entries()) {
    const path = join(dir, name);
    writeFileSync(path, Buffer.alloc(halfPlusOne, name === "batch-a.bin" ? 0x61 : 0x62));
    const result = await getTool("send_file").run({ path }, { cwd: dir });
    if (index === 0) assert.match(result, /Queued/);
    else assert.match(result, /batch exceeds.*byte limit/i);
  }
  const boundedBytes = await consumeOutboundSnapshots(outbox);
  assert.equal(boundedBytes.length, 1);
  assert.ok(boundedBytes.reduce((sum, file) => sum + file.bytes.length, 0) <= OUTBOUND_BATCH_MAX_BYTES);
  cleanupOutboundSnapshot(boundedBytes[0].snapshotPath);
  cleanupOutboundSnapshots(outbox);

  for (let i = 0; i < OUTBOUND_BATCH_MAX_FILES + 1; i++) {
    const path = join(dir, `count-${i}.txt`);
    writeFileSync(path, String(i));
    const result = await getTool("send_file").run({ path }, { cwd: dir });
    if (i < OUTBOUND_BATCH_MAX_FILES) assert.match(result, /Queued/);
    else assert.match(result, /batch exceeds.*file limit/i);
  }
  const boundedCount = await consumeOutboundSnapshots(outbox);
  assert.equal(boundedCount.length, OUTBOUND_BATCH_MAX_FILES);
  for (const file of boundedCount) cleanupOutboundSnapshot(file.snapshotPath);
  cleanupOutboundSnapshots(outbox);
});

test("send_file: parallel admissions cannot race past the batch budget", async () => {
  const paths = Array.from({ length: OUTBOUND_BATCH_MAX_FILES + 2 }, (_, i) => {
    const path = join(dir, `parallel-${i}.txt`);
    writeFileSync(path, `parallel-${i}`);
    return path;
  });
  const results = await Promise.all(paths.map((path) => getTool("send_file").run({ path }, { cwd: dir })));
  assert.equal(results.filter((result) => /Queued/.test(result)).length, OUTBOUND_BATCH_MAX_FILES);
  assert.equal(results.filter((result) => /batch exceeds.*file limit/i.test(result)).length, 2);
  const payloads = await consumeOutboundSnapshots(outbox);
  assert.equal(payloads.length, OUTBOUND_BATCH_MAX_FILES);
  for (const payload of payloads) cleanupOutboundSnapshot(payload.snapshotPath);
  cleanupOutboundSnapshots(outbox);
});

test("send_file: a symlink to .env is rejected before any snapshot/outbox entry is created", async () => {
  const secret = join(dir, ".env.send-test");
  const alias = join(dir, "looks-safe.txt");
  writeFileSync(secret, "TOKEN=SEND_SECRET_MUST_NOT_LEAK\n");
  symlinkSync(secret, alias);
  const before = existsSync(outbox) ? readFileSync(outbox, "utf8") : "";
  const result = await getTool("send_file").run({ path: alias }, { cwd: dir });
  assert.match(result, /Blocked|symbolic|regular file/i);
  assert.doesNotMatch(result, /SEND_SECRET_MUST_NOT_LEAK/);
  assert.equal(existsSync(outbox) ? readFileSync(outbox, "utf8") : "", before);
});

test("cleanup", () => {
  cleanupOutboundSnapshots(outbox);
  rmSync(dir, { recursive: true, force: true });
});
