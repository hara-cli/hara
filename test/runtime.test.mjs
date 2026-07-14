import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { applyPortableHomeEnv, MIN_NODE_MAJOR, MIN_NODE_VERSION, normalizePortableWindowsHome, unsupportedNodeMessage } from "../dist/runtime.js";

const rootFile = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const require = createRequire(import.meta.url);
const bootstrap = require(rootFile("runtime-bootstrap.cjs"));

test("runtime boundary: Node 22.12+ and standalone Bun are accepted", () => {
  assert.equal(MIN_NODE_MAJOR, 22);
  assert.equal(MIN_NODE_VERSION, "22.12.0");
  assert.equal(unsupportedNodeMessage({ node: "22.12.0" }), null);
  assert.equal(unsupportedNodeMessage({ node: "22.22.3" }), null);
  assert.equal(unsupportedNodeMessage({ node: "24.1.0" }), null);
  assert.equal(unsupportedNodeMessage({ node: "20.20.2", bun: "1.3.0" }), null);
});

test("runtime boundary: early Node 22, old, or unknown Node gets one actionable upgrade message", () => {
  for (const node of ["22.11.0", "22.0.0", "20.20.2", "18.20.8", "unknown"]) {
    const message = unsupportedNodeMessage({ node });
    assert.match(message ?? "", /requires Node\.js 22\.12\.0 or newer/i);
    assert.match(message ?? "", /nvm install 22 && nvm use 22/);
    assert.match(message ?? "", /standalone Hara binary/i);
  }
});

test("runtime boundary: legacy CJS bootstrap stays exactly aligned with the ESM runtime policy", () => {
  assert.equal(bootstrap.MIN_NODE_MAJOR, MIN_NODE_MAJOR);
  assert.equal(bootstrap.MIN_NODE_VERSION, MIN_NODE_VERSION);
  for (const versions of [
    { node: "11.4.0" },
    { node: "20.10.0" },
    { node: "22.11.0" },
    { node: "22.12.0" },
    { node: "22.22.3" },
    { node: "20.10.0", bun: "1.3.0" },
  ]) assert.equal(bootstrap.unsupportedNodeMessage(versions), unsupportedNodeMessage(versions));
});

test("Windows portable/Git Bash HOME overrides USERPROFILE before Hara state is loaded", () => {
  const esmEnv = { HOME: "D:\\portable\\home", USERPROFILE: "C:\\Users\\real" };
  const cjsEnv = { ...esmEnv };
  assert.equal(applyPortableHomeEnv(esmEnv, "win32"), true);
  assert.equal(bootstrap.applyPortableHomeEnv(cjsEnv, "win32"), true);
  assert.equal(esmEnv.USERPROFILE, esmEnv.HOME);
  assert.deepEqual(cjsEnv, esmEnv);
  assert.equal(applyPortableHomeEnv({ HOME: "/tmp/unchanged", USERPROFILE: "real" }, "linux"), false);
  assert.equal(normalizePortableWindowsHome("/c/Users/hara"), "C:\\Users\\hara");
  assert.equal(normalizePortableWindowsHome("//server/share/hara"), "\\\\server\\share\\hara");
  const msysEnv = { HOME: "/d/portable/hara", USERPROFILE: "C:\\Users\\real" };
  applyPortableHomeEnv(msysEnv, "win32");
  assert.equal(msysEnv.USERPROFILE, "D:\\portable\\hara");
  assert.equal(bootstrap.normalizePortableWindowsHome("/d/portable/hara"), msysEnv.USERPROFILE);
});

test("runtime packaging: manifests, executable bin, scripts, and Docker use the guarded entry", () => {
  const pkg = JSON.parse(readFileSync(rootFile("package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(rootFile("package-lock.json"), "utf8"));
  assert.deepEqual(pkg.bin, { hara: "runtime-bootstrap.cjs" });
  assert.deepEqual(lock.packages[""].bin, pkg.bin);
  assert.equal(pkg.engines.node, ">=22.12.0");
  assert.equal(lock.packages[""].engines.node, pkg.engines.node);
  assert.equal(pkg.scripts.start, "node runtime-bootstrap.cjs");
  assert.match(pkg.scripts.build, /normalize-dist-modes\.mjs/);

  const cli = readFileSync(rootFile("dist/cli.js"), "utf8");
  assert.ok(cli.startsWith("#!/usr/bin/env node\n"));
  if (process.platform !== "win32") {
    assert.equal(statSync(rootFile("runtime-bootstrap.cjs")).mode & 0o777, 0o755);
    assert.equal(statSync(rootFile("dist/cli.js")).mode & 0o777, 0o644);
    assert.equal(statSync(rootFile("dist/index.js")).mode & 0o777, 0o644);
  }

  const docker = readFileSync(rootFile("Dockerfile"), "utf8");
  assert.equal((docker.match(/^FROM node:22-slim AS /gm) ?? []).length, 3);
  assert.match(docker, /COPY scripts\/normalize-dist-modes\.mjs \.\/scripts\/normalize-dist-modes\.mjs/);
  assert.match(docker, /COPY runtime-bootstrap\.cjs \.\//);
  assert.match(docker, /ENTRYPOINT \["node", "\/app\/runtime-bootstrap\.cjs"\]/);
});
