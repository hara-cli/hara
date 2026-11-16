// Compiled with the real build-binary pipeline. This is not a production CLI command.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { WindowsDpapiCredentialVault } from "../dist/workspace/windows-credential-vault.js";
if (process.env.GITHUB_ACTIONS !== "true" || process.env.HARA_WINDOWS_VAULT_CANARY !== "1" || process.platform !== "win32") throw new Error("Ephemeral Windows canary only");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "hara-bun-vault-canary-"));
const canonical = fs.realpathSync.native(home).replaceAll("/", "\\");
const namespace = createHash("sha256").update("hara-host-home-v1\0").update(canonical).digest("hex");
const root = path.join(process.env.LOCALAPPDATA, "Hara", "credential-vault", "v1", namespace);
const vault = new WindowsDpapiCredentialVault(home);
const values = [{ ref: "bun:one", key: "canary-" + randomBytes(16).toString("hex") }, { ref: "bun:unicode", key: "🐧".repeat(8192) }, { ref: "bun:surrogates", key: "\ud800a\udfff" }];
try {
  vault.probe(); vault.setMany(values);
  for (const entry of values) if (vault.get(entry.ref) !== entry.key) throw new Error("Compiled Bun exact roundtrip failed");
  console.log(JSON.stringify({ schemaVersion: 1, runtime: "compiled-bun", bun: Bun.version, platform: process.platform, arch: process.arch, cases: 4, passed: true }));
} finally {
  for (const entry of values) vault.remove(entry.ref);
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true });
}
