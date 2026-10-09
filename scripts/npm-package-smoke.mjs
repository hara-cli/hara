#!/usr/bin/env node
// Test the actual npm artifact, not source-tree imports. No lifecycle scripts, model calls or user config.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY = "https://registry.npmjs.org/";
// Reviewed public plugin metadata, not private .hara state. No other hidden directory is publishable.
const PUBLIC_PLUGIN_MANIFESTS = Object.freeze([
  "plugins/browser/.hara-plugin/plugin.json", "plugins/chrome/.hara-plugin/plugin.json",
]);
export const REQUIRED_PACKAGE_FILES = Object.freeze([
  "package.json", "runtime-bootstrap.cjs", "dist/cli.js", "dist/index.js",
  "dist/coding/pi.js", "dist/coding/host.js", "dist/coding/tools.js", "dist/coding/continuations.js",
  "dist/coding/accounting.js", "dist/coding/bundled-opencode.js", "dist/opencode-runtime.js",
  "dist/external-sessions/opencode-worker.js", "dist/third-party-notices.js",
  "README.md", "THIRD_PARTY_NOTICES.md", "LICENSE",
  "docs/coding-executors.md", "docs/coding-executors-benchmark.md",
  ...PUBLIC_PLUGIN_MANIFESTS,
]);
const PUBLIC_FILES = new Set([
  ...REQUIRED_PACKAGE_FILES,
  "CHANGELOG.md", "SECURITY.md", "CLA.md", "scripts/jev-wechat-bridge.py",
  "docs/volcengine-agent-plan.md", "docs/volcengine-coding-plan.md",
  "docs/jev-action-guard-experience.md", "docs/wechat-agent-scenes.md",
]);

function expectedFilename(pkg) {
  return `nanhara-hara-${pkg.version}.tgz`;
}

function parseJson(value, label) {
  try { return JSON.parse(value); }
  catch { throw new Error(`${label} is not valid JSON`); }
}

function tarballIntegrity(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > 64 * 1024 * 1024) {
    throw new Error("npm tarball identity/size mismatch");
  }
  return `sha512-${createHash("sha512").update(readFileSync(path)).digest("base64")}`;
}

/** npm 12 keys pack JSON by package name; older npm emits an array. Accept exactly one expected entry. */
export function normalizePackManifest(manifest, pkg) {
  let packed;
  if (Array.isArray(manifest) && manifest.length === 1) packed = manifest[0];
  else if (manifest && typeof manifest === "object" && pkg?.name === "@nanhara/hara"
    && Object.keys(manifest).length === 1 && Object.hasOwn(manifest, pkg.name)) packed = manifest[pkg.name];
  if (!packed || typeof packed !== "object" || Array.isArray(packed)) {
    throw new Error("npm pack returned an invalid manifest");
  }
  return packed;
}

/** Pure fail-closed inspection of npm pack's actual file manifest. Generated state is never publishable. */
export function inspectPackageFiles(packed, pkg) {
  if (pkg?.name !== "@nanhara/hara" || packed?.name !== pkg.name || packed.version !== pkg.version
    || typeof packed.filename !== "string" || !/^[A-Za-z0-9._-]+\.tgz$/u.test(packed.filename)
    || packed.filename !== expectedFilename(pkg)
    || !Array.isArray(packed.files) || packed.files.length === 0) throw new Error("npm artifact identity/manifest mismatch");
  const paths = new Set();
  for (const entry of packed.files) {
    const path = entry?.path;
    if (typeof path !== "string" || /[\\\u0000-\u001f\u007f:]/u.test(path)
      || path.split("/").some((part) => !part || part === "." || part === ".."
        || (part.startsWith(".") && !PUBLIC_PLUGIN_MANIFESTS.includes(path)))
      || paths.has(path)) throw new Error("npm artifact contains an unsafe or duplicate member");
    const privateMember = path.split("/").some((part) =>
      /^(?:auth|credentials?|secrets?|tokens?|sessions?|settings)\.json$/iu.test(part)
      || /\.(?:pem|p12|pfx|key|sqlite|sqlite3|db)$/iu.test(part));
    const publicModule = /^dist\/(?!bin\/)[A-Za-z0-9_/-]+\.js$/u.test(path);
    const publicPlugin = /^plugins\/(?:browser|chrome)\/skills\/[a-z0-9-]+\/SKILL\.md$/u.test(path);
    if (privateMember || (!PUBLIC_FILES.has(path) && !publicModule && !publicPlugin)) {
      throw new Error("npm artifact contains a member outside the public file allowlist");
    }
    paths.add(path);
  }
  for (const path of REQUIRED_PACKAGE_FILES) {
    if (!paths.has(path)) throw new Error(`npm artifact is missing required file ${path}`);
  }
  return { fileCount: paths.size };
}

