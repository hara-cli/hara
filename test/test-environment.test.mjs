import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

test("isolated fixture preload canonicalizes TEMP aliases as well as HOME without following user state", t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-preload-alias-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const actual = join(root, "actual"), alias = join(root, "alias"); fs.mkdirSync(actual);
  fs.symlinkSync(actual, alias, process.platform === "win32" ? "junction" : "dir");
  const script = `import assert from "node:assert/strict";import fs from "node:fs";import os from "node:os";import path from "node:path";
    assert.equal(os.tmpdir(),fs.realpathSync.native(process.argv[1]));
    assert.equal(os.homedir(),fs.realpathSync.native(os.homedir()));
    assert.equal(path.dirname(os.homedir()),os.tmpdir());console.log("canonical-fixtures-only");`;
  const output = execFileSync(process.execPath, ["--import", fileURLToPath(new URL("./setup-isolated-home.mjs", import.meta.url)), "--input-type=module", "-e", script, actual],
    { encoding: "utf8", env: { ...process.env, TMPDIR: alias, TMP: alias, TEMP: alias } });
  assert.equal(output.trim(), "canonical-fixtures-only");
  assert.deepEqual(fs.readdirSync(actual), [], "the child removes only its generated private HOME");
});
