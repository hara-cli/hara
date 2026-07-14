import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const packageVersion = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function runModuleScript(source) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
    timeout: 20_000,
  });
}

test("Bun-compatible modules load when SharedArrayBuffer is unavailable", () => {
  const result = runModuleScript(`
    Object.defineProperty(globalThis, "SharedArrayBuffer", { value: undefined, configurable: true });
    await Promise.all([
      import("./dist/org/projects.js"),
      import("./dist/gateway/sessions.js"),
      import("./dist/gateway/flows-pending.js"),
      import("./dist/tools/task.js"),
    ]);
    process.stdout.write("modules-ok");
  `);

  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "modules-ok");
});

test("CLI reaches version handling when SharedArrayBuffer is unavailable", () => {
  const result = runModuleScript(`
    Object.defineProperty(globalThis, "SharedArrayBuffer", { value: undefined, configurable: true });
    process.argv = [process.execPath, "hara", "--version"];
    await import("./dist/index.js");
  `);

  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), packageVersion);
});

test("sync sleep prefers Bun.sleepSync without touching SharedArrayBuffer", () => {
  const result = runModuleScript(`
    let waited = -1;
    Object.defineProperty(globalThis, "SharedArrayBuffer", { value: undefined, configurable: true });
    Object.defineProperty(globalThis, "Bun", {
      value: { sleepSync(milliseconds) { waited = milliseconds; } },
      configurable: true,
    });
    const { sleepSync } = await import("./dist/sync-sleep.js");
    sleepSync(7);
    if (waited !== 7) throw new Error(\`unexpected Bun delay: \${waited}\`);
  `);

  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
});

test("sync sleep has a bounded fallback when neither Bun nor SharedArrayBuffer exists", () => {
  const result = runModuleScript(`
    Object.defineProperty(globalThis, "SharedArrayBuffer", { value: undefined, configurable: true });
    Object.defineProperty(globalThis, "Bun", { value: undefined, configurable: true });
    const { sleepSync } = await import("./dist/sync-sleep.js");
    sleepSync(1);
    process.stdout.write("fallback-ok");
  `);

  assert.equal(result.signal, null);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "fallback-ok");
});
