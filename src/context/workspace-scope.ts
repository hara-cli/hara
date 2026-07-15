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
    "Run `cd /path/to/project` first, or launch with `hara --cwd /path/to/project`."
  );
}

export function recursiveHomeSearchError(tool: string): string {
  return (
    `Error: ${tool} will not recursively scan the home directory. ` +
    "Run Hara from a project (`cd /path/to/project` or `hara --cwd /path/to/project`). Explicit single-file reads remain available."
  );
}

/** A model rooted at Home must not discover a child and silently promote it into the project scope. The
 * user establishes that scope by launching Hara from the concrete project directory. */
export function homeWorkspaceDirectoryScanError(tool: string): string {
  return (
    `Error: ${tool} will not enumerate or recursively scan directories while Hara is rooted at the home directory. ` +
    "Run `cd /path/to/project` or relaunch with `hara --cwd /path/to/project`. Explicit single-file reads remain available."
  );
}

/** Injected into model context when Hara was intentionally launched at ~/. Runtime checks enforce the same
 *  policy, but guidance avoids wasting turns on calls that are guaranteed to be rejected. */
export function homeWorkspaceGuidance(cwd: string): string {
  if (!isHomeWorkspace(cwd)) return "";
  return (
    "# Home-directory workspace boundary\n" +
    "The working directory resolves to the user's home directory, which is not an implicit project. " +
    "Do not initialize a project, create or modify files, build a repository index, run shell/external " +
    "executable tools, enumerate directories, or grep/glob/search Home or one of its child directories. " +
    "Ask the user to run `cd /path/to/project` or `hara --cwd /path/to/project` for project work. Only explicitly named single-file reads remain available."
  );
}
