import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

test("TypeScript sources contain no NUL bytes", () => {
  for (const path of sourceFiles(fileURLToPath(new URL("../src/", import.meta.url)))) {
    assert.equal(readFileSync(path).includes(0), false, `${path} contains a NUL byte`);
  }
});
