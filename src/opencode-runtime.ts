import { accessSync, constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledOpenCodeRuntime, materializeBundledOpenCodeRuntime, validOpenCodeNativeHeader,
  type BundledOpenCodeRuntimeMetadata } from "./coding/bundled-opencode.js";

export const HARA_CODE_RUNTIME_VERSION = "1.18.32";

/** Direct optional dependencies: no upstream postinstall, CPU probe, or network fallback. */
const runtimePackages = [
  { name: "opencode-darwin-arm64", platform: "darwin", arch: "arm64" },
  { name: "opencode-darwin-x64-baseline", platform: "darwin", arch: "x64" },
  { name: "opencode-linux-arm64", platform: "linux", arch: "arm64", libc: "glibc" },
  { name: "opencode-linux-arm64-musl", platform: "linux", arch: "arm64", libc: "musl" },
  { name: "opencode-linux-x64-baseline", platform: "linux", arch: "x64", libc: "glibc" },
  { name: "opencode-linux-x64-baseline-musl", platform: "linux", arch: "x64", libc: "musl" },
  { name: "opencode-windows-arm64", platform: "win32", arch: "arm64" },
  { name: "opencode-windows-x64-baseline", platform: "win32", arch: "x64" },
] as const;
export const HARA_CODE_RUNTIME_PACKAGES = Object.freeze(runtimePackages.map((item) => Object.freeze(item)));

type RuntimeLibc = "glibc" | "musl" | "unknown";
export type HaraCodeRuntimeUnavailableReason = "unsupported_platform" | "unsupported_architecture" |
  "unknown_libc" | "package_missing" | "invalid_package" | "invalid_executable" | "invalid_sidecar" | "invalid_bundled_runtime";
export type HaraCodeRuntimeResolution = {
  available: true;
  command: string;
  source: "desktop-sidecar" | "embedded-runtime" | "installed-package";
  version: typeof HARA_CODE_RUNTIME_VERSION;
  packageName?: string;
} | {
  available: false;
  reason: HaraCodeRuntimeUnavailableReason;
  message: string;
};

export const HARA_CODE_RUNTIME_UNAVAILABLE_MESSAGE =
  "Hara's bundled coding runtime is unavailable. Reinstall the official Hara distribution; npm installs require optional dependencies enabled.";

/** Programmatic test/platform seam only; these values must never come from project configuration. */
export interface HaraCodeRuntimeResolveOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  libc?: RuntimeLibc;
  moduleURL?: string | URL;
  /** Trusted test seam, never loaded from environment or project configuration. */
  bundledRuntime?: BundledOpenCodeRuntimeMetadata;
  home?: string;
  readBundledAsset?(path: string): Uint8Array;
}

export class HaraCodeRuntimeUnavailableError extends Error {
  readonly code = "hara_code_runtime_unavailable";
  constructor(readonly reason: HaraCodeRuntimeUnavailableReason) {
    super(HARA_CODE_RUNTIME_UNAVAILABLE_MESSAGE);
    this.name = "HaraCodeRuntimeUnavailableError";
  }
}

function unavailable(reason: HaraCodeRuntimeUnavailableReason): HaraCodeRuntimeResolution {
  return { available: false, reason, message: HARA_CODE_RUNTIME_UNAVAILABLE_MESSAGE };
}

function runtimeLibc(): RuntimeLibc {
  try {
    // No ldd/shell, inherited environment, or download. Unknown libc fails closed.
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: unknown }; sharedObjects?: unknown };
    if (typeof report.header?.glibcVersionRuntime === "string" && report.header.glibcVersionRuntime) return "glibc";
    if (Array.isArray(report.sharedObjects) && report.sharedObjects.some((item: unknown) =>
      typeof item === "string" && /(?:^|\/)ld-musl-[^/]+\.so\.1$/u.test(item))) return "musl";
    // Node's report on musl can omit the loader from sharedObjects, unlike glibc reports.
    if (report.header && typeof report.header === "object" && !report.header.glibcVersionRuntime) return "musl";
  } catch { /* an unavailable report does not authorize a guessed executable */ }
  return "unknown";
}