/** The publication receipt contains public identity and the exact tested bytes, never environment data. */
export function inspectPackageReceipt(receipt, pkg) {
  if (!receipt || Array.isArray(receipt) || pkg?.name !== "@nanhara/hara"
    || Object.keys(receipt).sort().join(",") !== "filename,integrity,name,version"
    || receipt.name !== pkg.name || receipt.version !== pkg.version
    || receipt.filename !== expectedFilename(pkg) || !/^[A-Za-z0-9._-]+\.tgz$/u.test(receipt.filename)
    || typeof receipt.integrity !== "string" || receipt.integrity.length !== 95
    || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(receipt.integrity)) {
    throw new Error("verified npm package receipt identity/integrity mismatch");
  }
  return { filename: receipt.filename, integrity: receipt.integrity };
}

/** Read-only final handoff: resolve one expected artifact and ensure it still matches the tested SHA-512. */
export function verifyRetainedPackage(directory, pkg) {
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700)) {
    throw new Error("verified npm package directory must be private and not a symlink");
  }
  const root = realpathSync(directory), filename = expectedFilename(pkg);
  if (readdirSync(root).sort().join(",") !== [filename, "receipt.json"].sort().join(",")) {
    throw new Error("verified npm package directory contains unexpected members");
  }
  const receiptPath = join(root, "receipt.json"), receiptStat = lstatSync(receiptPath);
  if (!receiptStat.isFile() || receiptStat.nlink !== 1 || receiptStat.size > 4096) {
    throw new Error("verified npm package receipt must be a bounded regular file");
  }
  const receipt = inspectPackageReceipt(parseJson(readFileSync(receiptPath, "utf8"), "npm package receipt"), pkg);
  const tarball = join(root, receipt.filename);
  if (tarballIntegrity(tarball) !== receipt.integrity) throw new Error("verified npm tarball changed after acceptance");
  return { tarball, integrity: receipt.integrity };
}

/** Reuse an explicitly selected public npm cache by path, never copy it or inherit npm/user secrets. */
export function packageSmokeEnv(home, cache, sourceEnv = {}) {
  return {
    PATH: sourceEnv.PATH ?? "",
    HOME: home, USERPROFILE: home,
    APPDATA: join(home, "appdata"), LOCALAPPDATA: join(home, "localappdata"),
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
    TMPDIR: join(home, "tmp"), TMP: join(home, "tmp"), TEMP: join(home, "tmp"),
    NPM_CONFIG_CACHE: cache,
    NPM_CONFIG_USERCONFIG: join(home, "user-npmrc"),
    NPM_CONFIG_GLOBALCONFIG: join(home, "global-npmrc"),
    NPM_CONFIG_PREFIX: join(home, "npm-prefix"), NPM_CONFIG_LOGS_DIR: join(home, "npm-logs"),
    NPM_CONFIG_REGISTRY: REGISTRY, NPM_CONFIG_IGNORE_SCRIPTS: "true",
    NPM_CONFIG_UPDATE_NOTIFIER: "false", NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false",
    NO_COLOR: "1", HARA_UPDATE_CHECK: "0", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    ...(process.platform === "win32" ? {
      SystemRoot: sourceEnv.SystemRoot ?? sourceEnv.SYSTEMROOT ?? "C:\\Windows",
      windir: sourceEnv.windir ?? sourceEnv.WINDIR ?? sourceEnv.SystemRoot ?? "C:\\Windows",
    } : {}),
  };
}

export function matchingNpmCliCandidates(execPath) {
  const prefix = dirname(dirname(execPath));
  return [
    join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(prefix, "node_modules", "npm", "bin", "npm-cli.js"),
  ];
}

export function npmInstallArgs(tarball, prefix, { offline = false, cache } = {}) {
  return [
    "install", tarball, "--prefix", prefix, "--ignore-scripts", "--omit=dev", "--include=optional",
    "--no-save", "--no-package-lock", "--no-audit", "--no-fund", "--registry", REGISTRY,
    ...(cache ? ["--cache", cache] : []), offline ? "--offline" : "--prefer-offline",
  ];
}

/** Fresh tarball installs resolve ranges without the checkout lockfile; Windows gets a longer bounded budget. */
export function npmInstallTimeout(platform = process.platform) {
  return platform === "win32" ? 360_000 : 180_000;
}

/** Only fixed stage names, OS failure codes and timings are reportable; never echo child output. */
export function packageSmokeCommandFailure(result, label, timeout, elapsedMs, offline = false) {
  const value = result.error?.code ?? result.signal ?? result.status;
  const reason = typeof value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(value) ? value
    : Number.isSafeInteger(value) ? value : "spawn error";
  return `${label} failed (${reason}); elapsed ${Math.max(0, Math.round(elapsedMs))}ms, timeout ${timeout}ms`
    + (offline ? "; offline mode requires a prefilled npm metadata/tarball cache" : "");
}

