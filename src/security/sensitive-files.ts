// Hard read boundary for files that routinely contain credentials. This policy is evaluated before
// approval/full-auto: an autonomous agent must not turn a read-only tool into a secret-exfiltration path.
// Users who intentionally need a secret file in model context must opt in BEFORE launching hara with
// HARA_ALLOW_SENSITIVE_FILES=1; a model/tool call cannot grant itself that exception mid-run.
import {
  existsSync,
  lstatSync,
  opendirSync,
  realpathSync,
  statSync,
} from "node:fs";
import type { Dir, Dirent } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";

const SAFE_ENV_TEMPLATES = new Set(["example", "sample", "template", "dist", "defaults"]);
const PRIVATE_BASENAMES = new Set([
  ".envrc",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".dockerconfigjson",
  "application_default_credentials.json",
]);
const PRIVATE_DATA_NAME = /^(?:credentials?|secrets?|service[-_]?account)(?:\.(?:json|ya?ml|toml|ini|cfg|conf))?$/i;
const PRIVATE_KEY_NAME = /^(?:id_(?:rsa|ed25519|ecdsa)|.*\.(?:pem|key|p12|pfx|keystore))$/i;
const HARA_PRIVATE_FILES = new Set([
  "config.json",
  "qwen-oauth.json",
  "profiles.json",
  "serve.json",
  "desk.json",
  "desk-collector.json",
  "org.json",
  "org.json.legacy",
  "flows.json",
  "flows-log.jsonl",
  "flows-pending.json",
  "permissions.json",
]);
const HARA_PRIVATE_DIRS = new Set(["sessions", "checkpoints", "index", "gateway", "cron"]);
const HARA_AGENT_CONTENT_DIRS = new Set([
  "workspace", "plugins", "skills", "roles", "org-roles", "memory", "code-assets", "bin", "tts",
]);
const WALK_IGNORE = new Set([
  ".git", "node_modules", "dist", "build", "out", ".next", ".nuxt", ".cache",
  "coverage", ".venv", "venv", "__pycache__", "target", ".turbo", "vendor",
]);
const PROJECT_MARKERS = [".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod"];
const SSH_PUBLIC_STATE = /^(?:config|known_hosts(?:\.old)?|authorized_keys|.*\.pub)$/i;
const MAX_SCAN_ENTRIES = 250_000;

const toPosix = (value: string): string => (sep === "/" ? value : value.split(sep).join("/"));
/** Windows resolves trailing dots/spaces and NTFS ADS aliases before opening a path. Apply that identity
 * normalization to EVERY component on every OS so lexical checks cannot be bypassed before Windows sees it. */
const normalizedSecurityComponent = (name: string): string => {
  const withoutStream = /^[A-Za-z]:$/u.test(name) ? name : name.replace(/:.*$/u, "");
  return withoutStream.replace(/[. ]+$/u, "").toLowerCase();
};
const normalizedSecurityBasename = normalizedSecurityComponent;

function securityPathComponents(path: string): string[] {
  return toPosix(resolve(path)).split("/").map(normalizedSecurityComponent);
}

function securityRelativeComponents(path: string, root: string): string[] | null {
  const candidate = securityPathComponents(path);
  const base = securityPathComponents(root);
  if (candidate.length < base.length || base.some((part, index) => candidate[index] !== part)) return null;
  return candidate.slice(base.length);
}

function hasSecuritySuffix(path: string, suffix: readonly string[]): boolean {
  const components = securityPathComponents(path);
  const normalizedSuffix = suffix.map(normalizedSecurityComponent);
  return components.length >= normalizedSuffix.length
    && normalizedSuffix.every((part, index) => components[components.length - normalizedSuffix.length + index] === part);
}

export function sensitiveFilesAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HARA_ALLOW_SENSITIVE_FILES === "1";
}

function envFileReason(name: string): string | null {
  // NTFS alternate data streams (`.env::$DATA`) and trailing-dot/space aliases resolve to the same
  // underlying file on Windows. Normalize them on every OS so the policy is testable everywhere.
  const lower = normalizedSecurityBasename(name);
  if (lower === ".env") return "environment file";
  if (!lower.startsWith(".env.")) return null;
  const suffix = lower.slice(5);
  const finalSuffix = suffix.split(".").at(-1) ?? suffix;
  return SAFE_ENV_TEMPLATES.has(finalSuffix) ? null : "environment file";
}