function within(base: string, target: string): boolean {
  const path = relative(base, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Restrict Node's metadata lookup to Hara's installation, not NODE_PATH, cwd, or global search paths. */
function trustedDependencyRoots(moduleURL: string | URL): string[] {
  const roots = new Set<string>();
  let current = dirname(fileURLToPath(moduleURL));
  for (;;) {
    try {
      const metadata = lstatSync(join(current, "package.json"));
      if (metadata.isFile()) {
        try { roots.add(realpathSync(join(current, "node_modules"))); } catch { /* optional dependencies missing */ }
        break;
      }
    } catch { /* continue to the containing package */ }
    const parent = dirname(current);
    if (parent === current) return [];
    current = parent;
  }
  // npm scoped installs and pnpm's content-addressed dependencies share an enclosing node_modules.
  for (let ancestor = dirname(current); ancestor !== dirname(ancestor); ancestor = dirname(ancestor)) {
    if (basename(ancestor) === "node_modules") {
      try { roots.add(realpathSync(ancestor)); } catch { /* absent installation root */ }
    }
  }
  return [...roots];
}

function executable(path: string, platform: NodeJS.Platform, arch: string): string | undefined {
  let fd: number | undefined;
  try {
    if (!isAbsolute(path)) return undefined;
    const before = lstatSync(path);
    if (!before.isFile() || before.size < 64 || before.size > 1024 * 1024 * 1024 ||
      (platform !== "win32" && (before.mode & 0o111) === 0)) return undefined;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return undefined;
    const header = Buffer.alloc(Math.min(opened.size, 4096));
    if (readSync(fd, header, 0, header.length, 0) !== header.length || !validOpenCodeNativeHeader(header, platform, arch)) return undefined;
    return realpathSync(path);
  } catch { return undefined; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/**
 * Desktop's trusted launcher supplies its independently checksum-verified sidecar. npm CLI installs
 * resolve only fixed exact-version native optional packages. Never execute package JS, postinstall,
 * a PATH command, or --version while resolving; installed authenticity comes from npm lock integrity.
 */
export function resolveHaraCodeRuntime(
  env: NodeJS.ProcessEnv = process.env,
  options: HaraCodeRuntimeResolveOptions = {},
): HaraCodeRuntimeResolution {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (!["darwin", "linux", "win32"].includes(platform)) return unavailable("unsupported_platform");
  if (arch !== "arm64" && arch !== "x64") return unavailable("unsupported_architecture");
  const sidecar = env.HARA_CODE_RUNTIME_PATH?.trim();
  if (sidecar) {
    const command = executable(sidecar, platform, arch);
    return command ? { available: true, command, source: "desktop-sidecar", version: HARA_CODE_RUNTIME_VERSION }
      : unavailable("invalid_sidecar");
  }
  const libc = platform === "linux" ? options.libc ?? runtimeLibc() : undefined;
  if (libc === "unknown") return unavailable("unknown_libc");
  const embedded = Object.hasOwn(options, "bundledRuntime") ? options.bundledRuntime : bundledOpenCodeRuntime;
  if (embedded !== undefined) {
    try {
      const command = materializeBundledOpenCodeRuntime(embedded, { home: options.home, platform, arch, libc,
        readAsset: options.readBundledAsset });
      return { available: true, command, source: "embedded-runtime", version: HARA_CODE_RUNTIME_VERSION };
    } catch { return unavailable("invalid_bundled_runtime"); }
  }
  const selected = HARA_CODE_RUNTIME_PACKAGES.find((item) => item.platform === platform && item.arch === arch &&
    (!("libc" in item) || item.libc === libc));
  if (!selected) return unavailable("unsupported_platform");
  const moduleURL = options.moduleURL ?? import.meta.url;
  let metadataPath: string;
  try {
    // Dynamic metadata-only lookup is intentional: Bun must not inline native optional packages.
    const requireFromHara = createRequire(moduleURL);
    metadataPath = requireFromHara.resolve([selected.name, "package.json"].join("/"));
  } catch { return unavailable("package_missing"); }
  try {
    metadataPath = realpathSync(metadataPath);
    const packageRoot = dirname(metadataPath);
    if (basename(metadataPath) !== "package.json" || basename(packageRoot) !== selected.name ||
      !trustedDependencyRoots(moduleURL).some((root) => within(root, metadataPath))) return unavailable("invalid_package");
    const stat = lstatSync(metadataPath);
    if (!stat.isFile() || stat.size > 64 * 1024) return unavailable("invalid_package");
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as Record<string, unknown>;
    const exact = (value: unknown, expected: string): boolean => Array.isArray(value) && value.length === 1 && value[0] === expected;
    if (metadata.name !== selected.name || metadata.version !== HARA_CODE_RUNTIME_VERSION ||
      !exact(metadata.os, platform) || !exact(metadata.cpu, arch) ||
      ("libc" in selected && selected.libc === "musl" ? !exact(metadata.libc, "musl") : metadata.libc !== undefined) ||
      (metadata.scripts !== undefined && (typeof metadata.scripts !== "object" || metadata.scripts === null ||
        Object.keys(metadata.scripts).length > 0))) return unavailable("invalid_package");
    const bin = join(packageRoot, "bin", platform === "win32" ? "opencode.exe" : "opencode");
    const command = executable(bin, platform, arch);
    if (!command || !within(packageRoot, command) || relative(packageRoot, command) !== relative(packageRoot, bin)) {
      return unavailable("invalid_executable");
    }
    return { available: true, command, source: "installed-package", packageName: selected.name, version: HARA_CODE_RUNTIME_VERSION };
  } catch { return unavailable("invalid_package"); }
}

/** Existing string API, now fail-closed; discovery should use resolveHaraCodeRuntime instead. */
export function haraCodeRuntimeCommand(env: NodeJS.ProcessEnv = process.env): string {
  const result = resolveHaraCodeRuntime(env);
  if (!result.available) throw new HaraCodeRuntimeUnavailableError(result.reason);
  return result.command;
}
