export const MIN_NODE_MAJOR = 22;
// Commander 15 (a direct runtime dependency) requires this exact floor. Keep package engines, startup,
// doctor, and docs aligned so an early Node 22 release gets an upgrade hint before dependencies load.
export const MIN_NODE_VERSION = "22.12.0";

type RuntimeVersions = {
  node?: string;
  bun?: string;
};

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