function hasSegment(path: string, segment: string): boolean {
  return securityPathComponents(path).includes(normalizedSecurityComponent(segment));
}

function within(path: string, root: string): string | null {
  const rel = relative(root, path);
  if (!rel) return "";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return toPosix(rel);
}

function homeCredentialStateReason(path: string): string | null {
  const absolute = resolve(path);
  const home = homedir();
  if (securityRelativeComponents(absolute, join(home, ".aws")) !== null) return "AWS credential state";
  if (securityRelativeComponents(absolute, join(home, ".docker")) !== null) return "Docker credential state";
  if (securityRelativeComponents(absolute, join(home, ".kube")) !== null) return "Kubernetes credential state";
  const sshRel = securityRelativeComponents(absolute, join(home, ".ssh"));
  if (sshRel !== null && sshRel.length > 0 && !SSH_PUBLIC_STATE.test(sshRel.at(-1) ?? "")) return "SSH private key state";
  return null;
}

function haraStateReason(path: string): string | null {
  const absolute = resolve(path);
  // Apply the same Windows alias normalization to every Hara-state component, not only the final
  // basename. `config.json::$DATA`, `sessions:stream/...`, and trailing-dot/space variants all address
  // protected state on NTFS and must retain that identity on every platform where the policy is tested.
  const parts = securityPathComponents(absolute);
  const haraAt = parts.lastIndexOf(".hara");
  if (haraAt >= 0) {
    const after = parts.slice(haraAt + 1);
    if (after.length === 1 && HARA_PRIVATE_FILES.has(after[0])) return "private Hara state";
    if (HARA_PRIVATE_DIRS.has(after[0])) return "private Hara state";
    if (after.at(-1)?.endsWith(".context-tokens.json") || after.at(-1)?.endsWith(".cursor")) return "private Hara token state";
    if (after.at(-1)?.startsWith("desk-enroll-key")) return "private Hara enrollment key";
  }

  // ~/.hara is a runtime control plane, not a general project. Keep the explicitly agent-authored content
  // surfaces readable and protect every other top-level/runtime entry by default. This catches future token
  // files without waiting for another basename patch.
  const homeState = join(homedir(), ".hara");
  const segments = securityRelativeComponents(absolute, homeState);
  if (segments !== null && segments.length > 0) {
    const top = segments[0];
    if (HARA_AGENT_CONTENT_DIRS.has(top)) return null;
    if (segments[1] === "media") return null; // authorized gateway attachments are an agent input surface
    return "private Hara state";
  }
  return null;
}

/** Lexical policy. Exported for walkers/search workers that must filter a path without opening it. */
export function lexicalSensitiveFileReason(path: string): string | null {
  const name = basename(path);
  const lower = normalizedSecurityBasename(name);
  const envReason = envFileReason(name);
  if (envReason) return envReason;
  if (PRIVATE_BASENAMES.has(lower)) return "credential file";
  if (PRIVATE_DATA_NAME.test(lower)) return "credential data file";
  if (PRIVATE_KEY_NAME.test(lower) && !lower.endsWith(".pub")) return "private key file";

  const components = securityPathComponents(path);
  if (components.some((segment) => envFileReason(segment) !== null)) return "environment file state";
  if (hasSecuritySuffix(path, [".aws", "credentials"])) return "AWS credential file";
  if (hasSecuritySuffix(path, [".docker", "config.json"])) return "Docker credential file";
  if (hasSecuritySuffix(path, [".kube", "config"])) return "Kubernetes credential file";
  if (hasSegment(path, ".direnv")) return "direnv secret state";
  if (lower === ".hara-profile") return "private Hara routing state";
  const credentialState = homeCredentialStateReason(path);
  if (credentialState) return credentialState;
  const stateReason = haraStateReason(path);
  if (stateReason) return stateReason;
  return null;
}

/**
 * Resolve a prospective path through its nearest existing ancestor. Unlike `realpath(dirname(path))`,
 * this also handles multiple missing tail components: `alias/missing/deep/file` is rebuilt below the
 * canonical target of `alias`, so an existing parent symlink cannot hide a protected destination.
 */
