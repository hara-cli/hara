import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import {
  MediaSizeLimitError,
  INBOUND_MEDIA_MAX_BYTES,
  INBOUND_MEDIA_MAX_FILES,
  INBOUND_MEDIA_MAX_RETAINED_BYTES_PER_PLATFORM,
  InboundMediaBudget,
  cleanupTransientMedia,
  decodeBase64Media,
  ensurePrivateMediaDir,
  inboundMediaQuotaUsage,
  pruneStaleMedia,
  safeMediaExtension,
  savePrivateMedia,
  savePrivateResponse,
} from "../dist/gateway/media.js";

const privateBits = (mode) => mode & 0o777;
const execFileAsync = promisify(execFile);

test("private media streams to a random atomic 0600 file in a 0700 directory", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "hara-media-"));
  const mediaDir = join(baseDir, "telegram", "media");
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2]));
        controller.enqueue(Uint8Array.from([3, 4]));
        controller.close();
      },
    }),
    { headers: { "content-type": "image/png", "content-length": "4" } },
  );

  const path = await savePrivateResponse(response, {
    platform: "telegram",
    // Directory traversal and an attacker-controlled stem must never survive; only the safe extension may.
    filenameHint: "../../../../private-photo.PNG",
    baseDir,
    maxBytes: 16,
  });

  assert.match(basename(path), /^[0-9a-f-]{36}\.png$/);
  assert.deepEqual([...await readFile(path)], [1, 2, 3, 4]);
  assert.equal(privateBits((await stat(mediaDir)).mode), 0o700);
  assert.equal(privateBits((await stat(path)).mode), 0o600);
  assert.deepEqual(await readdir(mediaDir), [basename(path)], "no temporary file remains after atomic rename");

  // A pre-existing permissive media directory is tightened before the next write.
  await chmod(mediaDir, 0o777);
  await savePrivateMedia(Readable.from([Buffer.from("x")]), {
    platform: "telegram",
    filenameHint: "x.txt",
    baseDir,
  });
  assert.equal(privateBits((await stat(mediaDir)).mode), 0o700);
});

test("streaming cap cancels the source and deletes the partial file", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "hara-media-cap-"));
  let canceled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(5));
      controller.enqueue(new Uint8Array(5));
    },
    cancel() {
      canceled = true;
    },
  });

  await assert.rejects(
    savePrivateMedia(stream, { platform: "discord", filenameHint: "x.jpg", baseDir, maxBytes: 8 }),
    (error) => error instanceof MediaSizeLimitError && error.limit === 8,
  );
  assert.equal(canceled, true);
  assert.deepEqual(await readdir(join(baseDir, "discord", "media")), []);
});

test("a throwing stream cancel cannot strand a partial media file", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "hara-media-cancel-"));
  let step = 0;
  const source = {
    destroy() { throw new Error("broken destroy"); },
    [Symbol.asyncIterator]() {
      return {
        async next() { return step++ < 2 ? { done: false, value: Buffer.alloc(5) } : { done: true }; },
        async return() { return { done: true }; },
      };
    },
  };
  await assert.rejects(
    savePrivateMedia(source, { platform: "matrix", baseDir, maxBytes: 8 }),
    MediaSizeLimitError,
  );
  assert.deepEqual(await readdir(join(baseDir, "matrix", "media")), []);
});

test("declared oversized responses are canceled before any directory or file is created", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "hara-media-length-"));
  let canceled = false;
  const response = new Response(
    new ReadableStream({ cancel() { canceled = true; } }),
    { headers: { "content-length": "999" } },
  );

  await assert.rejects(
    savePrivateResponse(response, { platform: "slack", baseDir, maxBytes: 8 }),
    MediaSizeLimitError,
  );
  assert.equal(canceled, true);
  await assert.rejects(stat(join(baseDir, "slack")), { code: "ENOENT" });
});

test("base64 protocols reject oversized or malformed media before decoding", () => {
  assert.deepEqual([...decodeBase64Media("AQID", 3)], [1, 2, 3]);
  assert.throws(() => decodeBase64Media("AQIDBA==", 3), MediaSizeLimitError);
  assert.throws(() => decodeBase64Media("not base64!", 32), /invalid base64 media/);
});

