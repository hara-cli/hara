import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  REQUIRED_PACKAGE_FILES,
  inspectPackageFiles,
  inspectPackageReceipt,
  verifyRetainedPackage,
  packageSmokeEnv,
  npmInstallArgs,
  npmInstallTimeout,
  packageSmokeCommandFailure,
  matchingNpmCliCandidates,
  writeInstalledModuleProbe,
} from "../scripts/npm-package-smoke.mjs";

const pkg = { name: "@nanhara/hara", version: "0.184.1" };
const registry = "https://registry.npmjs.org";
const scratch = join(tmpdir(), "hara-npm-package-smoke-contract");
const home = join(scratch, "home");
const cache = join(scratch, "existing-npm-cache");

function packed(extraPaths = []) {
  return {
    ...pkg,
    filename: "nanhara-hara-0.184.1.tgz",
    files: [...REQUIRED_PACKAGE_FILES, ...extraPaths].map((path) => ({ path, size: 1, mode: 0o644 })),
  };
}

function below(base, path) {
  assert.equal(typeof path, "string");
  assert.ok(isAbsolute(path), "isolated environment paths must be absolute");
  const suffix = relative(base, path);
  assert.ok(suffix && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix),
    "configuration and temporary paths must remain below the isolated home");
}

function environmentValues(env, name) {
  return Object.entries(env).filter(([key]) => key.toUpperCase() === name.toUpperCase()).map(([, value]) => value);
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  assert.ok(index >= 0, `${name} must be an explicit npm argument`);
  assert.equal(args.filter((value) => value === name).length, 1);
  return args[index + 1];
}

function installedProbeFixture(t, escapedSdk = false) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "hara-npm-module-probe-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const prefix = join(directory, "prefix"), root = join(prefix, "node_modules", "@nanhara", "hara");
  const sdkLink = join(prefix, "node_modules", "@earendil-works", "pi-coding-agent");
  const sdkRoot = escapedSdk ? join(directory, "outside-sdk") : sdkLink;
  const write = (path, content) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, content, { mode: 0o600 });
  };
  write(join(root, "package.json"), JSON.stringify({
    type: "module", dependencies: { "@earendil-works/pi-coding-agent": "1.1.0" },
  }));
  write(join(sdkRoot, "package.json"), JSON.stringify({
    type: "module", exports: { ".": { import: "./index.js" } },
  }));
  write(join(sdkRoot, "index.js"), escapedSdk
    ? 'throw new Error("escaped-sdk-must-not-execute");'
    : 'export const VERSION = "1.1.0", CURRENT_SESSION_VERSION = 3;');
  if (escapedSdk) {
    mkdirSync(dirname(sdkLink), { recursive: true });
    symlinkSync(sdkRoot, sdkLink, process.platform === "win32" ? "junction" : "dir");
  }
  for (const [path, name] of [
    ["dist/coding/pi.js", "executePiCodingAgent"], ["dist/coding/host.js", "createCodingHostBridge"],
    ["dist/coding/tools.js", "createCodingToolset"], ["dist/coding/continuations.js", "createCodingContinuationStore"],
    ["dist/external-sessions/opencode-worker.js", "OpenCodeCodingWorkerAdapter"],
  ]) write(join(root, path), `export function ${name}() {}`);
  write(join(root, "dist/coding/bundled-opencode.js"), "export const bundledOpenCodeRuntime = undefined;");
  // Stop after all SDK/API checks, before any native process; this fixture runs on every platform.
  write(join(root, "dist/opencode-runtime.js"),
    'export function resolveHaraCodeRuntime() { throw new Error("fixture-reached-runtime"); }');
  const privateHome = join(directory, "home");
  mkdirSync(join(privateHome, "tmp"), { recursive: true, mode: 0o700 });
  const probe = writeInstalledModuleProbe(root);
  const result = spawnSync(process.execPath, [probe, root, prefix], {
    cwd: directory, env: packageSmokeEnv(privateHome, join(directory, "cache"), { PATH: process.env.PATH }),
    encoding: "utf8", timeout: 10_000,
  });
  return { result, root, probe };
}

