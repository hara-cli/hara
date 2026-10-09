// Build-time only. Runtime never downloads an executable or consults npm/project configuration.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

export const CODE_RUNTIME_VERSION = "1.18.32";
const TARGETS = Object.freeze({
  "bun-darwin-arm64": { platform: "darwin", arch: "arm64", packageName: "opencode-darwin-arm64" },
  "bun-darwin-x64-baseline": { platform: "darwin", arch: "x64", packageName: "opencode-darwin-x64-baseline" },
  "bun-linux-arm64": { platform: "linux", arch: "arm64", libc: "glibc", packageName: "opencode-linux-arm64" },
  "bun-linux-arm64-musl": { platform: "linux", arch: "arm64", libc: "musl", packageName: "opencode-linux-arm64-musl" },
  "bun-linux-x64-baseline": { platform: "linux", arch: "x64", libc: "glibc", packageName: "opencode-linux-x64-baseline" },
  "bun-linux-x64-musl-baseline": { platform: "linux", arch: "x64", libc: "musl", packageName: "opencode-linux-x64-baseline-musl" },
  "bun-windows-x64-baseline": { platform: "win32", arch: "x64", packageName: "opencode-windows-x64-baseline" },
});

export function codeRuntimeTarget(target, platform = process.platform, arch = process.arch) {
  let key = target;
  if (!key) {
    const operatingSystem = platform === "win32" ? "windows" : platform;
    let musl = false;
    if (platform === "linux") {
      const report = process.report?.getReport();
      if (report?.header?.glibcVersionRuntime) musl = false;
      else if (report?.sharedObjects?.some(item => /(?:^|\/)ld-musl-[^/]+\.so\.1$/u.test(item))) musl = true;
      else throw new Error("unknown native build libc; pass an explicit reviewed Bun target");
    }
    key = `bun-${operatingSystem}-${arch}${musl ? "-musl" : ""}${arch === "x64" ? "-baseline" : ""}`;
  }
  const selected = Object.hasOwn(TARGETS, key) ? TARGETS[key] : undefined;
  if (!selected) throw new Error("unsupported bundled coding runtime target");
  return { ...selected, version: CODE_RUNTIME_VERSION, bunTarget: key };
}

export function lockedCodeRuntimePackage(lock, packageJson, target) {
  const name = target.packageName;
  if (packageJson.optionalDependencies?.[name] !== CODE_RUNTIME_VERSION) throw new Error("coding runtime package pin mismatch");
  const entry = lock.packages?.[`node_modules/${name}`];
  const expectedURL = `https://registry.npmjs.org/${name}/-/${name}-${CODE_RUNTIME_VERSION}.tgz`;
  if (!entry || entry.version !== CODE_RUNTIME_VERSION || entry.resolved !== expectedURL
    || typeof entry.integrity !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(entry.integrity)
    || JSON.stringify(entry.os) !== JSON.stringify([target.platform])
    || JSON.stringify(entry.cpu) !== JSON.stringify([target.arch])) throw new Error("invalid locked coding runtime package");
  return { url: expectedURL, integrity: entry.integrity };
}

export function bundledCodeRuntimeModule(source, metadata, assetPath) {
  const marker = "export const bundledOpenCodeRuntime = undefined;";
  if (source.split(marker).length !== 2) throw new Error("bundled coding metadata sentinel mismatch");
  return `import haraBundledOpenCodeAsset from ${JSON.stringify(assetPath)} with { type: "file" };\n`
    + source.replace(marker, `export const bundledOpenCodeRuntime = Object.freeze({ ...${JSON.stringify(metadata)}, assetPath: haraBundledOpenCodeAsset });`);
}

async function verifiedArchive(url, integrity) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error("could not download locked coding runtime package");
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 256 * 1024 * 1024) throw new Error("coding runtime archive exceeds the build limit");
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== integrity) throw new Error("coding runtime archive integrity mismatch");
  return bytes;
}

/** Each explicit Bun target receives its own lock-verified native executable, never the build host's. */
export async function prepareBundledCodeRuntime(targetName, root = process.cwd()) {
  const target = codeRuntimeTarget(targetName);
  const pinned = lockedCodeRuntimePackage(JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")),
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")), target);
  const scratch = mkdtempSync(join(tmpdir(), "hara-code-build-"));
  const cleanup = () => rmSync(scratch, { recursive: true, force: true });
  try {
    const archive = join(scratch, "runtime.tgz");
    writeFileSync(archive, await verifiedArchive(pinned.url, pinned.integrity), { mode: 0o600 });
    const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "/usr/bin/tar";
    const tarEnv = process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : { PATH: "/usr/bin:/bin", LANG: "C" };
    const unpack = (member, maxBuffer) => {
      // -O reads only the fixed member into memory. No archive pathname is ever extracted to disk.
      const result = spawnSync(tar, ["-xOzf", archive, member], { env: tarEnv, maxBuffer, timeout: 30_000, windowsHide: true });
      if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) throw new Error("could not read locked coding runtime member");
      return result.stdout;
    };
    const metadata = JSON.parse(unpack("package/package.json", 64 * 1024).toString("utf8"));
    if (metadata.name !== target.packageName || metadata.version !== CODE_RUNTIME_VERSION
      || JSON.stringify(metadata.os) !== JSON.stringify([target.platform]) || JSON.stringify(metadata.cpu) !== JSON.stringify([target.arch])
      || (target.libc === "musl" ? JSON.stringify(metadata.libc) !== JSON.stringify(["musl"]) : metadata.libc !== undefined)
      || metadata.scripts && Object.keys(metadata.scripts).length > 0) throw new Error("coding runtime archive metadata mismatch");
    const bytes = unpack(`package/bin/opencode${target.platform === "win32" ? ".exe" : ""}`, 512 * 1024 * 1024);
    if (bytes.length < 64) throw new Error("coding runtime executable is empty");
    const assetPath = join(scratch, target.platform === "win32" ? "opencode.exe" : "opencode");
    writeFileSync(assetPath, bytes, { mode: 0o700 });
    if (target.platform === "darwin") {
      if (process.platform !== "darwin") throw new Error("Darwin coding runtime must be signed on a native macOS builder");
      for (const args of [["--force", "--sign", "-", "--entitlements", resolve(root, ".github/macos-standalone-entitlements.plist"), assetPath], ["--verify", "--verbose=2", assetPath]]) {
        const result = spawnSync("/usr/bin/codesign", args, { encoding: "utf8", timeout: 30_000 });
        if (result.error || result.status !== 0) throw new Error("bundled coding runtime signature verification failed");
      }
    }
    const payload = readFileSync(assetPath);
    const manifest = { version: CODE_RUNTIME_VERSION, platform: target.platform, arch: target.arch,
      ...(target.libc ? { libc: target.libc } : {}), size: payload.length, sha256: createHash("sha256").update(payload).digest("hex") };
    return { assetPath, manifest, cleanup };
  } catch (error) { cleanup(); throw error; }
}
