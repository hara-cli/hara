import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyPortableHomeEnv, MIN_NODE_MAJOR, MIN_NODE_VERSION, normalizePortableWindowsHome, unsupportedNodeMessage } from "../dist/runtime.js";
import { findStaleLocalHaraLinks, isLegacyLinkedTarget, staleLocalLinkWarning } from "../scripts/check-local-bin-link.mjs";

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
  assert.match(pkg.scripts.build, /check-local-bin-link\.mjs/);

  const cli = readFileSync(rootFile("dist/cli.js"), "utf8");
  assert.ok(cli.startsWith("#!/usr/bin/env node\n"));
  if (process.platform !== "win32") {
    assert.equal(statSync(rootFile("runtime-bootstrap.cjs")).mode & 0o777, 0o755);
    assert.equal(statSync(rootFile("dist/cli.js")).mode & 0o777, 0o644);
    assert.equal(statSync(rootFile("dist/index.js")).mode & 0o777, 0o644);
  }

  const docker = readFileSync(rootFile("Dockerfile"), "utf8");
  assert.equal((docker.match(/^FROM node:22-slim AS /gm) ?? []).length, 3);
  const buildStageStart = docker.indexOf("FROM node:22-slim AS build");
  const buildRun = docker.indexOf("RUN npm run build", buildStageStart);
  assert.ok(buildStageStart >= 0 && buildRun > buildStageStart, "Docker build stage runs the package build");
  const buildStageBeforeRun = docker.slice(buildStageStart, buildRun);
  const buildScriptFiles = [...pkg.scripts.build.matchAll(/\bnode\s+(scripts\/[\w./-]+)/g)].map((match) => match[1]);
  assert.ok(buildScriptFiles.length > 0, "the package build declares its script dependencies");
  for (const script of buildScriptFiles) {
    const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(
      buildStageBeforeRun,
      new RegExp(`^COPY ${escaped} \\.\\/${escaped}$`, "m"),
      `Docker build stage copies package build dependency ${script} before npm run build`,
    );
  }
  assert.match(docker, /COPY runtime-bootstrap\.cjs \.\//);
  assert.match(docker, /ENTRYPOINT \["node", "\/app\/runtime-bootstrap\.cjs"\]/);
});

test("local-link doctor detects a stale legacy bin without weakening the guarded entry", {
  skip: process.platform === "win32",
}, () => {
  const root = mkdtempSync(join(tmpdir(), "hara-local-link-"));
  const bin = join(root, "bin");
  const packageRoot = join(root, "package");
  const legacy = join(packageRoot, "dist", "index.js");
  const guarded = join(packageRoot, "runtime-bootstrap.cjs");
  mkdirSync(join(packageRoot, "dist"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(legacy, "#!/usr/bin/env node\n");
  writeFileSync(guarded, "#!/usr/bin/env node\n");
  const command = join(bin, "hara");
  try {
    symlinkSync(legacy, command);
    assert.equal(isLegacyLinkedTarget(legacy, packageRoot), true);
    const [stale] = findStaleLocalHaraLinks(bin, packageRoot);
    assert.equal(stale.binPath, command);
    assert.match(staleLocalLinkWarning(stale, packageRoot), /npm link/);
    assert.match(staleLocalLinkWarning(stale, packageRoot), /Do not chmod dist\/index\.js/);

    rmSync(command);
    symlinkSync(guarded, command);
    assert.deepEqual(findStaleLocalHaraLinks(bin, packageRoot), [], "the guarded bootstrap link is healthy");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