test("installed module probe resolves an import-only SDK with ESM conditions from its private package", (t) => {
  const { result, root, probe } = installedProbeFixture(t);
  assert.throws(() => createRequire(join(root, "package.json")).resolve("@earendil-works/pi-coding-agent"),
    { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" }, "CommonJS resolution must reproduce the original failure");
  assert.equal(dirname(probe), root);
  if (process.platform !== "win32") assert.equal(lstatSync(probe).mode & 0o777, 0o600);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /fixture-reached-runtime/u, "ESM SDK and every coding API must load before the fixture stops");
  assert.doesNotMatch(result.stderr, /ERR_PACKAGE_PATH_NOT_EXPORTED/u);
});

test("installed module probe rejects an ESM SDK outside its private prefix before initialization", (t) => {
  const { result } = installedProbeFixture(t, true);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /installed dependency escaped the private prefix/u);
  assert.doesNotMatch(result.stderr, /escaped-sdk-must-not-execute|fixture-reached-runtime/u);
});

test("required packed files cover the two coding runtimes, owned bridge and offline notices", () => {
  assert.equal(new Set(REQUIRED_PACKAGE_FILES).size, REQUIRED_PACKAGE_FILES.length);
  for (const path of [
    "package.json", "runtime-bootstrap.cjs", "dist/cli.js", "dist/index.js",
    "dist/coding/pi.js", "dist/coding/host.js", "dist/coding/tools.js",
    "dist/coding/continuations.js", "dist/coding/accounting.js", "dist/coding/bundled-opencode.js",
    "dist/opencode-runtime.js", "dist/external-sessions/opencode-worker.js",
    "dist/third-party-notices.js", "THIRD_PARTY_NOTICES.md", "docs/coding-executors.md",
    "plugins/browser/.hara-plugin/plugin.json", "plugins/chrome/.hara-plugin/plugin.json",
  ]) assert.ok(REQUIRED_PACKAGE_FILES.includes(path), `${path} must not be optional package content`);
});

test("complete package and ordinary compiled config or reviewed plugin Markdown are accepted", () => {
  const info = packed(["dist/config.js", "plugins/chrome/skills/chrome/SKILL.md"]);
  assert.deepEqual(inspectPackageFiles(info, pkg), { fileCount: info.files.length });
});

test("both reviewed public plugin metadata files are required and accepted despite their exact hidden component", () => {
  const info = packed();
  for (const path of ["plugins/browser/.hara-plugin/plugin.json", "plugins/chrome/.hara-plugin/plugin.json"]) {
    assert.ok(REQUIRED_PACKAGE_FILES.includes(path));
    assert.equal(info.files.filter((entry) => entry.path === path).length, 1);
  }
  assert.deepEqual(inspectPackageFiles(info, pkg), { fileCount: info.files.length });
});

test("plugin metadata exceptions never allow other plugins, sibling JSON, hidden paths or lookalike members", () => {
  const rejected = [
    "plugins/other/.hara-plugin/plugin.json",
    "plugins/browser-extra/.hara-plugin/plugin.json",
    "plugins/chrome-extra/.hara-plugin/plugin.json",
    "plugins/Browser/.hara-plugin/plugin.json",
  ];
  for (const plugin of ["browser", "chrome"]) {
    const prefix = `plugins/${plugin}`;
    const metadata = `${prefix}/.hara-plugin/plugin.json`;
    rejected.push(
      `${prefix}/.hara-plugin/credentials.json`, `${prefix}/.hara-plugin/other.json`,
      `${prefix}/.hara-plugin/.hidden.json`, `${prefix}/.hara-plugin/.env`,
      `${prefix}/.other/plugin.json`, `${prefix}/.git/plugin.json`,
      `${prefix}/.hara-plugin-extra/plugin.json`, `${prefix}/prefix.hara-plugin/plugin.json`,
      `${prefix}/.hara-plugin/Plugin.json`, `${prefix}/.hara-plugin/plugin.json.bak`,
      `${metadata}/extra.json`, `prefix/${metadata}`, `${prefix}//.hara-plugin/plugin.json`,
      `./${metadata}`, `${prefix}/.hara-plugin/../.hara-plugin/plugin.json`,
      `${prefix}/.hara-plugin/../../other/.hara-plugin/plugin.json`,
      metadata.replaceAll("/", "\\"), `${metadata}\0`, `${metadata}\n`,
    );
  }
  for (const path of rejected) {
    assert.throws(() => inspectPackageFiles(packed([path]), pkg), undefined, JSON.stringify(path));
  }
});

test("a missing required runtime or license file makes the packed package incomplete", () => {
  for (const missing of REQUIRED_PACKAGE_FILES) {
    const info = packed();
    info.files = info.files.filter(({ path }) => path !== missing);
    assert.throws(() => inspectPackageFiles(info, pkg), undefined, missing);
  }
});

