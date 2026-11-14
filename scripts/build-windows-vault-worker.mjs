import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Windows x64 native build required");
const root = path.resolve("dist/native/win32-x64");
fs.mkdirSync(root, { recursive: true });
const args = ["+1.92.0", "--edition=2021", "--target=x86_64-pc-windows-msvc", "-C", "opt-level=2", "-C", "target-feature=+crt-static", "-C", "panic=abort", "-C", "strip=symbols", "native/windows-credential-worker/main.rs", "-o", path.join(root, "hara-credential-worker.exe")];
const result = spawnSync("rustc", args, { stdio: "inherit", shell: false });
if (result.error || result.status !== 0) throw new Error("Native vault build failed");
const version = spawnSync("rustc", ["+1.92.0", "--version"], { encoding: "utf8", shell: false });
if (version.status !== 0) throw new Error("Native toolchain unavailable");
// The shipped worker must not acquire a separate Visual C++ Redistributable prerequisite.
const vswhere = path.join(process.env["ProgramFiles(x86)"] || "C:/Program Files (x86)", "Microsoft Visual Studio/Installer/vswhere.exe");
const vs = spawnSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8", shell: false });
if (vs.status !== 0 || !vs.stdout.trim()) throw new Error("Native import inspector unavailable");
const toolRoot = path.join(vs.stdout.trim(), "VC/Tools/MSVC");
const toolVersion = fs.readdirSync(toolRoot).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort((a,b) => a.localeCompare(b, "en", { numeric: true })).at(-1);
if (!toolVersion) throw new Error("Native import inspector unavailable");
const imports = spawnSync(path.join(toolRoot, toolVersion, "bin/Hostx64/x64/dumpbin.exe"), ["/DEPENDENTS", path.join(root, "hara-credential-worker.exe")], { encoding: "utf8", shell: false });
const dlls = [...new Set([...String(imports.stdout).matchAll(/^\s+([a-zA-Z0-9_.-]+\.dll)\s*$/gmi)].map(v => v[1].toLowerCase()))].sort();
if (imports.status !== 0 || !dlls.length || dlls.some(v => /vcruntime|msvcp|concrt/i.test(v))) throw new Error("Worker requires unexpected C++ runtime installation");
const manifest = { buildFlags: ["opt-level=2", "target-feature=+crt-static", "panic=abort", "strip=symbols"], imports: dlls, protocolVersion: 1, target: "x86_64-pc-windows-msvc", rustc: version.stdout.trim(),
  sourceSha256: createHash("sha256").update(fs.readFileSync("native/windows-credential-worker/main.rs")).digest("hex"),
  sha256: createHash("sha256").update(fs.readFileSync(path.join(root, "hara-credential-worker.exe"))).digest("hex") };
fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(JSON.stringify(manifest));