export function canonicalizeProspectivePath(path: string): string {
  let current = resolve(path);
  const missingTail: string[] = [];
  for (let depth = 0; depth < 128; depth++) {
    try {
      const ancestor = realpathSync.native(current);
      return missingTail.length ? join(ancestor, ...missingTail) : ancestor;
    } catch (error: any) {
      // ENOENT covers an absent component (including a path below one); ENOTDIR lets the caller receive
      // the eventual filesystem error while still deriving a stable candidate for the security policy.
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`cannot canonicalize prospective path '${path}'`);
    missingTail.unshift(basename(current));
    current = parent;
  }
  throw new Error(`prospective path exceeds 128 components: '${path}'`);
}

/** Check both the requested name and its canonical/prospective target, matching Codex/CC's symlink-safe deny-read. */
function baseSensitiveFileReason(path: string): string | null {
  const lexical = lexicalSensitiveFileReason(path);
  if (lexical) return lexical;
  try {
    const canonical = canonicalizeProspectivePath(path);
    return lexicalSensitiveFileReason(canonical);
  } catch {
    return null;
  }
}

function ancestorDirs(start: string, cap = 128): string[] {
  const out: string[] = [];
  let current = resolve(start);
  for (let i = 0; i < cap; i++) {
    out.push(current);
    const parent = dirname(current);
    if (parent === current) return out;
    current = parent;
  }
  throw new Error(`protected-file ancestor scan exceeded ${cap} directories`);
}

function canonicalOrResolved(path: string): string {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}

/** Prefer the enclosing VCS root; otherwise use the nearest recognizable project marker. The caller also
 * checks direct entries in every ancestor, so a repo-root `.env` stays masked when a command runs in `src/`. */
function projectScanRootFrom(start: string): string {
  const ancestors = ancestorDirs(start);
  let nearestMarker: string | null = null;
  for (const dir of ancestors) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (!nearestMarker && PROJECT_MARKERS.slice(1).some((marker) => existsSync(join(dir, marker)))) nearestMarker = dir;
  }
  return nearestMarker ?? resolve(start);
}

function projectScanRoots(cwd: string): string[] {
  return [...new Set([
    projectScanRootFrom(resolve(cwd)),
    projectScanRootFrom(canonicalOrResolved(cwd)),
  ])];
}

interface ScanBudget {
  entries: number;
  readonly maxEntries: number;
}

function countEntry(budget: ScanBudget): void {
  budget.entries++;
  if (budget.entries > budget.maxEntries) {
    throw new Error(`protected-file scan exceeded ${budget.maxEntries} filesystem entries; refusing an incomplete mask`);
  }
}

