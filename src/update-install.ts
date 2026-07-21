import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { toolSubprocessEnv } from "./security/subprocess-env.js";

export type InstallationKind = "npm" | "standalone" | "desktop" | "source" | "unknown";

export interface InstallationInfo {
  kind: InstallationKind;
  /** The command/entry that started this process, before resolving symlinks. */
  launchPath: string;
  /** The package directory whose package.json is replaced by npm. */
  packageRoot?: string;
  /** Other Hara commands currently visible in PATH, in resolution order. */
  shadowCommands: string[];
}

export interface InstallationProbe {
  execPath: string;
  entryPath?: string;
  packageRoot: string;
  versions: { node?: string; bun?: string };
  buildVersion?: string;
  platform: NodeJS.Platform;
  desktopSibling?: boolean;
  desktopEnv?: boolean;
}

const slash = (path: string): string => path.replace(/\\/g, "/");

function canonical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function isNodeExecutable(path: string): boolean {
  return /(^|[\\/])node(?:\.exe)?$/iu.test(path);
}

function isCompiledBunEntry(probe: InstallationProbe): boolean {
  const virtualEntry = slash(probe.entryPath ?? "").startsWith("/$bunfs/");
  return typeof probe.versions.bun === "string" && (!!probe.buildVersion || virtualEntry);
}

/** Pure installation classifier. It deliberately distinguishes a Desktop-owned sidecar from a user-owned
 * standalone: a sidecar must be inside a macOS app bundle or sit next to the Desktop shell. */
export function classifyInstallation(probe: InstallationProbe): InstallationKind {
  const root = slash(probe.packageRoot).toLowerCase();
  const executable = slash(probe.execPath).toLowerCase();
  const compiled = isCompiledBunEntry(probe);
  const desktop = compiled && (
    executable.includes(".app/contents/macos/hara") ||
    probe.desktopSibling === true ||
    probe.desktopEnv === true
  );
  if (desktop) return "desktop";
  if (compiled) return "standalone";

  const packageMarker = "/node_modules/@nanhara/hara";
  const foreignPackageManager = root.includes("/.pnpm/") || root.includes("/bun/install/");
  if (isNodeExecutable(probe.execPath) && root.includes(packageMarker) && !foreignPackageManager) return "npm";
  if (!root.includes(packageMarker)) return "source";
  return "unknown";
}

function desktopSiblingExists(execPath: string, platform: NodeJS.Platform): boolean {
  const directory = dirname(execPath);
  const executable = canonical(execPath);
  const names = platform === "win32" ? ["hara-desktop.exe", "Hara.exe"] : ["hara-desktop", "Hara"];
  return names.some((name) => {
    const candidate = join(directory, name);
    return existsSync(candidate) && canonical(candidate) !== executable;
  });
}

/** Enumerate commands without executing them. Running every PATH candidate would execute arbitrary local
 * files during `doctor`, so versions are verified only for the installation Hara actually owns. */
export function findPathHaraCommands(
  pathEnv = process.env.PATH ?? "",
  platform: NodeJS.Platform = process.platform,
): string[] {
  const names = platform === "win32" ? ["hara.cmd", "hara.exe", "hara"] : ["hara"];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const directory of pathEnv.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = resolve(directory, name);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      try {
        const stat = lstatSync(candidate);
        if (stat.isFile() || stat.isSymbolicLink()) found.push(candidate);
      } catch {
        // Missing or unreadable PATH entries are unrelated to the diagnostic.
      }
    }
  }
  return found;
}

export function inspectInstallation(
  packageRoot: string,
  options: {
    execPath?: string;
    entryPath?: string;
    versions?: { node?: string; bun?: string };
    buildVersion?: string;
    platform?: NodeJS.Platform;
    pathEnv?: string;
  } = {},
): InstallationInfo {
  const execPath = options.execPath ?? process.execPath;
  const entryPath = options.entryPath ?? process.argv[1];
  const versions = options.versions ?? process.versions;
  const platform = options.platform ?? process.platform;
  const launchPath = isNodeExecutable(execPath) && entryPath ? entryPath : execPath;
  const kind = classifyInstallation({
    execPath,
    entryPath,
    packageRoot,
    versions,
    buildVersion: options.buildVersion ?? process.env.HARA_BUILD_VERSION,
    platform,
    desktopSibling: desktopSiblingExists(execPath, platform),
    desktopEnv: process.env.HARA_DESKTOP_SIDECAR === "1",
  });
  const active = canonical(launchPath);
  const shadowCommands = findPathHaraCommands(options.pathEnv, platform)
    .filter((candidate) => canonical(candidate) !== active);
  return {
    kind,
    launchPath,
    ...(kind === "npm" ? { packageRoot } : {}),
    shadowCommands,
  };
}

export function readInstalledPackageVersion(packageRoot: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : null;
  } catch {
    return null;
  }
}

