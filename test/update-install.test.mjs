import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyInstallation,
  findMatchingNpmCli,
  inspectInstallation,
  manualUpdateInstruction,
  npmPrefixForPackageRoot,
  npmUpgradeInvocation,
  verifyInstalledPackageVersion,
} from "../dist/update-install.js";

test("installation classifier distinguishes npm, standalone, Desktop sidecar, and source", () => {
  const base = {
    entryPath: "/prefix/bin/hara",
    versions: { node: "22.22.3" },
    buildVersion: undefined,
    platform: "darwin",
    desktopSibling: false,
  };
  assert.equal(classifyInstallation({
    ...base,
    execPath: "/prefix/bin/node",
    packageRoot: "/prefix/lib/node_modules/@nanhara/hara",
  }), "npm");
  assert.equal(classifyInstallation({
    ...base,
    execPath: "/Users/me/.local/bin/hara",
    entryPath: "/$bunfs/root/hara/dist/index.js",
    packageRoot: "/$bunfs/root/hara",
    versions: { bun: "1.3.9" },
    buildVersion: "0.130.3",
  }), "standalone");
  assert.equal(classifyInstallation({
    ...base,
    execPath: "/Applications/Hara.app/Contents/MacOS/hara",
    entryPath: "/$bunfs/root/hara/dist/index.js",
    packageRoot: "/$bunfs/root/hara",
    versions: { bun: "1.3.9" },
    buildVersion: "0.130.3",
  }), "desktop");
  assert.equal(classifyInstallation({
    ...base,
    execPath: "/prefix/bin/node",
    entryPath: "/work/hara/dist/index.js",
    packageRoot: "/work/hara",
  }), "source");
});

test("installation inspection reports PATH shadows without executing them", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "hara-install-source-"));
  const activeBin = join(root, "active-bin");
  const shadowBin = join(root, "shadow-bin");
  const packageRoot = join(root, "prefix", "lib", "node_modules", "@nanhara", "hara");
  const bootstrap = join(packageRoot, "runtime-bootstrap.cjs");
  mkdirSync(activeBin, { recursive: true });
  mkdirSync(shadowBin, { recursive: true });
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(bootstrap, "#!/usr/bin/env node\n");
  writeFileSync(join(shadowBin, "hara"), "this file must never be executed\n");
  symlinkSync(bootstrap, join(activeBin, "hara"));
  try {
    const info = inspectInstallation(packageRoot, {
      execPath: join(root, "prefix", "bin", "node"),
      entryPath: join(activeBin, "hara"),
      versions: { node: "22.22.3" },
      platform: process.platform,
      pathEnv: [activeBin, shadowBin].join(":"),
    });
    assert.equal(info.kind, "npm");
    assert.deepEqual(info.shadowCommands, [join(shadowBin, "hara")]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("macOS standalone is not its own case-insensitive Desktop sibling", { skip: process.platform !== "darwin" }, () => {
  const root = mkdtempSync(join(tmpdir(), "hara-install-standalone-"));
  const executable = join(root, "hara");
  writeFileSync(executable, "standalone fixture\n");
  try {
    const info = inspectInstallation(root, {
      execPath: executable,
      entryPath: "/$bunfs/root/hara/dist/index.js",
      versions: { bun: "1.3.9" },
      buildVersion: "0.131.0",
      platform: "darwin",
      pathEnv: "",
    });
    assert.equal(info.kind, "standalone");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("matching npm is resolved beside the active Node, never through ambient PATH", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-node-prefix-"));
  const node = join(root, "bin", "node");
  const npmCli = join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(join(root, "lib", "node_modules", "npm", "bin"), { recursive: true });
  writeFileSync(node, "");
  writeFileSync(npmCli, "");
  try {
    assert.equal(findMatchingNpmCli(node), npmCli);
    const packageRoot = join(root, "lib", "node_modules", "@nanhara", "hara");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ version: "0.130.3" }));
    assert.equal(npmPrefixForPackageRoot(packageRoot), root);
    const invocation = npmUpgradeInvocation({
      kind: "npm",
      launchPath: join(root, "bin", "hara"),
      packageRoot,
      shadowCommands: [],
    }, "0.130.3", node);
    assert.equal(invocation.command, node);
    assert.deepEqual(invocation.args.slice(0, 5), [npmCli, "install", "--global", "@nanhara/hara@0.130.3", "--prefix"]);
    assert.equal(invocation.args[5], root);
    assert.ok(invocation.args.includes("--ignore-scripts"));
    assert.equal(invocation.env.NPM_CONFIG_USERCONFIG, process.platform === "win32" ? "NUL" : "/dev/null");
    assert.equal(invocation.env.NPM_CONFIG_GLOBALCONFIG, join(root, "lib", "node_modules", "npm", "bin", ".hara-no-global-npmrc"));
    assert.equal(verifyInstalledPackageVersion(packageRoot, "0.130.3"), "0.130.3");
    assert.throws(() => verifyInstalledPackageVersion(packageRoot, "0.130.4"), /active package is 0\.130\.3/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-npm update guidance preserves the active standalone directory", () => {
  const instruction = manualUpdateInstruction({
    kind: "standalone",
    launchPath: "/opt/Hara Tools/hara",
    shadowCommands: [],
  });
  assert.match(instruction, /HARA_INSTALL='\/opt\/Hara Tools'/);
  assert.match(instruction, /install\.sh/);
});

test("standalone installer stages, smoke-checks, and atomically replaces instead of truncating", () => {
  const script = readFileSync(new URL("../install.sh", import.meta.url), "utf8");
  assert.match(script, /mktemp "\$dest\/\.hara-download\.XXXXXX"/);
  assert.doesNotMatch(script, /curl[^\n]+-o "\$dest\/hara"/);
  const download = script.indexOf('curl -fsSL "$url" -o "$tmp"');
  const smoke = script.indexOf('downloaded_version=$("$tmp" --version');
  const replace = script.indexOf('mv -f "$tmp" "$dest/hara"');
  assert.ok(download >= 0 && smoke > download && replace > smoke);
});