// Run in a separate Node process so even SDK module initialization gets only the private environment.
const INSTALLED_MODULE_PROBE = String.raw`
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = realpathSync(process.argv[2]), prefix = realpathSync(process.argv[3]);
const owned = (path) => {
  const canonical = realpathSync(path), rel = relative(prefix, canonical);
  assert.ok(rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel), "installed dependency escaped the private prefix");
  return canonical;
};
const pkg = JSON.parse(readFileSync(owned(join(root, "package.json")), "utf8"));
const load = (path) => import(pathToFileURL(owned(join(root, path))).href);
const sdk = await import(pathToFileURL(owned(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")))).href);
assert.equal(sdk.VERSION, pkg.dependencies["@earendil-works/pi-coding-agent"]);
assert.equal(sdk.CURRENT_SESSION_VERSION, 3);
for (const [path, name] of [
  ["dist/coding/pi.js", "executePiCodingAgent"], ["dist/coding/host.js", "createCodingHostBridge"],
  ["dist/coding/tools.js", "createCodingToolset"], ["dist/coding/continuations.js", "createCodingContinuationStore"],
  ["dist/external-sessions/opencode-worker.js", "OpenCodeCodingWorkerAdapter"],
]) assert.equal(typeof (await load(path))[name], "function", "installed coding API missing");
assert.equal((await load("dist/coding/bundled-opencode.js")).bundledOpenCodeRuntime, undefined);
const runtime = await load("dist/opencode-runtime.js");
const resolved = runtime.resolveHaraCodeRuntime();
assert.equal(resolved.available, true, "matching native optional dependency unavailable");
assert.equal(resolved.source, "installed-package");
assert.equal(pkg.optionalDependencies[resolved.packageName], runtime.HARA_CODE_RUNTIME_VERSION);
const native = spawnSync(owned(resolved.command), ["--version"], {
  cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
});
assert.equal(native.error, undefined); assert.equal(native.status, 0);
assert.equal(native.stdout.trim(), runtime.HARA_CODE_RUNTIME_VERSION);
console.log(resolved.packageName);
`;

/** Anchor ESM import conditions to the private installation before loading its contained SDK. */
export function writeInstalledModuleProbe(installed) {
  const path = join(installed, "npm-package-module-probe.mjs");
  writeFileSync(path, INSTALLED_MODULE_PROBE, { flag: "wx", mode: 0o600 });
  return path;
}

