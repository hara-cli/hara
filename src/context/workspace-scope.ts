import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Resolve existing paths through symlinks before comparing security/workspace scopes. Falling back to
 *  resolve() keeps messages deterministic for a path that disappears during startup; normal cwd/home paths
 *  exist and therefore take the realpath branch. */
export function canonicalWorkspacePath(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

/** The user's home directory is a control/personal-data scope, not an implicit project workspace. */
export function isHomeWorkspace(cwd: string, home = homedir()): boolean {
  return canonicalWorkspacePath(cwd) === canonicalWorkspacePath(home);
}

/** A recursive root is unsafe when it is Home itself OR an ancestor that would descend into Home. This
 * closes `path: ".."`, filesystem-root, and symlink-alias bypasses while keeping an explicitly selected
 * project child under Home usable. */
export function recursiveRootContainsHome(root: string, home = homedir()): boolean {
  const canonicalRoot = canonicalWorkspacePath(root);
  const canonicalHome = canonicalWorkspacePath(home);
  const rel = relative(canonicalRoot, canonicalHome);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function homeWorkspaceActionError(action: string): string {
  return (
    `Refusing to ${action} from the home directory: it is not an implicit project workspace. ` +
    "Run `cd /path/to/project` first."
  );
}

export function recursiveHomeSearchError(tool: string): string {
  return (
    `Error: ${tool} will not recursively scan the home directory. ` +
    "Run Hara from a project (`cd /path/to/project`) or set `path` to a specific file/subdirectory. " +
    "Non-recursive `ls` and explicit file reads remain available."
  );
}

/** Injected into model context when Hara was intentionally launched at ~/. Runtime checks enforce the same
 *  policy, but guidance avoids wasting turns on calls that are guaranteed to be rejected. */
export function homeWorkspaceGuidance(cwd: string): string {
  if (!isHomeWorkspace(cwd)) return "";
  return (
    "# Home-directory workspace boundary\n" +
    "The working directory resolves to the user's home directory, which is not an implicit project. " +
    "Do not initialize a project, build a repository index, run shell/external executable tools, or recursively " +
    "grep/glob/search the home root. " +
    "Ask the user to run `cd /path/to/project` for project work. Non-recursive `ls`, explicitly named files, " +
    "and explicitly named child directories remain available."
  );
}