test("extension handling discards unsafe names and uses known content types", () => {
  assert.equal(safeMediaExtension("../../thing.JPEG"), ".jpeg");
  assert.equal(safeMediaExtension(".ssh/authorized_keys", "image/webp"), ".webp");
  assert.equal(safeMediaExtension("x.reallylongextension", "application/pdf"), ".pdf");
  assert.equal(safeMediaExtension("x.$$$", "application/octet-stream"), ".bin");
});

test("gateway cleanup removes only adapter-owned transient files in the matching platform", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "hara-media-cleanup-"));
  const saved = await savePrivateMedia(Readable.from([Buffer.from("secret")]), {
    platform: "telegram",
    filenameHint: "photo.jpg",
    baseDir,
  });
  const outside = join(baseDir, `${randomUUID()}.txt`);
  await writeFile(outside, "keep");
  const mediaDir = join(baseDir, "telegram", "media");
  const link = join(mediaDir, `${randomUUID()}.txt`);
  await symlink(outside, link);
  const legacy = join(mediaDir, "legacy-photo.jpg");
  await writeFile(legacy, "keep");

  assert.equal(await cleanupTransientMedia("telegram", [saved, saved, outside, link, legacy], baseDir), 1);
  await assert.rejects(stat(saved), { code: "ENOENT" });
  assert.equal(await readFile(outside, "utf8"), "keep", "an arbitrary adapter path is never deleted");
  assert.equal(await readFile(link, "utf8"), "keep", "a media-directory symlink is never followed or removed");
  assert.equal(await readFile(legacy, "utf8"), "keep", "legacy/non-owned names are not treated as transient");
});

test("media roots reject ancestor symlinks for both writes and cleanup", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "hara-media-parent-link-"));
  const outside = await mkdtemp(join(tmpdir(), "hara-media-outside-"));
  await mkdir(join(outside, "media"));
  await symlink(outside, join(baseDir, "telegram"));
  const outsideFile = join(outside, "media", `${randomUUID()}.bin`);
  await writeFile(outsideFile, "keep");
  const lexicalCandidate = join(baseDir, "telegram", "media", basename(outsideFile));

  await assert.rejects(
    savePrivateMedia(Readable.from([Buffer.from("secret")]), { platform: "telegram", baseDir }),
    /unsafe platform media directory/,
  );
  assert.equal(await cleanupTransientMedia("telegram", [lexicalCandidate], baseDir), 0);
  assert.equal(await readFile(outsideFile, "utf8"), "keep");
});

test("per-message media budget enforces four attempts and a 20 MiB aggregate", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "hara-media-budget-"));
  const mediaDir = await ensurePrivateMediaDir("telegram", baseDir);
  const budget = new InboundMediaBudget("telegram", undefined, baseDir);
  let calls = 0;
  const makeSparse = async (size) => {
    calls++;
    const path = join(mediaDir, `${randomUUID()}.bin`);
    await writeFile(path, "");
    await truncate(path, size);
    return path;
  };

  const almostFull = await budget.download(() => makeSparse(INBOUND_MEDIA_MAX_BYTES - 1));
  assert.ok(almostFull);
  const overflow = await budget.download(() => makeSparse(2));
  assert.equal(overflow, null, "a downloader that exceeds the remaining aggregate is rejected and cleaned");
  assert.equal(budget.remainingBytes, 1);
  for (let i = 2; i < INBOUND_MEDIA_MAX_FILES; i++) await budget.download(() => Promise.resolve(null));
  assert.equal(await budget.download(() => { calls++; return Promise.resolve(null); }), null);
  assert.equal(calls, 2, "the fifth attachment does not invoke its downloader");
  assert.deepEqual(await readdir(mediaDir), [basename(almostFull)]);
  await cleanupTransientMedia("telegram", [almostFull], baseDir);
});

test("global media admission keeps only two same-platform downloads truly in flight", async () => {
  const releases = [];
  let entered = 0;
  const hold = () => new Promise((resolve) => {
    entered++;
    releases.push(resolve);
  });
  const first = new InboundMediaBudget("matrix").download(hold);
  const second = new InboundMediaBudget("matrix").download(hold);
  await new Promise((resolve) => setImmediate(resolve));
  const rejected = await new InboundMediaBudget("matrix").download(() => {
    entered++;
    return Promise.resolve(null);
  });
  assert.equal(rejected, null);
  assert.equal(entered, 2);
  for (const release of releases) release(null);
  await Promise.all([first, second]);
});