/** Locate npm from the same Node installation that is running Hara. This avoids the core NVM bug where
 * a bare `npm` updates one prefix while the active `hara` belongs to another. */
export function findMatchingNpmCli(execPath = process.execPath): string | null {
  const prefix = dirname(dirname(execPath));
  const candidates = [
    join(prefix, "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(prefix, "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

export interface NpmUpgradeResult {
  packageRoot: string;
  version: string;
}

export interface NpmUpgradeInvocation {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  prefix: string;
}

export function npmPrefixForPackageRoot(packageRoot: string): string | null {
  const normalized = slash(resolve(packageRoot));
  const scoped = "/node_modules/@nanhara/hara";
  const marker = normalized.toLowerCase().lastIndexOf(scoped);
  if (marker < 0) return null;
  let prefix = normalized.slice(0, marker);
  if (prefix.toLowerCase().endsWith("/lib")) prefix = prefix.slice(0, -4);
  return prefix || "/";
}

export function npmUpgradeInvocation(
  info: InstallationInfo,
  targetVersion: string,
  execPath = process.execPath,
): NpmUpgradeInvocation {
  if (info.kind !== "npm" || !info.packageRoot) throw new Error("the active Hara is not an npm installation");
  if (!/^\d+\.\d+\.\d+$/u.test(targetVersion)) throw new Error(`refusing non-stable update target '${targetVersion}'`);
  const npmCli = findMatchingNpmCli(execPath);
  if (!npmCli) throw new Error(`cannot find npm beside the active Node runtime ${execPath}`);
  const prefix = npmPrefixForPackageRoot(info.packageRoot);
  if (!prefix) throw new Error(`cannot determine the npm prefix that owns ${info.packageRoot}`);
  const env = toolSubprocessEnv(process.env);
  for (const name of Object.keys(env)) {
    if (/^npm_config_/iu.test(name)) delete env[name];
  }
  // Public Hara updates need no npm credential. Ignore user/global npmrc files so an unrelated prefix,
  // lifecycle shell, private token, or registry cannot redirect this fixed update transaction.
  const emptyUserConfig = process.platform === "win32" ? "NUL" : "/dev/null";
  const emptyGlobalConfig = join(dirname(npmCli), ".hara-no-global-npmrc");
  if (existsSync(emptyGlobalConfig)) throw new Error(`refusing unexpected npm config path ${emptyGlobalConfig}`);
  env.NPM_CONFIG_USERCONFIG = emptyUserConfig;
  env.NPM_CONFIG_GLOBALCONFIG = emptyGlobalConfig;
  return {
    command: execPath,
    args: [
      npmCli,
      "install",
      "--global",
      `@nanhara/hara@${targetVersion}`,
      "--prefix",
      prefix,
      "--registry",
      "https://registry.npmjs.org",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    env,
    prefix,
  };
}

export function verifyInstalledPackageVersion(packageRoot: string, targetVersion: string): string {
  const installed = readInstalledPackageVersion(packageRoot);
  if (installed !== targetVersion) {
    throw new Error(`npm completed, but the active package is ${installed ?? "unreadable"} instead of ${targetVersion}`);
  }
  return installed;
}

/** Upgrade exactly the npm package that owns the current process, then verify the on-disk postcondition.
 * No shell is used and the registry/target are fixed. Call only after an explicit `hara update`. */
export function upgradeNpmInstallation(info: InstallationInfo, targetVersion: string): NpmUpgradeResult {
  const invocation = npmUpgradeInvocation(info, targetVersion);
  const run = spawnSync(invocation.command, invocation.args, { stdio: "inherit", env: invocation.env });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`npm exited with status ${run.status ?? "unknown"}`);
  const packageRoot = info.packageRoot!;
  return { packageRoot, version: verifyInstalledPackageVersion(packageRoot, targetVersion) };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function manualUpdateInstruction(info: InstallationInfo): string {
  if (info.kind === "desktop") {
    return "Open Hara Desktop → Settings → App & updates → Check for updates; do not replace its bundled engine with npm.";
  }
  if (info.kind === "standalone") {
    const directory = dirname(info.launchPath);
    return `curl -fsSL https://raw.githubusercontent.com/hara-cli/hara/main/install.sh | HARA_INSTALL=${shellQuote(directory)} sh`;
  }
  if (info.kind === "source") {
    return "This Hara is running from a source checkout; update the checkout, then run npm ci && npm run build.";
  }
  return "This installation is not managed by npm; update it with the package manager that owns the active command.";
}

export function installationLabel(info: InstallationInfo): string {
  const labels: Record<InstallationKind, string> = {
    npm: "npm",
    standalone: "standalone",
    desktop: "Desktop sidecar",
    source: "source checkout",
    unknown: "unknown package manager",
  };
  return labels[info.kind];
}
