import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const publishing = readFileSync(new URL("../.github/workflows/publish-npm.yml", import.meta.url), "utf8");

function workflowJob(workflow, name) {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${name}:`);
  assert.ok(start >= 0, `workflow must define ${name}`);
  const next = lines.findIndex((line, index) => index > start && /^  [A-Za-z0-9_-]+:\s*$/.test(line));
  return lines.slice(start + 1, next < 0 ? undefined : next).join("\n");
}

function commandStep(job, command) {
  const steps = job.split(/^      - /m).slice(1);
  const matches = steps.filter((step) => step.split("\n").some((line) => line.trim() === `run: ${command}`));
  assert.equal(matches.length, 1, `workflow must run ${command} in one unambiguous step`);
  return matches[0];
}

test("full CI tests and the package smoke cover the exact pinned npm publication toolchain", () => {
  const build = workflowJob(ci, "build-test"), publish = workflowJob(publishing, "publish");
  const nodeVersion = /^          node-version: "(\d+\.\d+\.\d+)"$/m.exec(publish)?.[1];
  const npmVersion = /^        run: npm install --global npm@(\d+\.\d+\.\d+)$/m.exec(publish)?.[1];
  assert.ok(nodeVersion && npmVersion, "publication Node and npm versions must be exact pins");
  assert.match(nodeVersion, /^24\./u, "the publication-class Node 24 lane remains explicit");
  const matrix = /^        node: (\[[^\n]+\])$/m.exec(build)?.[1];
  assert.ok(matrix, "the complete-suite job must declare its Node matrix");
  const nodes = JSON.parse(matrix);
  assert.deepEqual(nodes, ["22.23.1", nodeVersion], "keep the minimum runtime and the exact publication pin");
  assert.match(build, /^    runs-on: ubuntu-latest$/m, "npm bootstrap is scoped to the disposable runner");
  assert.match(build, /^          node-version: \$\{\{ matrix\.node \}\}$/m);
  const bootstrapCommand = `npm install --global npm@${npmVersion}`;
  const bootstrap = commandStep(build, bootstrapCommand);
  assert.ok(bootstrap.split("\n").includes(`        if: \${{ matrix.node == '${nodeVersion}' }}`),
    "only the exact publication Node lane receives its pinned npm");
  assert.doesNotMatch(bootstrap, /^\s*continue-on-error:/m);
  const full = commandStep(build, "npm test");
  const smokeCommand = 'node scripts/npm-package-smoke.mjs --cache "$(npm config get cache)"';
  const smoke = commandStep(build, smokeCommand);
  for (const step of [commandStep(build, "npm ci"), full, smoke]) {
    assert.doesNotMatch(step, /^\s*(?:if|continue-on-error):/m, "install, full suite and artifact gate cannot be optional");
  }
  assert.ok(build.indexOf("node-version: ${{ matrix.node }}") < build.indexOf(`run: ${bootstrapCommand}`));
  assert.ok(build.indexOf(`run: ${bootstrapCommand}`) < build.indexOf("run: npm ci"));
  assert.ok(build.indexOf("run: npm ci") < build.indexOf("run: npm test"));
  assert.ok(build.indexOf("run: npm test") < build.indexOf(`run: ${smokeCommand}`),
    "the actual isolated npm artifact gate follows the full suite on the publication toolchain");
});

test("npm publication waits for the same complete reusable CI on tags and manual dispatch", () => {
  assert.match(ci, /^on:\n  workflow_call:/m);
  assert.match(publishing, /^  workflow_dispatch:/m);
  const verify = workflowJob(publishing, "verify");
  assert.match(verify, /^    uses: \.\/\.github\/workflows\/ci\.yml$/m);
  assert.doesNotMatch(verify, /^    if:|continue-on-error:\s*true/m, "verification cannot be optional");
  const publish = workflowJob(publishing, "publish");
  assert.match(publish, /^    needs: verify$/m, "npm upload must depend on successful reusable CI");
  assert.doesNotMatch(publish, /^    if:/m, "no job status override may bypass a failed dependency");
  for (const job of ["build-test", "legacy-runtime-message", "windows-runtime", "docker-runtime", "standalone-runtime"]) {
    assert.doesNotMatch(workflowJob(ci, job), /^    if:|continue-on-error:\s*true/m, `${job} must remain a required check`);
  }
});

test("Trusted Publishing stays in publish-npm while reusable verification gets no OIDC permission", () => {
  assert.match(publishing, /^permissions:\n  contents: read\n  id-token: write$/m);
  const verify = workflowJob(publishing, "verify");
  assert.match(verify, /^    permissions:\n      contents: read$/m);
  assert.doesNotMatch(verify, /id-token: write|secrets:\s*inherit/);
  const publish = workflowJob(publishing, "publish");
  assert.match(publish, /ACTIONS_ID_TOKEN_REQUEST_URL/);
  assert.match(publish, /refusing token auth in the Trusted Publishing job/);
  assert.match(publish, /npm publish "\$verified_tarball" --ignore-scripts --registry https:\/\/registry\.npmjs\.org\//);
  assert.doesNotMatch(ci, /npm publish|id-token:\s*write/);
});

test("Windows verification exercises package isolation and native worktree path contracts", () => {
  const windows = workflowJob(ci, "windows-runtime");
  assert.match(windows, /node --test[^\n]*test\/npm-package-smoke\.test\.mjs/);
  assert.match(windows, /node --test[^\n]*test\/agent-worktree-registration\.test\.mjs/);
  assert.match(windows, /node scripts\/npm-package-smoke\.mjs/);
  assert.match(windows, /node scripts\/standalone-pi-runtime-smoke\.mjs dist\/bin\/hara\.exe/);
  assert.doesNotMatch(windows, /continue-on-error:\s*true/);
});
