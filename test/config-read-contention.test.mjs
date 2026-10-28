import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRawConfig, writeConfigValue } from "../dist/config.js";

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-config-read-contention-")));
  const home = join(root, "home"), state = join(home, ".hara");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const previous = process.env.HOME; process.env.HOME = home;
  t.after(() => {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { home, state, config: join(state, "config.json") };
}

function countSyncs(fn) {
  const original = fs.fsyncSync; let count = 0;
  fs.fsyncSync = (...args) => { count++; return original(...args); };
  syncBuiltinESMExports();
  try { fn(); return count; } finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
}

test("missing config reads do not publish durable locks, cache absence or create config", t => {
  const f = fixture(t);
  const count = countSyncs(() => {
    for (let i = 0; i < 30; i++) assert.deepEqual(readRawConfig(), {});
  });
  assert.equal(count, 0, "an uncontended absence is a read, not three fsyncs per lookup");
  assert.equal(fs.existsSync(f.config), false);
  assert.deepEqual(fs.readdirSync(f.state), []);
  writeConfigValue("model", "synthetic-rotated-model");
  assert.equal(readRawConfig().model, "synthetic-rotated-model", "absence is never cached across a later write");
});

test("a missing config under an unsafe writer marker cannot be treated as empty", t => {
  const f = fixture(t), outside = join(f.home, "outside");
  fs.writeFileSync(outside, "do not touch\n");
  fs.symlinkSync(outside, join(f.state, "config.lock"));
  assert.throws(() => readRawConfig(), /lock|symbolic|unsafe|real file/i);
  assert.equal(fs.readFileSync(outside, "utf8"), "do not touch\n");
});

test("a changed namespace during an absent read falls back to the writer fence", t => {
  const f = fixture(t), original = fs.lstatSync; let changed = false;
  fs.lstatSync = function (path, ...options) {
    if (String(path) === f.config && !changed) {
      changed = true;
      const marker = join(f.state, "synthetic-namespace-change");
      fs.writeFileSync(marker, "created and removed during lookup\n");
      fs.unlinkSync(marker);
    }
    return original(path, ...options);
  };
  syncBuiltinESMExports();
  let count;
  try { count = countSyncs(() => assert.deepEqual(readRawConfig(), {})); }
  finally { fs.lstatSync = original; syncBuiltinESMExports(); }
  assert.equal(changed, true);
  // Lock-file fsync is mandatory; directory fsync is best-effort and may be 0 on some Linux CI FS.
  assert.ok(count >= 1, "uncertain namespace absence must acquire/release the original durable writer lock");
  assert.deepEqual(fs.readdirSync(f.state), []);
});

test("a reader in the writer's claimed-inode gap waits for the original config authority", { timeout: 20_000 }, async t => {
  const f = fixture(t);
  fs.writeFileSync(f.config, JSON.stringify({ sentinel: "synthetic-old", provider: "openai" }), { mode: 0o600 });
  const script = `import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const original = fs.renameSync;
    fs.renameSync = function(from, to) {
      const result = original(from, to);
      if (String(from) === ${JSON.stringify(f.config)}) {
        fs.writeSync(1, "CLAIMED\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      }
      return result;
    };
    syncBuiltinESMExports();
    const { updateRawConfig } = await import("./dist/config.js");
    updateRawConfig(config => { config.sentinel = "synthetic-new"; });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: process.cwd(), env: { ...process.env, HOME: f.home, USERPROFILE: f.home }, stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "", ready = "", exited = false;
  child.stderr.on("data", data => { stderr += String(data); });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject); child.once("close", code => { exited = true; resolve(code); });
  });
  t.after(async () => { if (!exited) child.kill("SIGKILL"); await closed; });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", data => { ready += String(data); if (ready.includes("CLAIMED\n")) resolve(); });
    child.once("error", reject); child.once("close", () => { if (!ready.includes("CLAIMED\n")) reject(Error("writer did not reach claimed inode gap")); });
  });
  assert.equal(fs.existsSync(f.config), false, "the fixture has the actual CAS namespace gap");
  const config = readRawConfig();
  assert.equal(config.sentinel, "synthetic-new");
  assert.equal(config.provider, "openai");
  assert.equal(await closed, 0, stderr);
  assert.deepEqual(fs.readdirSync(f.state), ["config.json"], "no stale writer/read lock remains");
});
