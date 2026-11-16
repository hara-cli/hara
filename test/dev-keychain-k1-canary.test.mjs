// Compile two synthetic programs with the selected Bun; never execute/sign/publish them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { inspectFormalSidecar } from "../native/dev-keychain-fixture/guards.mjs";
import { FixtureError } from "../native/dev-keychain-fixture/protocol.mjs";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
test("selected Bun's actual clean/Dev canaries qualify the artifact scanner", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hara-k1-canary-"));
  t.after(() => fs.rmSync(root, { recursive: true }));
  for (const contaminated of [false, true]) {
    const entry = path.join(root, "canary.js"), output = path.join(root, "hara-sidecar" + (process.platform === "win32" ? ".exe" : ""));
    // Reachable code prevents a bundler from dropping the marker as dead data.
    fs.writeFileSync(entry, `console.log(${JSON.stringify(contaminated ? "HARA_DEV_CREDENTIAL_VAULT_ONLY_V1:credentials.dev.v1" : "hara-clean-canary")});\n`);
    const compiled = spawnSync("bun", ["build", "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--no-compile-autoload-tsconfig", "--no-compile-autoload-package-json", entry, "--outfile", output],
      { cwd: root, env: process.env, encoding: "utf8", timeout: 30000, maxBuffer: 100000 });
    assert.equal(compiled.error, undefined, "Bun canary could not compile");
    assert.equal(compiled.status, 0, "Bun canary compile failed: " + (compiled.stderr || ""));
    const digest = sha(fs.readFileSync(output));
    if (contaminated) assert.throws(() => inspectFormalSidecar(output, digest), FixtureError);
    else assert.equal(inspectFormalSidecar(output, digest).sha256, digest);
    fs.unlinkSync(output);
  }
});
