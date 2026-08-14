import test from "node:test";
import assert from "node:assert/strict";
import {
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../dist/tools/inspect-image.js";
import "../dist/tools/builtin.js";
import { getTool } from "../dist/tools/registry.js";
import { MAX_NATIVE_IMAGE_BYTES } from "../dist/vision.js";

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

test("inspect_image snapshots a workspace image and sends it only through the current authorized route", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hara-inspect-image-"));
  try {
    const source = join(cwd, "downloaded.bin");
    writeFileSync(source, png);
    let inspectedPath = "";
    const tool = getTool("inspect_image");
    assert.ok(tool);
    assert.equal(tool.kind, "read");
    const result = await tool.run({ path: "downloaded.bin", focus: "transcribe the form" }, {
      cwd,
      inspectImage: async (image, hint) => {
        inspectedPath = image.path;
        assert.notEqual(image.path, source, "the provider receives a private immutable snapshot, not the live file");
        assert.equal(image.mediaType, "image/png", "magic bytes, not the extension, determine the media type");
        assert.deepEqual(readFileSync(image.path), png);
        assert.equal(hint, "transcribe the form");
        return { text: "visible account form", model: "qwen3.7-plus" };
      },
    });
    assert.match(result, /Image inspected with qwen3\.7-plus/);
    assert.match(result, /visible account form/);
    assert.throws(() => readFileSync(inspectedPath), /ENOENT/, "the private snapshot is removed after the provider settles");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("inspect_image rejects files outside the workspace before any bytes reach a provider", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hara-inspect-workspace-"));
  const outside = mkdtempSync(join(tmpdir(), "hara-inspect-outside-"));
  try {
    const path = join(outside, "outside.png");
    writeFileSync(path, png);
    let called = false;
    const result = await getTool("inspect_image").run({ path }, {
      cwd,
      inspectImage: async () => {
        called = true;
        return { text: "must not run", model: "fake-vl" };
      },
    });
    assert.match(result, /inside the current workspace/);
    assert.equal(called, false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("inspect_image preserves protected-file, symlink, hard-link, format, and size boundaries", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hara-inspect-boundary-"));
  const ctx = {
    cwd,
    inspectImage: async () => ({ text: "must not run", model: "fake-vl" }),
  };
  try {
    const tool = getTool("inspect_image");
    writeFileSync(join(cwd, ".env"), png);
    assert.match(await tool.run({ path: ".env" }, ctx), /environment file|protected/i);

    writeFileSync(join(cwd, "real.png"), png);
    symlinkSync(join(cwd, "real.png"), join(cwd, "alias.png"));
    assert.match(await tool.run({ path: "alias.png" }, ctx), /not a regular file|symbolic/i);

    linkSync(join(cwd, "real.png"), join(cwd, "hard.png"));
    assert.match(await tool.run({ path: "hard.png" }, ctx), /hard-linked/i);

    writeFileSync(join(cwd, "fake.png"), Buffer.from("not an image"));
    assert.match(await tool.run({ path: "fake.png" }, ctx), /valid PNG, JPEG, GIF, and WebP/);

    writeFileSync(join(cwd, "huge.png"), Buffer.concat([
      png.subarray(0, 8),
      Buffer.alloc(MAX_NATIVE_IMAGE_BYTES - 7),
    ]));
    assert.match(await tool.run({ path: "huge.png" }, ctx), /safe image limit/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("read_file points binary image work at inspect_image instead of credentials or ad-hoc OCR", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hara-read-binary-"));
  try {
    writeFileSync(join(cwd, "downloaded.png"), png);
    const result = await getTool("read_file").run({ path: "downloaded.png" }, { cwd });
    assert.match(result, /call inspect_image/);
    assert.match(result, /Do not read credentials or add a second API key/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
