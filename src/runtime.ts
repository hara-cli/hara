import { homedir } from "node:os";

export const MIN_NODE_MAJOR = 22;
// Commander 15 (a direct runtime dependency) requires this exact floor. Keep package engines, startup,
// doctor, and docs aligned so an early Node 22 release gets an upgrade hint before dependencies load.
export const MIN_NODE_VERSION = "22.12.0";

type RuntimeVersions = {
  node?: string;
  bun?: string;
};

/** Node's `os.homedir()` ignores HOME on Windows and prefers USERPROFILE. Git Bash, portable launchers,
 *  and hermetic automation conventionally override HOME, so mirror that explicit override before the
 *  rest of Hara is imported. This keeps every ~/.hara consumer on the same private root. */
export function applyPortableHomeEnv(
  env: NodeJS.ProcessEnv = process.env,
  runtimePlatform: NodeJS.Platform = process.platform,
): boolean {
  if (runtimePlatform !== "win32") return false;
  const home = normalizePortableWindowsHome(env.HOME ?? "");
  if (!home || env.USERPROFILE === home) return false;
  env.USERPROFILE = home;
  return true;
}

/** Convert the MSYS/Git-Bash forms seen by native Windows Node into native drive/UNC paths. */
export function normalizePortableWindowsHome(value: string): string {
  const home = value.trim();
  const drive = /^\/([a-zA-Z])(?:\/(.*))?$/u.exec(home);
  if (drive) return `${drive[1].toUpperCase()}:\\${(drive[2] ?? "").replace(/\//g, "\\")}`;
  if (/^\/\/[^/]/u.test(home)) return `\\\\${home.slice(2).replace(/\//g, "\\")}`;
  if (/^[a-zA-Z]:[\\/]/u.test(home)) return home[0].toUpperCase() + home.slice(1).replace(/\//g, "\\");
  return home;
}

/**
 * Resolve the same user home even when Hara modules are embedded directly instead of entered through
 * `cli.ts`/`runtime-bootstrap.cjs`. Native Windows Node ignores HOME in `os.homedir()`, while Git Bash and
 * portable launchers intentionally use it. Keeping this resolver side-effect free lets security/workspace
 * checks honor that explicit boundary without requiring callers to mutate their environment first.
 */
export function effectiveHomeDir(
  env: NodeJS.ProcessEnv = process.env,
  runtimePlatform: NodeJS.Platform = process.platform,
  systemHome = homedir(),
): string {
  const explicit = String(env.HOME ?? "").trim();
  if (!explicit) return systemHome;
  return runtimePlatform === "win32" ? normalizePortableWindowsHome(explicit) : explicit;
}

function supportedNodeVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const current = match.slice(1).map(Number);
  const minimum = MIN_NODE_VERSION.split(".").map(Number);
  for (let index = 0; index < minimum.length; index++) {
    if (current[index] > minimum[index]) return true;
    if (current[index] < minimum[index]) return false;
  }
  return true;
}

/** Bun powers Hara's standalone binaries and does not require a host Node installation. */
export function unsupportedNodeMessage(versions: RuntimeVersions = process.versions): string | null {
  if (versions.bun) return null;

  const version = String(versions.node ?? "unknown");
  if (supportedNodeVersion(version)) return null;

  const major = Number.parseInt(version, 10);
  const detail = major === MIN_NODE_MAJOR
    ? `This Node.js ${MIN_NODE_MAJOR} release is below Hara's supported ${MIN_NODE_VERSION} floor.`
    : `This Node.js release is below Hara's supported ${MIN_NODE_VERSION} floor.`;

  return [
    `Hara requires Node.js ${MIN_NODE_VERSION} or newer (detected ${version}).`,
    detail,
    `Upgrade with: nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}`,
    "Or install the standalone Hara binary, which does not require Node.js:",
    "  curl -fsSL https://raw.githubusercontent.com/hara-cli/hara/main/install.sh | sh",
  ].join("\n");
}
