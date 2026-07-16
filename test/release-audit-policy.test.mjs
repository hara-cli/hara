import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const auditScript = readFileSync(new URL("../.github/scripts/audit-production.sh", import.meta.url), "utf8");
const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const publishNpm = readFileSync(new URL("../.github/workflows/publish-npm.yml", import.meta.url), "utf8");

test("release workflows use the bounded production dependency audit", () => {
  for (const [name, workflow] of [["release", release], ["publish-npm", publishNpm]]) {
    assert.match(
      workflow,
      /name: Audit production dependencies\n\s+run: bash \.github\/scripts\/audit-production\.sh/,
      `${name} must use the shared production audit gate`,
    );
  }
});

test("production audit retries transient endpoint failures without waiving the gate", () => {
  assert.match(auditScript, /max_attempts=3/);
  assert.match(auditScript, /npm audit --omit=dev --registry https:\/\/registry\.npmjs\.org\//);
  assert.match(auditScript, /exit "\$status"/);
  assert.doesNotMatch(auditScript, /\|\|\s*true/);
});