test("packed identity, version and exact archive filename must match the source package", () => {
  for (const patch of [
    { name: "@other/hara" }, { version: "0.184.2" },
    { filename: "other-0.184.1.tgz" }, { filename: "nanhara-hara-0.184.2.tgz" },
    { filename: "../nanhara-hara-0.184.1.tgz" },
    { filename: "/tmp/nanhara-hara-0.184.1.tgz" },
  ]) assert.throws(() => inspectPackageFiles({ ...packed(), ...patch }, pkg));
});

function receipt(patch = {}) {
  return {
    ...pkg,
    filename: `nanhara-hara-${pkg.version}.tgz`,
    integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    ...patch,
  };
}

test("a retained-package receipt accepts only the exact package identity and complete SHA-512 format", () => {
  assert.doesNotThrow(() => inspectPackageReceipt(receipt(), pkg));
  assert.doesNotThrow(() => inspectPackageReceipt(receipt({
    integrity: `sha512-${Buffer.alloc(64, 0xff).toString("base64")}`,
  }), pkg));
});

test("retained-package receipt rejects incomplete objects and mismatched package identities", () => {
  for (const value of [undefined, null, [], {}, "receipt.json"]) {
    assert.throws(() => inspectPackageReceipt(value, pkg));
  }
  for (const field of ["name", "version", "filename", "integrity"]) {
    const value = receipt();
    delete value[field];
    assert.throws(() => inspectPackageReceipt(value, pkg), undefined, field);
  }
  for (const patch of [{ name: "@other/hara" }, { version: "0.184.2" }]) {
    assert.throws(() => inspectPackageReceipt(receipt(patch), pkg));
  }
});

test("retained receipt cannot redirect publication to a traversing, absolute or differently named archive", () => {
  for (const filename of [
    "other-0.184.1.tgz", "nanhara-hara-0.184.2.tgz", "nanhara-hara-0.184.1.tar.gz",
    "../nanhara-hara-0.184.1.tgz", "./nanhara-hara-0.184.1.tgz",
    "subdir/nanhara-hara-0.184.1.tgz", "/tmp/nanhara-hara-0.184.1.tgz",
    "C:/private/nanhara-hara-0.184.1.tgz", "C:\\private\\nanhara-hara-0.184.1.tgz",
    "nanhara-hara-0.184.1.tgz\0", "nanhara-hara-0.184.1.tgz\n",
  ]) assert.throws(() => inspectPackageReceipt(receipt({ filename }), pkg), undefined, JSON.stringify(filename));
});

test("retained receipt requires one unambiguous, well-formed SHA-512 integrity value", () => {
  const digest = Buffer.alloc(64).toString("base64");
  for (const integrity of [
    undefined, null, 1, "", `sha256-${digest}`, `sha512-${Buffer.alloc(32).toString("base64")}`,
    `sha512-${digest.slice(0, -1)}`, `sha512-${digest}=`, `sha512-${"!".repeat(86)}==`,
    ` sha512-${digest}`, `sha512-${digest}\n`, `sha512-${digest} sha512-${digest}`,
  ]) assert.throws(() => inspectPackageReceipt(receipt({ integrity }), pkg));
});

function retainedFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hara-retained-package-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, "retained");
  mkdirSync(directory, { mode: 0o700 });
  const bytes = Buffer.from("synthetic npm archive bytes; not an installable package");
  const metadata = receipt({ integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}` });
  const tarball = join(directory, metadata.filename);
  const receiptPath = join(directory, "receipt.json");
  writeFileSync(tarball, bytes, { flag: "wx", mode: 0o600 });
  writeFileSync(receiptPath, JSON.stringify(metadata), { flag: "wx", mode: 0o600 });
  return { root, directory, bytes, metadata, tarball, receiptPath };
}

test("retained-package handoff reads exactly the accepted bytes and returns their absolute archive path", (t) => {
  const f = retainedFixture(t);
  const before = lstatSync(f.tarball);
  const originalReceipt = readFileSync(f.receiptPath, "utf8");
  assert.deepEqual(verifyRetainedPackage(f.directory, pkg), { tarball: f.tarball, integrity: f.metadata.integrity });
  assert.deepEqual(readFileSync(f.tarball), f.bytes);
  assert.equal(readFileSync(f.receiptPath, "utf8"), originalReceipt);
  const after = lstatSync(f.tarball);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.mode, before.mode);
});

test("changed retained archive bytes are refused without repairing or repacking them", (t) => {
  const f = retainedFixture(t);
  const changed = Buffer.from("different archive bytes after acceptance");
  writeFileSync(f.tarball, changed);
  assert.throws(() => verifyRetainedPackage(f.directory, pkg));
  assert.deepEqual(readFileSync(f.tarball), changed);
});

test("retained handoff rejects a missing archive and unrelated extra members", (t) => {
  const missing = retainedFixture(t);
  rmSync(missing.tarball);
  assert.throws(() => verifyRetainedPackage(missing.directory, pkg));
  assert.equal(existsSync(missing.tarball), false);
  const extra = retainedFixture(t);
  writeFileSync(join(extra.directory, "unrelated.tgz"), "not accepted");
  assert.throws(() => verifyRetainedPackage(extra.directory, pkg));
});

test("retained handoff refuses malformed, oversized and unexpected-field receipts", (t) => {
  const f = retainedFixture(t);
  for (const value of ["{ malformed receipt", " ".repeat(4097), JSON.stringify({ ...f.metadata, command: "untrusted" })]) {
    writeFileSync(f.receiptPath, value);
    assert.throws(() => verifyRetainedPackage(f.directory, pkg));
    assert.equal(readFileSync(f.receiptPath, "utf8"), value);
  }
});

test("retained handoff rejects hard-linked archive and receipt aliases", (t) => {
  for (const member of ["tarball", "receiptPath"]) {
    const f = retainedFixture(t);
    linkSync(f[member], join(f.root, "outside-alias"));
    assert.throws(() => verifyRetainedPackage(f.directory, pkg));
    assert.equal(lstatSync(f[member]).nlink, 2);
  }
});

test("retained handoff refuses a shared-looking directory without tightening its mode", {
  skip: process.platform === "win32",
}, (t) => {
  const f = retainedFixture(t);
  chmodSync(f.directory, 0o755);
  assert.throws(() => verifyRetainedPackage(f.directory, pkg));
  assert.equal(lstatSync(f.directory).mode & 0o777, 0o755);
});

test("retained handoff refuses symlinked directories, receipts and tarballs without following or replacing them", {
  skip: process.platform === "win32",
}, (t) => {
  const directory = retainedFixture(t);
  const linkedDirectory = join(directory.root, "linked-directory");
  symlinkSync(directory.directory, linkedDirectory);
  assert.throws(() => verifyRetainedPackage(linkedDirectory, pkg));
  for (const member of ["tarball", "receiptPath"]) {
    const f = retainedFixture(t);
    const outside = join(f.root, "outside-member");
    const original = readFileSync(f[member]);
    writeFileSync(outside, original);
    rmSync(f[member]);
    symlinkSync(outside, f[member]);
    assert.throws(() => verifyRetainedPackage(f.directory, pkg));
    assert.equal(lstatSync(f[member]).isSymbolicLink(), true);
    assert.deepEqual(readFileSync(outside), original);
  }
});

test("duplicate package members are rejected instead of hiding overwritten archive paths", () => {
  const info = packed([REQUIRED_PACKAGE_FILES[0]]);
  assert.throws(() => inspectPackageFiles(info, pkg));
});

test("project state, credentials and arbitrary root configuration are never allowed into the tarball", () => {
  for (const path of [
    ".root", "config.json", "config.js", "config/private.json", "credentials.json",
    ".hara/config.json", ".hara/sessions/session.jsonl", ".env", ".env.production",
    ".git/config", ".npmrc", "dist/.env", "plugins/chrome/.env",
    "plugins/chrome/private.key", "plugins/chrome/signing.pem",
  ]) assert.throws(() => inspectPackageFiles(packed([path]), pkg), undefined, path);
});

test("absolute, traversing, noncanonical and backslash package member paths are rejected", () => {
  for (const path of [
    "/tmp/private.json", "C:/private/config.json", "C:\\private\\config.json",
    "../config.js", "dist/../config.js", "./dist/config.js", "dist//config.js",
    "dist\\config.js", "dist/config.js\0", "dist/\nconfig.js",
  ]) assert.throws(() => inspectPackageFiles(packed([path]), pkg), undefined, JSON.stringify(path));
});

test("standalone binaries, non-JavaScript dist files and unrelated executable scripts are rejected", () => {
  for (const path of [
    "dist/bin/hara", "dist/bin/hara.exe", "dist/bin/worker.js", "node_modules/example/index.js",
    "dist/config.json", "dist/config.ts", "dist/config.js.map", "dist/runtime.exe",
    "scripts/unreviewed.mjs", "scripts/startup.sh", "plugins/chrome/startup.js",
  ]) assert.throws(() => inspectPackageFiles(packed([path]), pkg), undefined, path);
});

test("package smoke redirects home, configuration, state and temporary files into its private root", () => {
  const env = packageSmokeEnv(home, cache, { PATH: "fixture-node-path" });
  assert.equal(env.HOME, home);
  assert.equal(env.USERPROFILE, home);
  for (const name of [
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
    "APPDATA", "LOCALAPPDATA", "TMPDIR", "TMP", "TEMP",
    "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_GLOBALCONFIG",
  ]) {
    const values = environmentValues(env, name);
    assert.equal(values.length, 1, `${name} must have exactly one isolated definition`);
    below(home, values[0]);
  }
  assert.notEqual(env.NPM_CONFIG_USERCONFIG, env.NPM_CONFIG_GLOBALCONFIG,
    "npm refuses double-loading the same file as both user and global configuration");
  assert.deepEqual(environmentValues(env, "NPM_CONFIG_CACHE"), [cache]);
  assert.equal(env.PATH, "fixture-node-path");
  assert.equal(String(env.NPM_CONFIG_REGISTRY).replace(/\/$/u, ""), registry);
  assert.equal(env.NPM_CONFIG_IGNORE_SCRIPTS, "true");
  assert.equal(env.HARA_UPDATE_CHECK, "0");
});

test("package smoke does not inherit credentials, proxies, preloads or runtime overrides", () => {
  const forbidden = [
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NPM_TOKEN", "NODE_AUTH_TOKEN", "AWS_SECRET_ACCESS_KEY",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy",
    "NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS", "BUN_ENV", "BASH_ENV", "ENV",
    "HARA_CODE_RUNTIME_PATH", "HARA_CODING_EXECUTOR", "HARA_CONFIG_PATH", "HARA_ALLOW_SENSITIVE_FILES",
    "HARA_SUBPROCESS_ENV_ALLOW", "PI_PACKAGE_DIR", "PI_CODING_AGENT_DIR", "SSH_AUTH_SOCK",
  ];
  const sourceEnv = Object.fromEntries(forbidden.map((name) => [name, "untrusted-fixture-value"]));
  Object.assign(sourceEnv, {
    PATH: "fixture-node-path", HOME: "untrusted-home", USERPROFILE: "untrusted-profile",
    npm_config_registry: "https://untrusted.invalid", npm_config_cache: "untrusted-cache",
    npm_config_userconfig: "untrusted-userconfig", NpM_CoNfIg_GlObAlCoNfIg: "untrusted-globalconfig",
    npm_config_ignore_scripts: "false", HARA_UPDATE_CHECK: "1",
  });
  const original = { ...sourceEnv };
  const env = packageSmokeEnv(home, cache, sourceEnv);
  assert.deepEqual(sourceEnv, original, "isolation must not mutate the launching process environment");
  for (const name of forbidden) assert.deepEqual(environmentValues(env, name), [], name);
  assert.deepEqual(environmentValues(env, "NPM_CONFIG_REGISTRY"), [env.NPM_CONFIG_REGISTRY]);
  assert.deepEqual(environmentValues(env, "NPM_CONFIG_CACHE"), [cache]);
  assert.deepEqual(environmentValues(env, "NPM_CONFIG_IGNORE_SCRIPTS"), ["true"]);
  assert.deepEqual(environmentValues(env, "HARA_UPDATE_CHECK"), ["0"]);
});

test("Windows retains only the OS root compatibility variables, not real account locations", {
  skip: process.platform !== "win32",
}, () => {
  const env = packageSmokeEnv(home, cache, {
    PATH: "fixture-node-path", SystemRoot: "C:\\Windows", windir: "C:\\Windows",
    APPDATA: "C:\\real-account\\AppData", LOCALAPPDATA: "C:\\real-account\\Local",
  });
  assert.equal(environmentValues(env, "SystemRoot")[0], "C:\\Windows");
  assert.equal(environmentValues(env, "windir")[0], "C:\\Windows");
  below(home, env.APPDATA);
  below(home, env.LOCALAPPDATA);
});

test("isolated install preserves argument boundaries and disables lifecycle scripts and global writes", () => {
  const tgz = join(scratch, "archive with spaces", "hara.tgz");
  const prefix = join(scratch, "install with spaces");
  const args = npmInstallArgs(tgz, prefix, { cache });
  assert.deepEqual(args.slice(0, 2), ["install", tgz]);
  assert.equal(argumentValue(args, "--prefix"), prefix);
  assert.equal(argumentValue(args, "--cache"), cache);
  assert.equal(argumentValue(args, "--registry").replace(/\/$/u, ""), registry);
  for (const flag of ["--ignore-scripts", "--omit=dev", "--include=optional", "--no-save", "--no-package-lock", "--no-audit", "--no-fund"]) {
    assert.ok(args.includes(flag), `${flag} is required for a bounded package install`);
  }
  for (const flag of ["--global", "-g", "--force", "--omit=optional"]) assert.ok(!args.includes(flag), flag);
});

test("offline and cache-preferred install modes are explicit and mutually exclusive", () => {
  const tgz = join(scratch, "hara.tgz");
  const prefix = join(scratch, "install");
  const offline = npmInstallArgs(tgz, prefix, { offline: true, cache });
  const preferred = npmInstallArgs(tgz, prefix, { offline: false, cache });
  assert.ok(offline.includes("--offline"));
  assert.ok(!offline.includes("--prefer-offline"));
  assert.ok(preferred.includes("--prefer-offline"));
  assert.ok(!preferred.includes("--offline"));
});

test("fresh Windows npm installs have a bounded longer budget without changing other platforms", () => {
  assert.equal(npmInstallTimeout("win32"), 360_000);
  for (const platform of ["darwin", "linux", "freebsd"]) assert.equal(npmInstallTimeout(platform), 180_000);
  assert.equal(npmInstallTimeout(), npmInstallTimeout(process.platform));
});

test("package command timeout diagnostics identify the stage and budget without exposing child data", () => {
  const privateText = "PRIVATE_TOKEN=fixture-secret https://private.invalid/signed?token=fixture";
  const failure = packageSmokeCommandFailure({
    error: { code: "ETIMEDOUT", message: privateText }, stderr: privateText, stdout: privateText,
  }, "isolated npm install", 360_000, 360_045.4);
  assert.match(failure, /^isolated npm install failed \(ETIMEDOUT\)/u);
  assert.match(failure, /elapsed 360045ms, timeout 360000ms/u);
  assert.doesNotMatch(failure, /PRIVATE_TOKEN|fixture-secret|private\.invalid/u);
});

test("package command diagnostics preserve exit/signal failures and suppress arbitrary error reasons", () => {
  assert.match(packageSmokeCommandFailure({ status: 1 }, "npm pack", 60_000, 100), /failed \(1\)/u);
  assert.match(packageSmokeCommandFailure({ signal: "SIGTERM" }, "npm pack", 60_000, 100), /failed \(SIGTERM\)/u);
  const failure = packageSmokeCommandFailure({ error: { code: "secret=untrusted-data" } },
    "isolated npm install", 180_000, 100, true);
  assert.match(failure, /failed \(spawn error\)/u);
  assert.match(failure, /offline mode requires a prefilled npm metadata\/tarball cache/u);
  assert.doesNotMatch(failure, /untrusted-data/u);
});

test("npm CLI lookup is bound to the active Node installation, not npm shims or environment overrides", () => {
  const execPath = join(scratch, "node-runtime", "bin", process.platform === "win32" ? "node.exe" : "node");
  const prefix = dirname(dirname(execPath));
  assert.deepEqual(matchingNpmCliCandidates(execPath), [
    join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(prefix, "node_modules", "npm", "bin", "npm-cli.js"),
  ]);
});

function workflowJob(source, name) {
  const heading = new RegExp(`^  ${name}:\\s*\\n`, "mu").exec(source);
  assert.ok(heading, `workflow must define ${name}`);
  const body = source.slice(heading.index + heading[0].length);
  const next = body.search(/^  [A-Za-z0-9_-]+:\s*\n/mu);
  return heading[0] + (next < 0 ? body : body.slice(0, next));
}

function packageSmokeStep(job) {
  const command = "node scripts/npm-package-smoke.mjs";
  const index = job.indexOf(command);
  assert.ok(index >= 0, "the job must execute the actual packed-package smoke");
  assert.equal(job.split(command).length - 1, 1, "each job must have one unambiguous package smoke gate");
  const start = job.lastIndexOf("\n      - ", index);
  assert.ok(start >= 0, "the smoke must be a standalone workflow step");
  const next = job.indexOf("\n      - ", index);
  const step = job.slice(start, next < 0 ? undefined : next);
  assert.match(step, /^        shell: bash\r?$/mu);
  assert.match(step, /^        run: node scripts\/npm-package-smoke\.mjs --cache "\$\(npm config get cache\)"\r?$/mu,
    "run the gate directly, with cache reuse and no shell failure suppression");
  assert.doesNotMatch(step, /^\s*(?:if|continue-on-error):/mu,
    "package verification must not be conditional or allowed to fail");
  assert.doesNotMatch(job, /^    (?:if|continue-on-error):/mu,
    "the parent job must not silently skip or ignore the required package gate");
  return index;
}

test("CI gates real npm package installation on Node, Windows and every native-platform matrix lane", () => {
  const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  const build = workflowJob(ci, "build-test");
  const windows = workflowJob(ci, "windows-runtime");
  const native = workflowJob(ci, "standalone-runtime");
  const sourceTests = build.indexOf("run: npm test");
  const windowsTests = windows.indexOf("Run Windows contract tests");
  const nativeSmoke = native.indexOf("standalone-coding-runtime-smoke.mjs");
  assert.ok(sourceTests >= 0 && packageSmokeStep(build) > sourceTests);
  assert.ok(windowsTests >= 0 && packageSmokeStep(windows) > windowsTests);
  assert.ok(nativeSmoke >= 0 && packageSmokeStep(native) > nativeSmoke);
  for (const platform of ["ubuntu-latest", "ubuntu-24.04-arm", "macos-15", "macos-15-intel"]) {
    assert.match(native, new RegExp(`os: ${platform}(?:\\r?\\n|$)`, "u"), `${platform} must receive the same package gate`);
  }
  assert.match(native, /runs-on: \$\{\{ matrix\.os \}\}/u);
});

test("npm publication requires the reusable native CI and a successful local artifact gate before upload", () => {
  const workflow = readFileSync(new URL("../.github/workflows/publish-npm.yml", import.meta.url), "utf8");
  const verify = workflowJob(workflow, "verify");
  const publish = workflowJob(workflow, "publish");
  assert.match(verify, /uses: \.\/\.github\/workflows\/ci\.yml/u);
  assert.match(publish, /^    needs: verify\r?$/mu);
  assert.doesNotMatch(publish, /^    (?:if|continue-on-error):/mu);
  const smoke = publish.indexOf("node scripts/npm-package-smoke.mjs --cache");
  const retainedCheck = publish.indexOf("node scripts/npm-package-smoke.mjs --verify-retained");
  const tests = publish.indexOf("run: npm test");
  const upload = publish.indexOf('npm publish "$verified_tarball" --ignore-scripts --registry');
  assert.ok(tests >= 0 && smoke > tests, "the packed-package gate follows the full source regression suite");
  assert.ok(retainedCheck > smoke && upload > retainedCheck,
    "npm upload must publish the retained archive only after checking its accepted digest");
  assert.equal(publish.split("npm publish ").length - 1, 1, "there must be no alternate unverified publication path");
  const gateStart = publish.lastIndexOf("\n      - ", smoke);
  const gateEnd = publish.indexOf("\n      - ", smoke);
  assert.ok(gateStart >= 0 && gateEnd > gateStart);
  const gate = publish.slice(gateStart, gateEnd);
  assert.match(gate, /^        shell: bash\r?$/mu);
  assert.match(gate,
    /^        run: node scripts\/npm-package-smoke\.mjs --cache "\$\(npm config get cache\)" --pack-destination "\$RUNNER_TEMP\/hara-verified-package"\r?$/mu);
  assert.doesNotMatch(gate, /^\s*(?:if|continue-on-error):/mu);
  assert.match(publish,
    /^          verified_tarball="\$\(node scripts\/npm-package-smoke\.mjs --verify-retained "\$RUNNER_TEMP\/hara-verified-package"\)"\r?$/mu);
  assert.ok(publish.indexOf("set +e") > retainedCheck,
    "retained artifact verification must fail the step before idempotent npm upload handling begins");
  assert.doesNotMatch(publish, /npm pack(?:\s|$)/u, "publication must not repack after acceptance");
});