function readDirBounded(dir: string, budget: ScanBudget): Dirent<string>[] {
  let handle: Dir | undefined;
  try {
    // `readdirSync` allocates the entire directory before a caller can enforce a cap. Reading one Dirent at
    // a time makes the filesystem-entry budget a real memory bound even for adversarial huge directories.
    handle = opendirSync(dir, { encoding: "utf8" });
    const entries: Dirent<string>[] = [];
    for (;;) {
      const entry = handle.readSync();
      if (!entry) break;
      countEntry(budget);
      entries.push(entry);
    }
    return entries;
  } catch (error) {
    if (error instanceof Error && error.message.includes("protected-file scan exceeded")) throw error;
    throw new Error(`cannot safely scan protected files under '${dir}': ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    try { handle?.closeSync(); } catch { /* best effort */ }
  }
}

function protectedDirectoryReason(path: string): string | null {
  const absolute = resolve(path);
  const parts = securityPathComponents(absolute);
  const haraAt = parts.lastIndexOf(".hara");
  if (haraAt >= 0 && HARA_PRIVATE_DIRS.has(parts[haraAt + 1] ?? "")) return "private Hara state";
  if (normalizedSecurityBasename(basename(absolute)) === ".direnv") return "direnv secret state";
  for (const name of [".aws", ".docker", ".kube"] as const) {
    if (securityRelativeComponents(absolute, join(homedir(), name)) !== null) return `${name.slice(1)} credential state`;
  }
  return null;
}

/** Compare device+inode without opening either file. This closes the ordinary hard-link alias bypass for
 * protected files discovered inside the same project/home boundary. */
export function sameFileIdentity(left: string, right: string): boolean {
  try {
    const a = statSync(left, { bigint: true });
    const b = statSync(right, { bigint: true });
    return a.isFile() && b.isFile() && a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
}

function fileIdentityKey(path: string): string | null {
  try {
    const info = statSync(path, { bigint: true });
    return info.isFile() ? `${info.dev}:${info.ino}` : null;
  } catch {
    return null;
  }
}

interface SensitiveDiscovery {
  files: string[];
  directories: string[];
  writeContainers: string[];
}

function discoverSensitiveMasks(cwd: string, maxEntries = MAX_SCAN_ENTRIES): SensitiveDiscovery {
  const found = new Set<string>();
  const directories = new Set<string>();
  const writeContainers = new Set<string>();
  const hardlinkCandidates: string[] = [];
  const budget: ScanBudget = { entries: 0, maxEntries };
  const addExisting = (set: Set<string>, path: string): void => {
    if (!existsSync(path)) return;
    set.add(resolve(path));
    try { set.add(realpathSync.native(path)); } catch { /* lexical path remains useful */ }
  };
  const addLexical = (path: string): void => {
    if (baseSensitiveFileReason(path)) found.add(resolve(path));
  };
  const visitFile = (path: string, regular: boolean): void => {
    addLexical(path);
    if (!regular) return;
    try { if (statSync(path).nlink > 1) hardlinkCandidates.push(resolve(path)); } catch { /* raced away */ }
  };
  const walk = (root: string, skipContent = false): void => {
    const stack = [resolve(root)];
    while (stack.length) {
      const dir = stack.pop()!;
      const entries = readDirBounded(dir, budget);
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (WALK_IGNORE.has(entry.name)) continue;
          if (entry.name.toLowerCase() === ".hara") addExisting(writeContainers, path);
          if (protectedDirectoryReason(path)) {
            addExisting(directories, path);
            continue; // represented by a Seatbelt subpath rule
          }
          if (skipContent && dir === resolve(root) && HARA_AGENT_CONTENT_DIRS.has(entry.name.toLowerCase())) continue;
          if (skipContent && entry.name === "media") continue;
          stack.push(path);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
          visitFile(path, entry.isFile());
        }
      }
    }
  };

  const roots = projectScanRoots(cwd);
  for (const root of roots) walk(root);
  // Also cover direct sensitive files above the selected project root (for example a monorepo or `$HOME`
  // `.env`) without recursively walking the entire home/filesystem.
  const rootKeys = roots.map((root) => resolve(root));
  const ancestorStarts = new Set([resolve(cwd), canonicalOrResolved(cwd)]);
  const scannedAncestors = new Set<string>();
  for (const start of ancestorStarts) {
    for (const ancestor of ancestorDirs(start)) {
      if (scannedAncestors.has(ancestor)) continue;
      scannedAncestors.add(ancestor);
      if (rootKeys.some((rootKey) => ancestor === rootKey || within(ancestor, rootKey) !== null)) continue;
      for (const entry of readDirBounded(ancestor, budget)) {
        if (entry.isFile() || entry.isSymbolicLink()) visitFile(join(ancestor, entry.name), entry.isFile());
      }
    }
  }

  const homeState = join(homedir(), ".hara");
  if (existsSync(homeState)) {
    addExisting(writeContainers, homeState);
    addExisting(writeContainers, join(homeState, "weixin"));
    walk(homeState, true);
  }
  // A command can run from /tmp or another checkout, so home-level `.env.*` and custom SSH key names
  // cannot rely on the project-ancestor pass above.
  if (existsSync(homedir())) {
    for (const entry of readDirBounded(homedir(), budget)) {
      if (entry.isFile() || entry.isSymbolicLink()) visitFile(join(homedir(), entry.name), entry.isFile());
    }
  }
  const sshState = join(homedir(), ".ssh");
  if (existsSync(sshState)) {
    addExisting(writeContainers, sshState);
    walk(sshState);
  }
  for (const path of [
    join(homeState, "sessions"),
    join(homeState, "checkpoints"),
    join(homeState, "index"),
    join(homeState, "gateway"),
    join(homeState, "cron"),
    join(homedir(), ".aws"),
    join(homedir(), ".docker"),
    join(homedir(), ".kube"),
  ]) addExisting(directories, path);
  for (const path of [
    join(homedir(), ".env"),
    join(homedir(), ".netrc"),
    join(homedir(), ".npmrc"),
    join(homedir(), ".pypirc"),
    join(homedir(), ".git-credentials"),
    join(homedir(), ".aws/credentials"),
    join(homedir(), ".docker/config.json"),
    join(homedir(), ".kube/config"),
    join(homedir(), ".config/gcloud/application_default_credentials.json"),
  ]) addLexical(path);
  // Include every in-project alias of a protected inode in the Seatbelt literal mask. Hard links do not
  // have a canonical "target", so pathname/realpath checks alone cannot close this bypass.
  const protectedInodes = new Set([...found].map(fileIdentityKey).filter((key): key is string => key !== null));
  for (const candidate of hardlinkCandidates) {
    if (found.has(candidate)) continue;
    const key = fileIdentityKey(candidate);
    if (key && protectedInodes.has(key)) found.add(candidate);
  }
  return { files: [...found], directories: [...directories], writeContainers: [...writeContainers] };
}

function sensitiveHardlinkReason(path: string): string | null {
  let info;
  try {
    info = statSync(path);
  } catch {
    return null;
  }
  if (!info.isFile() || info.nlink < 2) return null;
  let candidates: string[];
  try {
    candidates = discoverSensitiveMasks(dirname(path), 50_000).files;
  } catch {
    // An incomplete inode search cannot prove a multi-linked file safe. This affects only hard-linked
    // paths, so ordinary large repositories do not pay a compatibility penalty.
    return "unverified hard-linked file in an incomplete protected-file scan";
  }
  for (const candidate of candidates) {
    if (resolve(candidate) !== resolve(path) && sameFileIdentity(path, candidate)) return "hard link to protected credential file";
  }
  return null;
}

export function sensitiveFileReason(path: string): string | null {
  return baseSensitiveFileReason(path) ?? sensitiveHardlinkReason(path);
}

export function isSensitiveFilePath(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return !sensitiveFilesAllowed(env) && sensitiveFileReason(path) !== null;
}

export function sensitiveFileError(path: string, action = "access", env: NodeJS.ProcessEnv = process.env): string | null {
  if (sensitiveFilesAllowed(env)) return null;
  const reason = sensitiveFileReason(path);
  if (!reason) return null;
  return (
    `Blocked: refusing to ${action} protected ${reason} '${path}'. ` +
    "Hara's built-in file, context, and search paths block this before approval; trusted external extensions " +
    "and non-macOS arbitrary shells are separate trust boundaries. " +
    "If you intentionally want its contents sent to the model, restart hara with HARA_ALLOW_SENSITIVE_FILES=1."
  );
}

/** Broad-search exclusions. Templates are intentionally omitted from recursive grep as a safe bias; users
 * can still read/search a specific .env.example directly. A post-filter remains in search.ts as defense. */
export const SENSITIVE_SEARCH_GLOBS = [
  "**/.env",
  "**/.env.*",
  "**/.envrc",
  "**/.direnv/**",
  "**/.netrc",
  "**/.npmrc",
  "**/.pypirc",
  "**/.git-credentials",
  "**/credentials.json",
  "**/credentials.yaml",
  "**/credentials.yml",
  "**/secrets.json",
  "**/secrets.yaml",
  "**/secrets.yml",
  "**/service-account.json",
  "**/service_account.json",
  "**/application_default_credentials.json",
  "**/id_rsa",
  "**/id_ed25519",
  "**/id_ecdsa",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
  "**/*.keystore",
  "**/.hara/config.json",
  "**/.hara/permissions.json",
  "**/.hara/sessions/**",
  "**/.hara/checkpoints/**",
  "**/.hara/index/**",
  "**/.hara/gateway/**",
  "**/.hara/cron/**",
  "**/.hara/weixin/creds.json",
  "**/.hara/weixin/*.cursor",
  "**/.hara/weixin/*.context-tokens.json",
];

function expandShellCandidate(raw: string, cwd: string): string {
  let value = raw.replace(/^[<>]+|[,:]+$/g, "");
  if (value === "~") value = homedir();
  else if (value.startsWith("~/")) value = join(homedir(), value.slice(2));
  return isAbsolute(value) ? value : resolve(cwd, value);
}

/** `ps` has two incompatible option dialects: lowercase `-e` selects every process, while a bare BSD
 * option containing `e` or uppercase `-E` appends each process environment. Only the latter are secret
 * disclosure modes. Exported so readonly auto-approval uses the exact same classification. */
export function psArgumentsExposeEnvironment(args: readonly string[]): boolean {
  return args.some((word) => {
    const arg = word.replace(/^['"]|['"]$/g, "");
    if (/^-[^-]*E/u.test(arg)) return true;
    return !arg.startsWith("-") && /^[A-Za-z]*e[A-Za-z]*$/u.test(arg);
  });
}

function environmentDumpReason(command: string): string | null {
  const segments = command.split(/(?:&&|\|\||[;|\n])/);
  for (const segment of segments) {
    const words = segment.trim().replace(/^[({]+|[)}]+$/g, "").split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    let commandAt = words.findIndex((word) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
    if (commandAt < 0) continue;
    while (["command", "builtin", "exec", "nohup"].includes(basename(words[commandAt]?.replace(/^['"]|['"]$/g, "")))) {
      commandAt++;
      while (words[commandAt]?.startsWith("-")) commandAt++;
    }
    let prog = basename(words[commandAt]?.replace(/^['"]|['"]$/g, "") ?? "");
    let rest = words.slice(commandAt + 1);
    if (prog === "env") {
      const nested = rest.filter((word) => !word.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(word));
      if (!nested.length) return "env exposes the process environment";
      prog = basename(nested[0].replace(/^['"]|['"]$/g, ""));
      rest = nested.slice(1);
    }
    if (prog === "printenv") return "printenv exposes the process environment";
    if (prog === "set" && rest.length === 0) return "set exposes shell variables";
    if (prog === "export" && (rest.length === 0 || rest.some((word) => /^-p$/.test(word)))) return "export exposes the process environment";
    if (["declare", "typeset"].includes(prog) && (rest.length === 0 || rest.some((word) => /^-[^\s]*x/.test(word)))) {
      return `${prog} exposes exported shell variables`;
    }
    if (prog === "ps" && psArgumentsExposeEnvironment(rest)) return "ps exposes process environments";
  }
  if (/\/(?:proc\/[^/]+|dev\/fd\/[^/]+)\/environ\b/.test(command)) return "process environment pseudo-file";
  if (/\bjq\b[^\n;&|]*(?:\benv\b|\$ENV\b)/.test(command)) return "jq environment access";
  return null;
}

/** Conservative shell preflight. It is a hard deny, not an approval hint, so full-auto cannot bypass it. */
export function sensitiveShellCommandReason(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (sensitiveFilesAllowed(env)) return null;
  const dump = environmentDumpReason(command);
  if (dump) return dump;

  // Tokenize only literal path-like chunks; command substitution/variable tricks are separately forbidden
  // by the system contract and the macOS OS-level read mask. Ordinary code searches for `\.env` retain the
  // backslash and do not match this literal-file check.
  const chunks = command.match(/[^\s'"`=<>|;&(),]+/g) ?? [];
  for (const raw of chunks) {
    if (raw.startsWith("-") || raw.includes("\\.env")) continue;
    const candidate = expandShellCandidate(raw, cwd);
    const reason = sensitiveFileReason(candidate);
    if (reason) return `${reason}: ${raw}`;
    // Git revision pathspecs (`HEAD:.env`) do not look like filesystem paths until git resolves them.
    const colon = raw.lastIndexOf(":");
    if (colon > 0 && !/^\w+:\/\//.test(raw)) {
      const revisionPath = raw.slice(colon + 1);
      const revisionReason = sensitiveFileReason(resolve(cwd, revisionPath));
      if (revisionReason) return `${revisionReason} in revision path: ${raw}`;
    }
  }
  return null;
}

