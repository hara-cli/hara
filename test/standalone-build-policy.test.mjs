import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const build = readFileSync(new URL("../scripts/build-binary.ts", import.meta.url), "utf8");
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const boundarySmoke = readFileSync(new URL("../scripts/standalone-boundary-smoke.mjs", import.meta.url), "utf8");
const serveSmoke = readFileSync(new URL("../scripts/standalone-serve-smoke.mjs", import.meta.url), "utf8");
const codingSmoke = readFileSync(new URL("../scripts/standalone-coding-runtime-smoke.mjs", import.meta.url), "utf8");
const piSmoke = readFileSync(new URL("../scripts/standalone-pi-runtime-smoke.mjs", import.meta.url), "utf8");

function workflowJob(workflow, name) {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `workflow must define ${name}`);
  const next = lines.findIndex((line, index) => index > start && /^  [A-Za-z0-9_-]+:\s*$/.test(line));
  return lines.slice(start + 1, next < 0 ? undefined : next).join("\n");
}

test("standalone compile disables every ambient project config loader", () => {
  for (const loader of ["autoloadBunfig", "autoloadDotenv", "autoloadPackageJson", "autoloadTsconfig"]) {
    assert.match(build, new RegExp(`${loader}:\\s*false`), `${loader} must stay explicitly disabled`);
  }
});

test("native and public standalone gates execute the embedded coding runtime without model credentials", () => {
  assert.ok((ci.match(/standalone-coding-runtime-smoke\.mjs/g) ?? []).length >= 2);
  assert.ok((release.match(/standalone-coding-runtime-smoke\.mjs/g) ?? []).length >= 3);
  assert.match(codingSmoke, /\["coding", "sessions", "--provider", "opencode"\]/);
  assert.match(codingSmoke, /createHash\("sha256"\)/);
  assert.match(codingSmoke, /0o500/);
  assert.match(codingSmoke, /before\.ino !== after\.ino/);
  assert.doesNotMatch(codingSmoke, /\.\.\.process\.env/);
});

