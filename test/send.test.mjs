import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// send_file self-gates on HARA_GATEWAY at import time → set it (and an outbox) before importing the module.
process.env.HARA_GATEWAY = "test";
const dir = mkdtempSync(join(tmpdir(), "hara-send-"));
const outbox = join(dir, "outbox.txt");
process.env.HARA_GATEWAY_OUTBOX = outbox;

const { getTool } = await import("../dist/tools/registry.js");
await import("../dist/tools/send.js"); // registers send_file because HARA_GATEWAY is set

test("send_file: registered only in gateway mode, queues an existing file to the outbox", async () => {
  const tool = getTool("send_file");
  assert.ok(tool, "send_file is registered when HARA_GATEWAY is set");
  const f = join(dir, "pic.png");
  writeFileSync(f, "x");
  const r = await tool.run({ path: f }, { cwd: dir });
  assert.match(r, /Queued/);
  assert.equal(readFileSync(outbox, "utf8").trim(), f); // the daemon drains this and delivers it
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
  assert.ok(readFileSync(outbox, "utf8").includes(join(dir, "rel.txt")));
});

test("cleanup", () => rmSync(dir, { recursive: true, force: true }));