/** Assumes a prior build in the candidate tree. Packing/installing must never rebuild canonical dist. */
export function runNpmPackageSmoke({ packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."), cache, offline = false, packDestination } = {}) {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && (minor < 23 || (minor === 23 && patch < 1)))) {
    throw new Error("npm package smoke requires the repository-approved Node 22.23.1 or newer");
  }
  const npmCli = matchingNpmCliCandidates(process.execPath).find((path) => existsSync(path));
  if (!npmCli) throw new Error("npm CLI is missing from the active Node installation");
  const root = realpathSync(packageRoot);
  const pkg = parseJson(readFileSync(join(root, "package.json"), "utf8"), "package metadata");
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "hara-npm-package-")));
  let retainedDirectory, accepted = false;
  try {
    if (process.platform !== "win32") chmodSync(scratch, 0o700);
    const home = join(scratch, "home"), prefix = join(scratch, "prefix");
    let packedDir = join(scratch, "packed");
    if (packDestination) {
      const destination = resolve(packDestination);
      // A fresh leaf only: never overwrite prior evidence or pack into the source tree itself.
      const parent = realpathSync(dirname(destination)), canonical = join(parent, basename(destination));
      const fromSource = relative(root, canonical);
      if (!fromSource || (fromSource !== ".." && !fromSource.startsWith(`..${sep}`) && !isAbsolute(fromSource))) {
        throw new Error("retained npm artifacts must be outside the package source tree");
      }
      mkdirSync(canonical, { mode: 0o700 });
      retainedDirectory = packedDir = canonical;
      if (process.platform !== "win32") chmodSync(packedDir, 0o700);
    } else mkdirSync(packedDir, { mode: 0o700 });
    for (const directory of [home, join(home, "tmp"), prefix]) mkdirSync(directory, { mode: 0o700 });
    const selectedCache = cache ? resolve(cache) : join(scratch, "npm-cache");
    const env = packageSmokeEnv(home, selectedCache, process.env);
    const run = (command, args, label, timeout = 60_000) => {
      console.error(`npm package smoke: ${label} started (timeout ${timeout}ms)`);
      const started = performance.now();
      const result = spawnSync(command, args, { cwd: scratch, env, encoding: "utf8", timeout, maxBuffer: 8 * 1024 * 1024 });
      const elapsedMs = performance.now() - started;
      if (result.error || result.status !== 0) {
        throw new Error(packageSmokeCommandFailure(result, label, timeout, elapsedMs, offline));
      }
      console.error(`npm package smoke: ${label} passed (${Math.round(elapsedMs)}ms)`);
      return result.stdout;
    };
    const manifest = parseJson(run(process.execPath, [npmCli, "pack", root, "--ignore-scripts", "--json", "--pack-destination", packedDir], "npm pack"), "npm pack manifest");
    const packed = normalizePackManifest(manifest, pkg), inspected = inspectPackageFiles(packed, pkg);
    const tarball = join(packedDir, packed.filename);
    if (tarballIntegrity(tarball) !== packed.integrity) throw new Error("npm tarball integrity mismatch");
    run(process.execPath, [npmCli, ...npmInstallArgs(tarball, prefix, { offline, cache: selectedCache })], "isolated npm install", npmInstallTimeout());
    const installed = realpathSync(join(prefix, "node_modules", "@nanhara", "hara"));
    const installedRelative = relative(prefix, installed);
    if (installedRelative === ".." || installedRelative.startsWith(`..${sep}`) || isAbsolute(installedRelative)) {
      throw new Error("installed npm package escaped the private prefix");
    }
    const installedPkg = parseJson(readFileSync(join(installed, "package.json"), "utf8"), "installed package metadata");
    if (installedPkg.name !== pkg.name || installedPkg.version !== pkg.version || installedPkg.bin?.hara !== "runtime-bootstrap.cjs") {
      throw new Error("installed npm package identity/bin mismatch");
    }
    const bootstrap = join(installed, "runtime-bootstrap.cjs");
    const bin = join(prefix, "node_modules", ".bin", process.platform === "win32" ? "hara.cmd" : "hara");
    if (!existsSync(bin) || (process.platform !== "win32" && (realpathSync(bin) !== realpathSync(bootstrap) || (lstatSync(bootstrap).mode & 0o111) === 0))) {
      throw new Error("installed npm CLI shim is missing or incorrect");
    }
    if (run(process.execPath, [bootstrap, "--version"], "installed CLI version").trim() !== pkg.version) throw new Error("installed CLI version mismatch");
    const notices = readFileSync(join(installed, "THIRD_PARTY_NOTICES.md"), "utf8").trim();
    if (!notices.includes("Mario Zechner") || !notices.includes("opencode")
      || run(process.execPath, [bootstrap, "licenses"], "installed CLI licenses").trim() !== notices) throw new Error("installed license notices mismatch");
    const help = run(process.execPath, [bootstrap, "--help"], "installed CLI help");
    if (!help.includes("coding") || !help.includes("licenses")) throw new Error("installed CLI commands are missing");
    const moduleProbe = writeInstalledModuleProbe(installed);
    const nativePackage = run(process.execPath, [moduleProbe, installed, prefix], "installed coding APIs/native runtime").trim();
    if (retainedDirectory) {
      const receipt = { name: pkg.name, version: pkg.version, filename: packed.filename, integrity: packed.integrity };
      inspectPackageReceipt(receipt, pkg);
      writeFileSync(join(retainedDirectory, "receipt.json"), `${JSON.stringify(receipt)}\n`, { flag: "wx", mode: 0o600 });
      verifyRetainedPackage(retainedDirectory, pkg);
    }
    accepted = true;
    console.log(`✓ npm ${pkg.version}: ${inspected.fileCount} public files, isolated CLI/Pi APIs and ${nativePackage}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    if (retainedDirectory && !accepted) rmSync(retainedDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let cache, packDestination, verifyDirectory, offline = false;
    for (let index = 2; index < process.argv.length; index += 1) {
      if (process.argv[index] === "--offline") offline = true;
      else if (process.argv[index] === "--cache" && process.argv[index + 1]) cache = process.argv[++index];
      else if (process.argv[index] === "--pack-destination" && process.argv[index + 1]) packDestination = process.argv[++index];
      else if (process.argv[index] === "--verify-retained" && process.argv[index + 1]) verifyDirectory = process.argv[++index];
      else throw new Error("usage: node scripts/npm-package-smoke.mjs [--offline] [--cache <public-npm-cache>] [--pack-destination <fresh-directory>] | --verify-retained <directory>");
    }
    if (verifyDirectory) {
      if (cache || packDestination || offline) throw new Error("--verify-retained cannot be combined with pack/install options");
      const pkg = parseJson(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"), "package metadata");
      console.log(verifyRetainedPackage(verifyDirectory, pkg).tarball);
    } else runNpmPackageSmoke({ cache, offline, packDestination });
  } catch (error) {
    console.error(`npm package smoke: ${error instanceof Error ? error.message : "verification failed"}`);
    process.exitCode = 1;
  }
}
