// A local `npm link` records the package's bin target at link time. When Hara moved its guarded bin
// from dist/index.js to runtime-bootstrap.cjs, an older global link could keep targeting the internal
// implementation forever. Builds deliberately normalize dist/index.js to 0644, so that stale link then
// fails in the shell with an opaque EACCES before Hara can print its Node/runtime guidance.
//
// This check is read-only: builds warn with the exact owning bin directory, but never rewrite a user's
// global npm state. Re-running `npm link` under that Node installation is the explicit repair.
import { lstatSync, realpathSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT), "..");

function canonical(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** Pure classifier exported for regression tests and embedders. */
export function isLegacyLinkedTarget(target, root = REPO_ROOT) {
  return canonical(target) === canonical(join(root, "dist", "index.js"));
}

/** Return stale POSIX hara links visible in PATH. Windows npm shims are regenerated on install/link and
 * do not fail through a non-executable symlink target in this way. */
export function findStaleLocalHaraLinks(pathEnv = process.env.PATH ?? "", root = REPO_ROOT) {
  if (process.platform === "win32") return [];
  const found = [];
  const seen = new Set();
  for (const binDir of pathEnv.split(delimiter).filter(Boolean)) {
    const binPath = resolve(binDir, "hara");
    if (seen.has(binPath)) continue;
    seen.add(binPath);
    try {
      if (!lstatSync(binPath).isSymbolicLink()) continue;
      const target = canonical(binPath);
      if (isLegacyLinkedTarget(target, root)) found.push({ binPath, binDir: resolve(binDir), target });
    } catch {
      // A missing/unreadable PATH entry is unrelated to this diagnostic.
    }
  }
  return found;
}

export function staleLocalLinkWarning(link, root = REPO_ROOT) {
  return [
    `hara: stale local npm link detected: ${link.binPath} -> ${link.target}`,
    "The supported bin is runtime-bootstrap.cjs; dist/index.js is an internal non-executable module.",
    `Repair from ${root} with the Node installation that owns this link:`,
    `  PATH=${JSON.stringify(link.binDir)}:$PATH npm link`,
    "Then run `rehash` (zsh) and `hara --version`. Do not chmod dist/index.js.",
  ].join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT) {
  for (const link of findStaleLocalHaraLinks()) process.stderr.write(staleLocalLinkWarning(link) + "\n");
}