/** Guard explicit path/file arguments passed to an opaque extension tool. This cannot make a configured
 * MCP server trustworthy (it may read files at startup), but it prevents the ordinary filesystem-MCP path
 * bypass and keeps the limitation explicit rather than silently treating MCP as an in-process read tool. */
export function sensitiveStructuredInputReason(input: unknown, cwd: string): string | null {
  const visit = (value: unknown, key = "", depth = 0): string | null => {
    if (depth > 8) return "input nesting exceeds protected-path inspection depth";
    if (typeof value === "string" && /(?:path|file|dir|root|cwd|uri|location)/i.test(key)) {
      let raw = value.trim();
      if (/^file:\/\//i.test(raw)) {
        try { raw = fileURLToPath(raw); } catch { /* keep the original */ }
      }
      const reason = sensitiveFileReason(expandShellCandidate(raw, cwd));
      if (reason) return `${reason}: ${key || "path"}`;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const reason = visit(item, key, depth + 1);
        if (reason) return reason;
      }
    } else if (value && typeof value === "object") {
      for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
        const reason = visit(child, childKey, depth + 1);
        if (reason) return reason;
      }
    }
    return null;
  };
  return sensitiveFilesAllowed() ? null : visit(input);
}

/** Existing protected paths for macOS Seatbelt's file-read deny layer. The direct tool/shell checks above
 * remain authoritative on every platform; this closes indirect reads by package scripts on macOS. */
