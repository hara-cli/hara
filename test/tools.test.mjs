import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capHeadTail, isPackageInstallCommand, isNgrokTunnelCommand, ngrokAuthConfigured, pythonStdinCommand, shellTimeoutMs } from "../dist/tools/builtin.js"; // also registers the built-ins (run `npm run build` first)
import { getTool, getTools } from "../dist/tools/registry.js";
import { atomicWriteText } from "../dist/fs-write.js";
import { readRegularFileSnapshot } from "../dist/fs-read.js";
import { commandHasPackageRegistry, normalizePackageRegistry, packageRegistryEnv } from "../dist/package-registry.js";

async function settleWithin(promise, ms = 1500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`operation did not settle within ${ms}ms`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("capHeadTail: keeps head + tail of long output (errors live at the end)", () => {
  const s = "HEAD_START" + "x".repeat(200_000) + "TAIL_ERROR";
  const out = capHeadTail(s);
  assert.ok(out.startsWith("HEAD_START"), "keeps the head");
  assert.ok(out.endsWith("TAIL_ERROR"), "keeps the tail (where errors are)");
  assert.match(out, /chars truncated/);
  assert.ok(out.length < s.length);
  assert.equal(capHeadTail("short output"), "short output"); // under the cap → unchanged
});

test("package installs and ngrok tunnels are classified for safe timeout/preflight handling", () => {
  for (const c of ["npm install", "npm i react", "npm ci", "pnpm add zod", "yarn install", "bun install"]) {
    assert.equal(isPackageInstallCommand(c), true, c);
  }
  for (const c of ["npm test", "pnpm check", "node install.js"]) assert.equal(isPackageInstallCommand(c), false, c);
  assert.equal(isNgrokTunnelCommand("ngrok http 3000"), true);
  assert.equal(isNgrokTunnelCommand("ngrok config check"), false);
  assert.equal(ngrokAuthConfigured({ NGROK_AUTHTOKEN: "present" }, "/no-home"), true);
  assert.equal(ngrokAuthConfigured({}, "/no-home"), false);
  assert.equal(shellTimeoutMs("npm ci"), 900_000, "installs remain attached with a longer safe default");
  assert.equal(shellTimeoutMs("npm test"), 300_000);
  assert.equal(shellTimeoutMs("npm ci", 42_000), 42_000);
  assert.equal(shellTimeoutMs("npm ci", -1), 900_000, "invalid requested timeout falls back safely");
  assert.equal(shellTimeoutMs("npm ci", 9_999_999), 3_600_000, "requested timeouts are bounded");
});

test("package registry switching is explicit, normalized, and injected without shell interpolation", () => {
  assert.equal(normalizePackageRegistry("npmjs"), "https://registry.npmjs.org/");
  assert.equal(normalizePackageRegistry("npmmirror"), "https://registry.npmmirror.com/");
  assert.equal(normalizePackageRegistry("https://packages.example/repository/npm"), "https://packages.example/repository/npm/");
  assert.throws(() => normalizePackageRegistry("https://user:password@packages.example/"), /without credentials/);
  assert.equal(commandHasPackageRegistry("npm install --registry=https://registry.example/"), true);
  assert.equal(commandHasPackageRegistry("npm install"), false);
  assert.deepEqual(packageRegistryEnv("https://registry.npmmirror.com/"), {
    NPM_CONFIG_REGISTRY: "https://registry.npmmirror.com/",
    YARN_NPM_REGISTRY_SERVER: "https://registry.npmmirror.com/",
    BUN_CONFIG_REGISTRY: "https://registry.npmmirror.com/",
  });
});

test("registry contains the built-in tools", () => {
  const names = getTools().map((t) => t.name).sort();
  assert.deepEqual(names, ["bash", "job", "python", "read_file", "write_file"]);
  assert.equal(pythonStdinCommand("darwin"), "python3 -");
  assert.equal(pythonStdinCommand("linux"), "python3 -");
  assert.equal(pythonStdinCommand("win32"), "py -3 -");
});

test("python executes source through stdin without leaving a helper script", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-python-stdin-"));
  const previous = process.env.HARA_ALLOW_SENSITIVE_FILES;
  process.env.HARA_ALLOW_SENSITIVE_FILES = "1";
  try {
    const output = await getTool("python").run({
      code: 'from pathlib import Path\nPath("result.txt").write_text("direct", encoding="utf-8")\nprint("ok")\n',
    }, { cwd: dir, sandbox: "off" });
    assert.match(output, /completed without creating a helper script/i);
    assert.match(output, /ok/);
    assert.equal(readFileSync(join(dir, "result.txt"), "utf8"), "direct");
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".py")), []);
  } finally {
    if (previous === undefined) delete process.env.HARA_ALLOW_SENSITIVE_FILES;
    else process.env.HARA_ALLOW_SENSITIVE_FILES = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("python stdin source cannot bypass protected-file preflight", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-python-protected-"));
  const previous = process.env.HARA_ALLOW_SENSITIVE_FILES;
  delete process.env.HARA_ALLOW_SENSITIVE_FILES;
  try {
    const output = await getTool("python").run({
      code: 'from pathlib import Path\nprint(Path(".env").read_text())\n',
    }, { cwd: dir, sandbox: "off" });
    assert.match(output, /Blocked: Python source crosses Hara's protected secret boundary/i);
    assert.equal(existsSync(join(dir, ".env")), false);
  } finally {
    if (previous !== undefined) process.env.HARA_ALLOW_SENSITIVE_FILES = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("write_file → read_file round-trips in cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-test-"));
  try {
    const ctx = { cwd: dir };
    const w = await getTool("write_file").run({ path: "a.txt", content: "hello hara" }, ctx);
    assert.match(w, /Wrote 10 chars/);
    const r = await getTool("read_file").run({ path: "a.txt" }, ctx);
    assert.equal(r, "     1\thello hara"); // cat -n numbered since the long-file slicing change
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("write_file creates nested parent directories", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-test-"));
  try {
    const ctx = { cwd: dir };
    await getTool("write_file").run({ path: "deep/nested/b.txt", content: "x" }, ctx);
    const r = await getTool("read_file").run({ path: "deep/nested/b.txt" }, ctx);
    assert.equal(r, "     1\tx"); // cat -n numbered
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read_file streams a file larger than the in-memory threshold", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-test-"));
  try {
    const path = join(dir, "large.log");
    writeFileSync(path, (`${"x".repeat(1000)}\n`).repeat(5000)); // ~5 MB
    const out = await getTool("read_file").run({ path: "large.log", limit: 2 }, { cwd: dir });
    assert.match(out, /^\(lines 1–2; more lines follow — continue with offset:3\)/);
    assert.ok(out.includes("     2\t"), "requested line window is present");
    assert.ok(!out.includes("     3\t"), "the reader stops after proving more content exists");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read_file rejects binary content instead of injecting it into model context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-test-"));
  try {
    writeFileSync(join(dir, "blob.bin"), Buffer.from([1, 2, 0, 3]));
    const out = await getTool("read_file").run({ path: "blob.bin" }, { cwd: dir });
    assert.match(out, /appears binary/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read_file and write_file reject FIFOs without blocking", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-fifo-"));
  try {
    const fifo = join(dir, "generator.pipe");
    execFileSync("mkfifo", [fifo]);
    const read = await settleWithin(getTool("read_file").run({ path: fifo }, { cwd: dir }));
    assert.match(read, /not a regular file/i);
    const write = await settleWithin(getTool("write_file").run({ path: fifo, content: "must not replace" }, { cwd: dir }));
    assert.match(write, /not a regular file/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomic writes never overwrite an entry created while the claimed old fd is being verified", { timeout: 15000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-write-claim-cas-"));
  const target = join(dir, "target.txt");
  const external = join(dir, "external.txt");
  const old = "O".repeat(60 * 1024 * 1024);
  writeFileSync(target, old);
  writeFileSync(external, "EXTERNAL-DATA");
  let scheduled = false;
  let inserted = false;
  const watcher = setInterval(() => {
    if (scheduled) return;
    if (!readdirSync(dir).some((name) => name.startsWith(".hara-claim-") && name.endsWith(".tmp"))) return;
    scheduled = true;
    setTimeout(() => {
      try {
        renameSync(external, target);
        inserted = true;
      } catch {
        // Asserted below: the fixture must land during the deliberately long claim read.
      }
    }, 10);
  }, 0);
  try {
    await assert.rejects(atomicWriteText(target, "NEW", { expected: old }), /changed|another entry|retained/i);
    assert.equal(inserted, true);
    assert.equal(readFileSync(target, "utf8"), "EXTERNAL-DATA", "create-if-absent commit preserves the external file");
    const retained = readdirSync(dir).find((name) => name.startsWith(".hara-claim-") && name.endsWith(".tmp"));
    assert.ok(retained, "the move-claimed old file is retained when its visible path is occupied");
    assert.equal(readFileSync(join(dir, retained), "utf8").length, old.length);
  } finally {
    clearInterval(watcher);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomic writes reject and restore a same-content symlink replacement", { timeout: 15000, skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-write-link-cas-"));
  const target = join(dir, "target.txt");
  const alternate = join(dir, "alternate.txt");
  const saved = join(dir, "saved.txt");
  writeFileSync(target, "old");
  writeFileSync(alternate, "old");
  let swapped = false;
  const watcher = setInterval(() => {
    if (swapped) return;
    const staging = readdirSync(dir).find((name) => name.startsWith(".hara-") && !name.startsWith(".hara-claim-") && name.endsWith(".tmp"));
    if (!staging) return;
    try {
      renameSync(target, saved);
      symlinkSync("alternate.txt", target);
      swapped = true;
    } catch {
      // Poll across the short staging-open window.
    }
  }, 0);
  try {
    await assert.rejects(atomicWriteText(target, "N".repeat(60 * 1024 * 1024), { expected: "old" }), /symbolic link|changed|safe restore/i);
    assert.equal(swapped, true);
    assert.equal(lstatSync(target).isSymbolicLink(), true, "the concurrent symlink topology is restored");
    assert.equal(readFileSync(target, "utf8"), "old");
    assert.equal(readFileSync(alternate, "utf8"), "old");
    assert.equal(existsSync(saved), true);
  } finally {
    clearInterval(watcher);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomic expected-identity updates preserve the exact preflight mode", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-write-mode-"));
  try {
    const target = join(dir, "run.sh");
    writeFileSync(target, "old\n");
    chmodSync(target, 0o775);
    const snapshot = await readRegularFileSnapshot(target);
    await atomicWriteText(target, "new\n", { expected: snapshot.text, expectedIdentity: snapshot });
    assert.equal(statSync(target).mode & 0o777, 0o775, "group-write/executable bits are not filtered through umask or a path-level re-stat");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bash runs in cwd and returns combined output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-test-"));
  const previous = process.env.HARA_ALLOW_SENSITIVE_FILES;
  process.env.HARA_ALLOW_SENSITIVE_FILES = "1"; // safe echo fixture; avoids nested sandbox-exec in CI
  try {
    const o = await getTool("bash").run({ command: "echo hi" }, { cwd: dir });
    assert.match(o, /hi/);
  } finally {
    if (previous === undefined) delete process.env.HARA_ALLOW_SENSITIVE_FILES;
    else process.env.HARA_ALLOW_SENSITIVE_FILES = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bash reports failures without throwing", async () => {
  const previous = process.env.HARA_ALLOW_SENSITIVE_FILES;
  process.env.HARA_ALLOW_SENSITIVE_FILES = "1";
  try {
    const o = await getTool("bash").run({ command: "exit 7" }, { cwd: process.cwd() });
    assert.match(o, /failed/i);
  } finally {
    if (previous === undefined) delete process.env.HARA_ALLOW_SENSITIVE_FILES;
    else process.env.HARA_ALLOW_SENSITIVE_FILES = previous;
  }
});

test("background bash receipt and job tool views never replay command/output credentials", async () => {
  const previous = process.env.HARA_ALLOW_SENSITIVE_FILES;
  process.env.HARA_ALLOW_SENSITIVE_FILES = "1";
  const token = "sk-hara-background-12345678901234567890";
  try {
    const receipt = await getTool("bash").run(
      { command: `printf '%s\\n' '${token}'`, background: true },
      { cwd: process.cwd(), sandbox: "off" },
    );
    assert.ok(!receipt.includes(token));
    assert.match(receipt, /sk-\*\*\*/);
    const id = receipt.match(/background job (j\d+)/)?.[1];
    assert.ok(id);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const list = await getTool("job").run({ action: "list" }, { cwd: process.cwd() });
    const tail = await getTool("job").run({ action: "tail", id }, { cwd: process.cwd() });
    for (const value of [list, tail]) {
      assert.ok(!value.includes(token));
      assert.match(value, /sk-\*\*\*/);
    }
  } finally {
    if (previous === undefined) delete process.env.HARA_ALLOW_SENSITIVE_FILES;
    else process.env.HARA_ALLOW_SENSITIVE_FILES = previous;
  }
});

test("live bash UI redacts stdout and stderr independently when chunks interleave", async () => {
  const previousAllow = process.env.HARA_ALLOW_SENSITIVE_FILES;
  const previousToken = process.env.HARA_LIVE_STREAM_TOKEN;
  process.env.HARA_ALLOW_SENSITIVE_FILES = "1";
  const token = "opaque-live-stream-token-1234567890";
  process.env.HARA_LIVE_STREAM_TOKEN = token;
  const split = Math.floor(token.length / 2);
  const first = token.slice(0, split);
  const second = token.slice(split);
  const notices = [];
  try {
    const script =
      `process.stdout.write(${JSON.stringify(first)});` +
      `setTimeout(()=>process.stderr.write('ordinary-stderr\\n'),20);` +
      `setTimeout(()=>process.stdout.write(${JSON.stringify(second + "\\n")}),40);`;
    const result = await getTool("bash").run(
      { command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}` },
      { cwd: process.cwd(), sandbox: "off", ui: { text() {}, reasoning() {}, tool() {}, diff() {}, notice(line) { notices.push(line); } } },
    );
    const live = notices.join("\n");
    assert.ok(!live.includes(first));
    assert.ok(!live.includes(second));
    assert.ok(!live.includes(token));
    assert.match(live, /\*\*\*/);
    assert.match(live, /ordinary-stderr/);
    assert.ok(!result.includes(token));
  } finally {
    if (previousAllow === undefined) delete process.env.HARA_ALLOW_SENSITIVE_FILES;
    else process.env.HARA_ALLOW_SENSITIVE_FILES = previousAllow;
    if (previousToken === undefined) delete process.env.HARA_LIVE_STREAM_TOKEN;
    else process.env.HARA_LIVE_STREAM_TOKEN = previousToken;
  }
});
