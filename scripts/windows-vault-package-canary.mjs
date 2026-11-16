import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
if (process.env.GITHUB_ACTIONS !== "true" || process.platform !== "win32") throw new Error("Ephemeral Windows CI only");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "hara-vault-npm-canary-"));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { shell: false, timeout: 180_000, ...options });
  if (result.error || result.status !== 0) throw new Error("Packed vault canary command failed");
  return result;
}
try {
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const packed = run(process.execPath, [npmCli, "pack", "--ignore-scripts", "--json", "--pack-destination", temp], { encoding: "utf8" });
  const info = JSON.parse(packed.stdout)[0];
  for (const suffix of ["dist/native/win32-x64/hara-credential-worker.exe", "dist/native/win32-x64/manifest.json", "dist/workspace/windows-credential-vault.js"]) {
    if (!info.files.some(file => file.path === suffix)) throw new Error("Required worker absent from npm package");
  }
  run("tar.exe", ["-xf", path.join(temp, info.filename), "-C", temp]);
  const env = { ...process.env, HARA_VAULT_CANARY_MODULE: pathToFileURL(path.join(temp, "package/dist/workspace/windows-credential-vault.js")).href };
  run(process.execPath, ["--test", "--test-concurrency=1", "test/windows-credential-vault.test.mjs"], { env, stdio: "inherit" });
  console.log(JSON.stringify({ schemaVersion: 1, runtime: "node-packed-npm", workerIncluded: true, passed: true }));
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