export interface SensitiveSeatbeltMasks {
  files: string[];
  directories: string[];
  writeContainers: string[];
}

export function existingSensitiveSeatbeltMasks(
  cwd: string,
  fileCap = 4096,
  maxEntries = MAX_SCAN_ENTRIES,
): SensitiveSeatbeltMasks {
  if (sensitiveFilesAllowed()) return { files: [], directories: [], writeContainers: [] };
  const discovery = discoverSensitiveMasks(cwd, maxEntries);
  const found = new Set<string>();
  const add = (path: string): void => {
    if (!existsSync(path)) return;
    try {
      const info = lstatSync(path);
      if (!info.isFile() && !info.isSymbolicLink()) return;
      const aliases = new Set([resolve(path)]);
      try { aliases.add(realpathSync.native(path)); } catch { /* lexical path is still useful */ }
      const additions = [...aliases].filter((alias) => !found.has(alias));
      if (found.size + additions.length > fileCap) {
        throw new Error(`protected-file scan exceeded ${fileCap} files; refusing to build an incomplete read mask`);
      }
      for (const alias of additions) found.add(alias);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("protected-file scan exceeded")) throw error;
      /* race/unreadable path: direct policy still fails closed when named */
    }
  };

  // Discovery starts at the enclosing project root, checks direct ancestor entries, and covers every
  // private `~/.hara` runtime file plus the standard user credential stores. Traversal itself is bounded;
  // exceeding either cap throws, because launching Seatbelt with an incomplete deny mask would be unsafe.
  for (const path of discovery.files) add(path);
  return { files: [...found], directories: discovery.directories, writeContainers: discovery.writeContainers };
}