test("successful downloads retain quota until gateway cleanup releases their paths", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "hara-media-retained-"));
  const mediaDir = await ensurePrivateMediaDir("discord", baseDir);
  const before = inboundMediaQuotaUsage();
  const makeSparse = async (size) => {
    const path = join(mediaDir, `${randomUUID()}.bin`);
    await writeFile(path, "");
    await truncate(path, size);
    return path;
  };
  const first = await new InboundMediaBudget("discord", undefined, baseDir).download(() => makeSparse(INBOUND_MEDIA_MAX_BYTES));
  const second = await new InboundMediaBudget("discord", undefined, baseDir).download(() => makeSparse(INBOUND_MEDIA_MAX_BYTES));
  assert.ok(first && second);
  assert.equal(INBOUND_MEDIA_MAX_RETAINED_BYTES_PER_PLATFORM, 2 * INBOUND_MEDIA_MAX_BYTES);
  assert.deepEqual(inboundMediaQuotaUsage(), {
    ...before,
    retainedBytes: before.retainedBytes + 2 * INBOUND_MEDIA_MAX_BYTES,
    retainedFiles: before.retainedFiles + 2,
  });

  let attempted = false;
  assert.equal(await new InboundMediaBudget("discord", undefined, baseDir).download(() => {
    attempted = true;
    return makeSparse(1);
  }), null);
  assert.equal(attempted, false, "retained files, not just active fetches, keep the platform quota occupied");

  await cleanupTransientMedia("discord", [first], baseDir);
  const afterCleanup = await new InboundMediaBudget("discord", undefined, baseDir).download(() => makeSparse(1));
  assert.ok(afterCleanup, "cleanup releases retained capacity for the next message");
  await cleanupTransientMedia("discord", [second, afterCleanup], baseDir);
  assert.deepEqual(inboundMediaQuotaUsage(), before);
});

test("abort cancels a stalled stream and removes its partial file", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "hara-media-abort-"));
  const controller = new AbortController();
  const stream = new ReadableStream({
    start(sink) {
      sink.enqueue(Uint8Array.from([1, 2, 3]));
      // Deliberately never close: the next read remains pending until the signal cancels it.
    },
  });
  const budget = new InboundMediaBudget("slack", controller.signal, baseDir);
  const pending = budget.download((options) => savePrivateMedia(stream, {
    platform: "slack",
    filenameHint: "stalled.bin",
    baseDir,
    ...options,
  }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort(new Error("shutdown"));
  assert.equal(await pending, null);
  assert.deepEqual(await readdir(join(baseDir, "slack", "media")), []);
});

test("startup janitor prunes stale owned files but preserves recent, foreign, and symlink entries", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "hara-media-prune-"));
  const old = await savePrivateMedia(Readable.from([Buffer.from("old")]), { platform: "discord", baseDir });
  const recent = await savePrivateMedia(Readable.from([Buffer.from("new")]), { platform: "discord", baseDir });
  const mediaDir = join(baseDir, "discord", "media");
  const part = join(mediaDir, `.${randomUUID()}.part`);
  const foreign = join(mediaDir, "manual.txt");
  const outside = join(baseDir, "outside.txt");
  const link = join(mediaDir, `${randomUUID()}.txt`);
  await writeFile(part, "partial");
  await writeFile(foreign, "keep");
  await writeFile(outside, "keep");
  await symlink(outside, link);
  const now = Date.now();
  const oldTime = new Date(now - 10_000);
  await utimes(old, oldTime, oldTime);
  await utimes(part, oldTime, oldTime);

  assert.equal(await pruneStaleMedia("discord", { baseDir, maxAgeMs: 5_000, now }), 2);
  await assert.rejects(stat(old), { code: "ENOENT" });
  await assert.rejects(stat(part), { code: "ENOENT" });
  assert.equal(await readFile(recent, "utf8"), "new");
  assert.equal(await readFile(foreign, "utf8"), "keep");
  assert.equal(await readFile(link, "utf8"), "keep");
});

