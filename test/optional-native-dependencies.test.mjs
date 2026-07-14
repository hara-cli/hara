import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const optionalTypes = readFileSync(new URL("../src/types/optional-native-modules.d.ts", import.meta.url), "utf8");
const zvecStore = readFileSync(new URL("../src/search/zvec-store.ts", import.meta.url), "utf8");

test("zvec remains an optional native accelerator with a compile-time fallback contract", () => {
  assert.equal(packageJson.dependencies?.["@zvec/zvec"], undefined);
  assert.match(packageJson.optionalDependencies?.["@zvec/zvec"] ?? "", /^\^0\.5\./);
  assert.match(optionalTypes, /declare module ["']@zvec\/zvec["']/);
  assert.match(zvecStore, /import\(["']@zvec\/zvec["']\)\.catch\(\(\) => null\)/);
});