export function existingSensitiveReadPaths(cwd: string, cap = 4096): string[] {
  return existingSensitiveSeatbeltMasks(cwd, cap).files;
}

/** Private state directories that Seatbelt can deny as a whole, including old checkpoint/index blobs whose
 * filenames are hashes and therefore cannot be recognized by a basename matcher. */
export function existingSensitiveReadDirectories(cwd: string, maxEntries = MAX_SCAN_ENTRIES): string[] {
  return existingSensitiveSeatbeltMasks(cwd, 4096, maxEntries).directories;
}

/** Directory entries whose rename would relocate protected descendants to an unmasked pathname. These are
 * write-only masks: `~/.hara/workspace` and public SSH metadata remain readable, while the containing
 * control-plane/key directory itself cannot be renamed or unlinked by a shell command. */
export function existingSensitiveWriteContainerPaths(cwd: string, maxEntries = MAX_SCAN_ENTRIES): string[] {
  return existingSensitiveSeatbeltMasks(cwd, 4096, maxEntries).writeContainers;
}

/** Useful in tests and diagnostics without revealing values. */
export function describeSensitivePath(path: string, cwd = process.cwd()): string | null {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  const reason = sensitiveFileReason(absolute);
  if (!reason) return null;
  const rel = relative(cwd, absolute);
  return `${reason}: ${rel && !rel.startsWith("..") ? rel : basename(absolute)}`;
}
