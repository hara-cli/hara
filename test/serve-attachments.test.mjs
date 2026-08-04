import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_IMAGE_BYTES,
  validateSessionAttachments,
} from "../dist/serve/attachments.js";
import {
  expandExplicitAttachmentsAsync,
  MAX_EXPLICIT_ATTACHMENT_CONTEXT_CHARS,
} from "../dist/context/mentions.js";

const png = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x00,
]);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hara-serve-attachments-"));
  return {
    root,
    done: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("serve attachment boundary keeps spaces lossless and derives image MIME from bytes", async () => {
  const fx = fixture();
  try {
    const image = join(fx.root, "screen shot.jpg");
    const text = join(fx.root, "产品 说明.md");
    const directory = join(fx.root, "参考 目录");
    writeFileSync(image, png);
    writeFileSync(text, "# 真实内容\n");
    mkdirSync(directory);
    writeFileSync(join(directory, "one.ts"), "export const one = 1;\n");

    const result = validateSessionAttachments(fx.root, [
      { kind: "image", path: image, mediaType: "image/jpeg" },
      { kind: "file", path: text },
      { kind: "directory", path: directory },
      { kind: "file", path: text },
    ]);
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].mediaType, "image/png", "client MIME is not trusted");
    assert.deepEqual(result.contexts, [
      { kind: "file", path: text },
      { kind: "directory", path: directory },
    ]);
    assert.deepEqual(
      result.views.map(({ kind, name }) => ({ kind, name })),
      [
        { kind: "image", name: "screen shot.jpg" },
        { kind: "file", name: "产品 说明.md" },
        { kind: "directory", name: "参考 目录" },
      ],
    );

    const expanded = await expandExplicitAttachmentsAsync(result.contexts, fx.root);
    assert.match(expanded, /真实内容/);
    assert.match(expanded, /one\.ts/);
  } finally {
    fx.done();
  }
});

test("serve attachment boundary rejects fake images, sensitive files, symlinks, and oversized images", () => {
  const fx = fixture();
  try {
    const fake = join(fx.root, "fake.png");
    const secret = join(fx.root, ".env");
    const target = join(fx.root, "target.txt");
    const alias = join(fx.root, "alias.txt");
    const huge = join(fx.root, "huge.png");
    writeFileSync(fake, "not an image");
    writeFileSync(secret, "TOKEN=redacted");
    writeFileSync(target, "ok");
    symlinkSync(target, alias);
    writeFileSync(huge, png);
    truncateSync(huge, 42_000_000);

    assert.throws(
      () => validateSessionAttachments(fx.root, [{ kind: "image", path: fake }]),
      /unsupported or invalid format/,
    );
    assert.throws(
      () => validateSessionAttachments(fx.root, [{ kind: "file", path: secret }]),
      /Blocked: refusing to attach protected/,
    );
    assert.throws(
      () => validateSessionAttachments(fx.root, [{ kind: "file", path: alias }]),
      /symbolic link/,
    );
    assert.throws(
      () => validateSessionAttachments(fx.root, [{ kind: "image", path: huge }]),
      /42\.0 MB.*3\.6 MB.*not sent to the model.*OCR fallback.*compress or crop/i,
    );
  } finally {
    fx.done();
  }
});

test("explicit binary attachments remain a tool reference and never pretend to be read", async () => {
  const fx = fixture();
  try {
    const binary = join(fx.root, "design file.pdf");
    writeFileSync(binary, Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const expanded = await expandExplicitAttachmentsAsync(
      [{ kind: "file", path: binary }],
      fx.root,
    );
    assert.match(expanded, /available locally/);
    assert.match(expanded, /do not claim to have read it until that tool succeeds/);
  } finally {
    fx.done();
  }
});

test("explicit attachment expansion has one aggregate context budget across files", async () => {
  const fx = fixture();
  try {
    const attachments = [];
    for (let index = 0; index < 5; index++) {
      const path = join(fx.root, `large-${index}.txt`);
      writeFileSync(path, `FILE_${index}_START\n${String(index).repeat(49_980)}`);
      attachments.push({ kind: "file", path });
    }
    const expanded = await expandExplicitAttachmentsAsync(attachments, fx.root);
    assert.match(expanded, /aggregate limit/);
    assert.doesNotMatch(expanded, /FILE_4_START/);
    assert.ok(
      expanded.length <= MAX_EXPLICIT_ATTACHMENT_CONTEXT_CHARS + 300,
      "the truncation marker stays a small bounded overhead",
    );
  } finally {
    fx.done();
  }
});