test("native and public assets run the real compiled Pi SDK through isolated loopback Serve", () => {
  assert.equal((ci.match(/standalone-pi-runtime-smoke\.mjs/g) ?? []).length, 2);
  assert.equal((release.match(/standalone-pi-runtime-smoke\.mjs/g) ?? []).length, 3);
  assert.match(piSmoke, /server\.listen\(0, "127\.0\.0\.1"/);
  assert.match(piSmoke, /"profile", "add", "native-smoke"/);
  assert.match(piSmoke, /"profile", "use", "native-smoke"/);
  assert.match(piSmoke, /"hara_read_file"/);
  assert.match(piSmoke, /name = "followup_task"/);
  assert.match(piSmoke, /worker\.generation, 2/);
  assert.match(piSmoke, /budget\.providerRounds, 3/);
  assert.match(piSmoke, /budget\.inputTokens, 21/);
  assert.match(piSmoke, /budget\.outputTokens, 9/);
  assert.doesNotMatch(piSmoke, /\.\.\.process\.env/);
  assert.doesNotMatch(piSmoke, /from\s+["'](?:ws|@earendil-works\/pi-coding-agent)["']/);
  assert.doesNotMatch(piSmoke, /https:\/\//);
});

test("standalone releases use baseline x64 targets and runtime boundary smoke", () => {
  assert.match(packageJson.scripts["build:binaries"], /bun-darwin-x64-baseline/);
  assert.match(packageJson.scripts["build:binaries"], /bun-linux-x64-baseline/);
  assert.match(build, /bun-\(\?:darwin\|linux\|windows\)-x64/);
  for (const target of ["bun-linux-x64-baseline", "bun-linux-arm64", "bun-darwin-arm64", "bun-darwin-x64-baseline"]) {
    assert.match(ci, new RegExp(target), `native standalone CI must exercise ${target}`);
  }
  assert.match(ci, /standalone-boundary-smoke\.mjs/);
  assert.match(release, /standalone-boundary-smoke\.mjs/);
  assert.match(boundarySmoke, /\["cron", "run", jobId\]/, "native standalone smoke must exercise self-reentry");
  assert.match(boundarySmoke, /too many arguments/, "native standalone smoke must reject virtual-entry regressions");
  assert.match(serveSmoke, /"session\.list"/, "native serve smoke must exercise session index initialization");
  for (const capability of [
    "desk.connections.list",
    "desk.snapshot",
    "desk.task.get",
    "presentation.create",
    "presentation.update",
    "presentation.validate",
    "presentation.render",
    "presentation.preview",
    "presentation.export",
    "collaboration.remote.v1",
  ]) {
    assert.match(
      serveSmoke,
      new RegExp(capability.replaceAll(".", "\\.")),
      `native serve smoke must require ${capability}`,
    );
  }
  assert.match(serveSmoke, /"pptx"/, "native serve smoke must execute editable Presentation export");
  assert.match(serveSmoke, /template-editable/, "native serve smoke verifies the PPTX fidelity contract");
  assert.doesNotMatch(
    serveSmoke,
    /from\s+["']ws["']/,
    "public-asset verification must not require dependencies that its job does not install",
  );
  assert.ok(
    (ci.match(/standalone-serve-smoke\.mjs/g) ?? []).length >= 2,
    "Windows and the four-platform standalone matrix must run the native session smoke",
  );
  assert.ok(
    (release.match(/standalone-serve-smoke\.mjs/g) ?? []).length >= 3,
    "Linux, Darwin, and public Darwin release assets must run the native session smoke",
  );
});

test("Darwin release assets are native-built, signed, immutable, and publicly re-executed", () => {
  assert.match(release, /runs-on: \$\{\{ matrix\.os \}\}/);
  assert.match(release, /macos-15-intel/);
  assert.match(release, /codesign --force --sign - --entitlements \.github\/macos-standalone-entitlements\.plist/);
  assert.match(release, /codesign --verify --verbose=4/);
  assert.match(release, /needs: \[linux-binaries, darwin-binaries\]/);
  assert.match(release, /immutable release asset mismatch/);
  assert.match(release, /gh release download/);
  assert.match(release, /public asset digest mismatch/);
  assert.doesNotMatch(release, /gh release upload[^\n]*--clobber/);
});

test("each Linux release asset must pass smoke on its own native runner before assembly", () => {
  const linux = workflowJob(release, "linux-binaries");
  const targets = [...linux.matchAll(/^          - os: ([^\r\n]+)\r?\n            target: ([^\r\n]+)\r?\n            asset: ([^\r\n]+)/gm)]
    .map(([, os, target, asset]) => ({ os, target, asset }));
  assert.deepEqual(targets, [
    { os: "ubuntu-latest", target: "bun-linux-x64-baseline", asset: "hara-linux-x64" },
    { os: "ubuntu-24.04-arm", target: "bun-linux-arm64", asset: "hara-linux-arm64" },
  ], "the ARM64 asset must not be built only by an x64 runner");
  assert.match(linux, /^    runs-on: \$\{\{ matrix\.os \}\}$/m);
  assert.match(linux, /bun scripts\/build-binary\.ts "dist\/bin\/\$\{\{ matrix\.asset \}\}" "\$\{\{ matrix\.target \}\}"/);
  assert.match(linux, /asset="dist\/bin\/\$\{\{ matrix\.asset \}\}"/);
  for (const smoke of ["boundary", "serve", "coding-runtime"]) {
    const command = `node scripts/standalone-${smoke}-smoke.mjs "$asset" "$expected"`;
    assert.ok(linux.includes(command), `${smoke} smoke must execute each native matrix asset`);
    assert.ok(linux.indexOf(command) < linux.indexOf("actions/upload-artifact@"), "failed smoke must prevent upload");
  }
  assert.match(linux, /name: \$\{\{ matrix\.asset \}\}/);
  assert.match(linux, /path: dist\/bin\/\$\{\{ matrix\.asset \}\}/);
  assert.doesNotMatch(linux, /dist\/bin\/hara-linux-(?:x64|arm64)/, "execution and upload must not be hard-coded to one architecture");
  assert.doesNotMatch(linux, /continue-on-error:\s*true/);
  assert.match(workflowJob(release, "publish-release"), /^    needs: \[linux-binaries, darwin-binaries\]$/m);
});
