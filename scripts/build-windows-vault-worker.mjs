import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Windows x64 native build required");
const root = path.resolve("dist/native/win32-x64");
fs.mkdirSync(root, { recursive: true });
const args = ["+1.92.0", "--edition=2021", "--target=x86_64-pc-windows-msvc", "-C", "opt-level=2", "-C", "panic=abort", "-C", "strip=symbols", "native/windows-credential-worker/main.rs", "-o", path.join(root, "hara-credential-worker.exe")];
const result = spawnSync("rustc", args, { stdio: "inherit", shell: false });
if (result.error || result.status !== 0) throw new Error("Native vault build failed");
const version = spawnSync("rustc", ["+1.92.0", "--version"], { encoding: "utf8", shell: false });
if (version.status !== 0) throw new Error("Native toolchain unavailable");
const manifest = { protocolVersion: 1, target: "x86_64-pc-windows-msvc", rustc: version.stdout.trim(),
  sourceSha256: createHash("sha256").update(fs.readFileSync("native/windows-credential-worker/main.rs")).digest("hex"),
  sha256: createHash("sha256").update(fs.readFileSync(path.join(root, "hara-credential-worker.exe"))).digest("hex") };
fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest));