test("startup janitor migrates known stale legacy adapter filenames", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "hara-media-legacy-"));
  const recent = await savePrivateMedia(Readable.from([Buffer.from("new")]), { platform: "telegram", baseDir });
  const mediaDir = join(baseDir, "telegram", "media");
  const legacy = join(mediaDir, `tg_${Date.now()}_photo.jpg`);
  const unrelated = join(mediaDir, "legacy-photo.jpg");
  await writeFile(legacy, "old-secret");
  await writeFile(unrelated, "keep");
  const now = Date.now();
  const oldTime = new Date(now - 10_000);
  await utimes(legacy, oldTime, oldTime);

  assert.equal(await pruneStaleMedia("telegram", { baseDir, maxAgeMs: 5_000, now }), 1);
  await assert.rejects(stat(legacy), { code: "ENOENT" });
  assert.equal(await readFile(recent, "utf8"), "new");
  assert.equal(await readFile(unrelated, "utf8"), "keep");
});

test("inbound-media adapters route downloads through the bounded private helper", async () => {
  const expectations = {
    telegram: "savePrivateResponse",
    discord: "savePrivateResponse",
    feishu: "savePrivateResponse",
    slack: "savePrivateResponse",
    mattermost: "savePrivateResponse",
    matrix: "savePrivateResponse",
    signal: "decodeBase64Media",
    wecom: "readResponseBytesLimited",
    weixin: "readResponseBytesLimited",
  };
  for (const [adapter, helper] of Object.entries(expectations)) {
    const source = await readFile(new URL(`../src/gateway/${adapter}.ts`, import.meta.url), "utf8");
    assert.match(source, new RegExp(`\\b${helper}\\b`), `${adapter} must use ${helper}`);
    assert.match(source, /transientFiles/, `${adapter} must hand downloaded files to the gateway lifecycle`);
    assert.match(source, /shouldDownload/, `${adapter} must authorize metadata before downloading attachment bytes`);
    assert.match(source, /InboundMediaBudget/, `${adapter} must share per-message and retained-media quotas`);
    assert.doesNotMatch(
      source,
      /Buffer\.from\(await\s+(?:r|res|response|dl)\.arrayBuffer\(\)\)/,
      `${adapter} must not materialize an unbounded HTTP response`,
    );
    assert.doesNotMatch(
      source,
      /(?:const|let)\s+\w+\s*=\s*await\s+(?:r|res|response|dl)\.arrayBuffer\(\)/,
      `${adapter} must not assign a whole unbounded HTTP response`,
    );
  }
});

test("Weixin inbound media uses bounded streaming and private atomic storage", async () => {
  const home = await mkdtemp(join(tmpdir(), "hara-weixin-media-"));
  const moduleUrl = new URL("../dist/gateway/weixin.js", import.meta.url).href;
  const script = `
    let call = 0;
    let canceled = false;
    globalThis.fetch = async () => {
      call++;
      if (call === 1) {
        return new Response(new ReadableStream({ start(c) { c.enqueue(Uint8Array.from([1, 2])); c.enqueue(Uint8Array.from([3, 4])); c.close(); } }), { headers: { "content-length": "4" } });
      }
      return new Response(new ReadableStream({ cancel() { canceled = true; } }), { headers: { "content-length": String(128 * 1024 * 1024 + 1) } });
    };
    const { downloadInboundMedia } = await import(${JSON.stringify(moduleUrl)});
    const saved = await downloadInboundMedia({ kind: "image", fullUrl: "https://novac2c.cdn.weixin.qq.com/image" });
    const oversized = await downloadInboundMedia({ kind: "image", fullUrl: "https://novac2c.cdn.weixin.qq.com/too-large" });
    process.stdout.write(JSON.stringify({ saved, oversized, canceled }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, HOME: home },
  });
  const result = JSON.parse(stdout);
  assert.equal(result.oversized, null);
  assert.equal(result.canceled, true, "declared overflow cancels the Weixin response body");
  assert.equal(result.saved.mime, "image/jpeg");
  assert.match(basename(result.saved.path), /^[0-9a-f-]{36}\.jpg$/);
  assert.deepEqual([...await readFile(result.saved.path)], [1, 2, 3, 4]);
  const mediaDir = join(home, ".hara", "weixin", "media");
  assert.equal(privateBits((await stat(mediaDir)).mode), 0o700);
  assert.equal(privateBits((await stat(result.saved.path)).mode), 0o600);
  assert.deepEqual(await readdir(mediaDir), [basename(result.saved.path)], "overflow leaves no partial Weixin file");
});
