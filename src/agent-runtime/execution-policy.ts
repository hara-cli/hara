import type { ChildProcess } from "node:child_process";
import { RuntimeProcessBoundary, RUNTIME_GUARD_SCRIPT, type RuntimeDrainReport } from "./process-boundary.js";
// Host-owned outer process boundary. Native permission switches cannot relax this Seatbelt profile.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, type BigIntStats } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertWorkspaceRunContextCurrent, workspaceRunHasManagedProject, workspaceRunManagedProjectRoots, type WorkspaceRunPermit } from "../workspace/execution.js";
import { redactSensitiveText } from "../security/secrets.js";

export type RuntimePermissionTier = "full-protected" | "controlled";
export type RegisteredPolicyRuntime = "pi" | "codex" | "claude" | "opencode" | "gemini" | "copilot" | "cursor" | "kimi" | "grok";
const RUNTIMES: readonly string[] = ["pi", "codex", "claude", "opencode", "gemini", "copilot", "cursor", "kimi", "grok"];
export const isRuntimePermissionTier = (value: unknown): value is RuntimePermissionTier => value === "full-protected" || value === "controlled";

/** Jeff 2026-11-08 (decision B): macOS keeps Seatbelt write protection with no unprotected fallback.
 * Other platforms keep the released 1.0.x behavior: no OS-level write protection, so the full tier is
 * unavailable and only the controlled tier (native read-only/plan modes plus Hara governance) runs. */
export type RuntimeWriteProtection = "seatbelt" | "none";
export const runtimeWriteProtection = (platform: NodeJS.Platform = process.platform): RuntimeWriteProtection => platform === "darwin" ? "seatbelt" : "none";
export const availableRuntimePermissionTiers = (platform: NodeJS.Platform = process.platform): readonly RuntimePermissionTier[] =>
  runtimeWriteProtection(platform) === "seatbelt" ? ["full-protected", "controlled"] : ["controlled"];
export const defaultRuntimePermissionTier = (platform: NodeJS.Platform = process.platform): RuntimePermissionTier =>
  runtimeWriteProtection(platform) === "seatbelt" ? "full-protected" : "controlled";
export const RUNTIME_TIER_UNAVAILABLE = "permission_tier_unavailable_on_platform";
/** A durable full-protected binding reaching a platform without Seatbelt is refused, never silently downgraded. */
export class RuntimeTierUnavailableError extends Error {
  readonly code = RUNTIME_TIER_UNAVAILABLE;
  constructor() { super("Full protection requires macOS Seatbelt. This platform has no system-level write protection; switch this colleague to the controlled tier to run it"); }
}
export const NATIVE_ENGINE_UNSUPPORTED = "native_engine_unsupported_on_platform";
/** Native engines rely on a POSIX process boundary; Windows has no equivalent launcher in this release. */
export class NativeEngineUnsupportedError extends Error {
  readonly code = NATIVE_ENGINE_UNSUPPORTED;
  constructor() { super("Native engines are not supported on Windows in this release; use Pi"); }
}
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
/** The npm Pi SDK imports OpenAI's source named credentials.mjs. This is code, not a login store.
 * Resolve only the trusted installed dependency; this exception applies to the generic basename mask,
 * never to Hara/Keychain/foreign credential directories. Bundled binaries need no filesystem exception. */
function piPackagedCodeReads(): string[] {
  try {
    const sdk = fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"));
    const openai = createRequire(sdk).resolve("openai");
    const file = physical(realpathSync.native(join(dirname(openai), "resources/beta/agents/vaults/credentials.mjs")));
    const info = lstatSync(file);
    return info.isFile() && info.nlink === 1 ? [file] : [];
  } catch { return []; }
}
export interface RuntimeExecutionPolicyInput {
  runtimeId: RegisteredPolicyRuntime; tier: RuntimePermissionTier; workRoot: string; accountHome: string;
  runtimeHome?: string; protectedStateRoots?: readonly string[]; lifetime?: "attempt" | "resident";
  /** Host-only opaque capability for the exact default managed project, never a JSON/path grant. */
  managedProjectPermit?: WorkspaceRunPermit;
  /** Existing installer decision, never an invitation to log in or copy credentials. */
  loginSource?: "host" | "isolated";
}
export interface NormalizedNativeRuntimeEvent {
  type: "file" | "command" | "tool" | "risk"; status: "started" | "completed" | "failed";
  id?: string; path?: string; operation?: string; command?: string; nodeId?: string; channelId?: string;
}
/** Reserved channel confirmation transport. This slice only calls observation hooks, never this request. */
export interface RuntimeHighRiskHooks {
  onObserved?(event: Readonly<RuntimeRiskEvent>): void;
  requestHighRiskConfirmation?(event: Readonly<RuntimeRiskEvent>, scope: { nodeId: string; channelId: string; runId: string }): Promise<"approved" | "denied">;
}
export interface RuntimeRiskEvent {
  id: string; kind: "outside-workspace-delete" | "external-publish"; state: "observed"; summary: string; at: string;
  nodeId?: string; channelId?: string;
}
interface FileStamp { kind: "file" | "link" | "unsafe"; digest: string; metadata: string; access: string }
export interface NativeWorkspaceEvidence {
  id: string; source: "native-workspace-diff"; digest: string; verified: true; attemptKey: string;
  changes: { path: string; change: "created" | "changed" | "deleted"; before: string | null; after: string | null }[];
  nativeEventCount: number;
}
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const contains = (root: string, path: string): boolean => path === root || path.startsWith(root + sep);
const quote = (value: string): string => {
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error("Invalid runtime boundary path");
  return JSON.stringify(value);
};
/** Resolve absent descendants through their actual existing ancestor; never broaden a linked grant. */
function physical(path: string): string {
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) throw new Error("Runtime boundary must be absolute");
  let prefix: string = sep;
  for (const part of resolve(path).split(sep).filter(Boolean)) {
    prefix = join(prefix, part);
    try { if (lstatSync(prefix).isSymbolicLink()) throw new Error("Runtime boundary contains a symbolic link"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
  }
  let current = resolve(path); const tail: string[] = [];
  for (;;) {
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink()) throw new Error("Runtime boundary contains a symbolic link");
      const real = realpathSync.native(current);
      if (tail.length && !info.isDirectory()) throw new Error("Runtime boundary parent is not a directory");
      return join(real, ...tail.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current); if (parent === current) throw new Error("Runtime boundary is unavailable");
      tail.push(current.slice(parent.length + (parent === sep ? 0 : 1))); current = parent;
    }
  }
}
/** Metadata supplements the content witness; it is never a content-version cache key.
 * A persistent writable mmap can change bytes without changing even nanosecond ctime.
 * Keep reading/hashing every admitted file until a stronger change witness is available. */
function snapshotMetadata(info: BigIntStats): string {
  return [info.dev, info.ino, info.size, info.mode, info.nlink, info.uid, info.gid, info.ctimeNs, info.mtimeNs].join(":");
}
function snapshot(root: string): { files: Map<string, FileStamp>; complete: boolean } {
  const files = new Map<string, FileStamp>(), pending = [root]; let bytes = 0n, complete = true;
  while (pending.length) {
    const directory = pending.pop()!;
    let rows; try { rows = readdirSync(directory, { withFileTypes: true }); } catch { complete = false; continue; }
    for (const row of rows) {
      if ([".git", "node_modules", ".hara"].includes(row.name)) continue;
      const path = join(directory, row.name), name = relative(root, path);
      if (files.size >= 4000) { complete = false; break; }
      try {
        if (!contains(root, realpathSync.native(dirname(path)))) { complete = false; continue; }
        const stat = lstatSync(path, { bigint: true }), metadata = snapshotMetadata(stat);
        const access = [stat.mode, stat.uid, stat.gid].join(":");
        if (stat.isSymbolicLink()) { files.set(name, { kind: "link", digest: metadata, metadata, access }); continue; }
        if (stat.isDirectory()) { pending.push(path); continue; }
        if (!stat.isFile() || stat.nlink !== 1n) { files.set(name, { kind: "unsafe", digest: metadata, metadata, access }); continue; }
        if (/(?:^|\/)(?:\.env(?:\.[^/]*)?|auth\.json|\.credentials\.json|credentials(?:\.[^/]*)?|oauth_creds\.json)$/u.test(name)) continue;
        bytes += stat.size; if (stat.size > 4n * 1024n * 1024n || bytes > 32n * 1024n * 1024n) { complete = false; continue; }
        const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let data: Buffer, after: BigIntStats;
        try {
          const opened = fstatSync(fd, { bigint: true }), named = lstatSync(path, { bigint: true });
          if (!opened.isFile() || snapshotMetadata(opened) !== metadata || snapshotMetadata(named) !== metadata
            || realpathSync.native(path) !== path) { complete = false; continue; }
          data = readFileSync(fd); after = fstatSync(fd, { bigint: true });
          // A renamed-open inode may still have nlink=1: revalidate the name as well as the descriptor.
          if (snapshotMetadata(lstatSync(path, { bigint: true })) !== metadata || realpathSync.native(path) !== path) { complete = false; continue; }
        } finally { closeSync(fd); }
        if (BigInt(data.byteLength) !== stat.size || snapshotMetadata(after) !== metadata) { complete = false; continue; }
        files.set(name, { kind: "file", digest: hash(data), metadata, access });
      } catch { complete = false; }
    }
  }
  return { files, complete };
}
function frozenPermissionTier(permit: WorkspaceRunPermit): RuntimePermissionTier {
  const value = (permit.binding.agent as unknown as { permissionTier?: unknown }).permissionTier;
  if (value === undefined) return "controlled"; // a durable old task is never silently upgraded
  if (!isRuntimePermissionTier(value)) throw new Error("Invalid frozen runtime permission tier");
  return value;
}
export function workspaceRunPermissionTier(permit: WorkspaceRunPermit): RuntimePermissionTier {
  assertWorkspaceRunContextCurrent(permit); return frozenPermissionTier(permit);
}
/** The native App stores user project files beneath .hara, beside (not inside) private Host state.
 * Only the existing unforgeable Host permit can distinguish this exact admitted project from state.
 * Custom/arbitrary Hara paths and serialized bindings remain protected. No free writableRoots API. */
function managedDefaultProject(input: RuntimeExecutionPolicyInput) {
  const permit = input.managedProjectPermit;
  if (!permit) return null;
  const managed = workspaceRunHasManagedProject(permit), root = physical(input.workRoot);
  if (permit.binding.project.root !== root || permit.binding.agent.runtimeId !== input.runtimeId
    || frozenPermissionTier(permit) !== input.tier) throw new Error("Managed project policy differs from the admitted binding");
  if (!managed) return null;
  const paths = workspaceRunManagedProjectRoots(permit)!;
  if (paths.workRoot !== root) throw new Error("Managed project cwd differs from its Host proof");
  const expected = join(physical(input.accountHome), ".hara", "workspaces-v1", "project", permit.binding.scope.workspaceId);
  return Object.freeze({ ...paths, haraException: paths.legacyRoot === expected,
    scopeKey: permit.binding.agent.resourceBinding.scopeKey, generation: permit.binding.agent.resourceBinding.generation });
}
function policyKey(input: RuntimeExecutionPolicyInput, managed: ReturnType<typeof managedDefaultProject>): string {
  return hash(JSON.stringify([input.runtimeId, input.tier, physical(input.workRoot), physical(input.accountHome),
    input.runtimeHome ? physical(input.runtimeHome) : null, input.protectedStateRoots?.map(physical) ?? [], input.loginSource ?? "host", input.lifetime ?? "attempt", input.runtimeId === "pi" ? piPackagedCodeReads() : [], ...(managed ? [managed] : [])]));
}
export function runtimeExecutionPolicyKey(input: RuntimeExecutionPolicyInput): string {
  return policyKey(input, managedDefaultProject(input));
}
export class RuntimeExecutionPolicy {
  readonly key: string; readonly tempRoot: string; readonly profile: string;
  readonly stateDirectories: readonly string[]; readonly readableCredentialFiles: readonly string[];
  readonly risks: RuntimeRiskEvent[] = [];
  readonly workRoot: string;
  readonly evidenceRoot: string;
  private readonly processes = new RuntimeProcessBoundary();
  private readonly colleagueHome?: string;
  private readonly colleagueNamespace?: string;
  private ambiguous = false;
  private closed = false; private nativeEventCount = 0;
  private baseline: ReturnType<typeof snapshot>;
  private attemptKey: string = randomUUID();
  private lastEvidence?: NativeWorkspaceEvidence;
  private readonly input: RuntimeExecutionPolicyInput;
  private readonly platform: NodeJS.Platform;
  /** `options.platform` is an internal test seam only; production always uses the Host process platform. */
  constructor(input: RuntimeExecutionPolicyInput, options: { platform?: NodeJS.Platform } = {}) {
    if (!RUNTIMES.includes(input.runtimeId) || !isRuntimePermissionTier(input.tier)) throw new Error("Invalid runtime execution policy");
    this.platform = options.platform ?? process.platform;
    if (!availableRuntimePermissionTiers(this.platform).includes(input.tier)) throw new RuntimeTierUnavailableError();
    const managed = managedDefaultProject(input);
    this.input = { ...input }; this.key = policyKey(input, managed);
    if (managed) { this.colleagueHome = managed.homeRoot; this.colleagueNamespace = join(managed.legacyRoot, "colleagues"); }
    this.workRoot = physical(input.workRoot); this.evidenceRoot = physical(managed?.legacyRoot ?? this.workRoot); const home = physical(input.accountHome);
    if (!lstatSync(this.workRoot).isDirectory() || this.workRoot === sep || contains(this.workRoot, home)) throw new Error("Unsafe runtime working directory");
    const roots: Record<RegisteredPolicyRuntime, string> = {
      pi: join(home, ".pi/agent"), codex: join(home, ".codex"), claude: join(home, ".claude"), opencode: join(home, ".local/share/opencode"),
      gemini: join(home, ".gemini"), copilot: join(home, ".copilot"), cursor: join(home, ".cursor"), kimi: join(home, ".kimi-code"), grok: join(home, ".grok"),
    };
    const runtimeHome = input.runtimeHome ? physical(input.runtimeHome) : physical(roots[input.runtimeId]);
    const dirs: Record<RegisteredPolicyRuntime, string[]> = {
      pi: ["sessions", "log", "tmp"], codex: ["sessions", "archived_sessions", "log", "tmp", "shell_snapshots", "thread-writer-locks"],
      claude: ["projects", "todos", "debug", "session-env", "shell-snapshots", "file-history", "cache", "plans", "paste-cache"],
      opencode: ["."], gemini: ["tmp", "history"], copilot: ["session-state", "logs"], cursor: ["chats"], kimi: ["sessions", "logs", "locks/sessions"], grok: ["sessions", "logs"],
    };
    const writes = dirs[input.runtimeId].map(name => physical(join(runtimeHome, name)));
    if (input.runtimeId === "opencode") writes.push(physical(join(home, ".cache/opencode")), physical(join(home, ".local/state/opencode")));
    if (input.runtimeId === "cursor") writes.push(physical(join(home, ".cursor-agent/sessions")));
    const authNames: Record<RegisteredPolicyRuntime, string[]> = {
      pi: ["auth.json"], codex: ["auth.json"], claude: [".credentials.json"], opencode: ["auth.json"], gemini: ["oauth_creds.json", "google_accounts.json"],
      copilot: ["config.json"], cursor: ["cli-config.json"], kimi: ["config.toml", "credentials/kimi-code.json"], grok: ["user-settings.json", "auth.json"],
    };
    const allCredentials = Object.entries(roots).flatMap(([id, root]) => authNames[id as RegisteredPolicyRuntime].map(name => physical(join(root, name))));
    const ownCredentials = (input.runtimeId === "pi" ? [] : authNames[input.runtimeId]).map(name => physical(join(runtimeHome, name)));
    if (input.runtimeId === "copilot") ownCredentials.push(physical(join(home, ".config/gh/hosts.yml")));
    allCredentials.push(physical(join(home, ".config/gh/hosts.yml")), physical(join(home, ".claude.json")));
    if (input.runtimeId === "claude" && runtimeHome === physical(roots.claude) && input.loginSource !== "isolated") ownCredentials.push(physical(join(home, ".claude.json")));
    if (runtimeHome === sep || runtimeHome === home || contains(runtimeHome, this.workRoot)) throw new Error("Unsafe runtime state directory");
    const piAuth = input.runtimeId === "pi" ? physical(join(runtimeHome, "auth.json")) : undefined;
    if (piAuth) {
      if (!input.runtimeHome || contains(this.workRoot, runtimeHome) || contains(physical(join(home, ".pi")), runtimeHome)) throw new Error("Pi requires a dedicated empty-auth agent directory");
      const info = lstatSync(piAuth);
      // Reject credential-sized files before opening anything; the caller creates only this empty store.
      if (!info.isFile() || info.nlink !== 1 || info.size > 3 || readFileSync(piAuth, "utf8").trim() !== "{}") throw new Error("Pi auth must be the dedicated empty object");
      allCredentials.push(piAuth);
    }
    const haraRoot = physical(join(home, ".hara")), managedWorkRoot = managed?.haraException ? managed.legacyRoot : undefined;
    const stateRoots = (input.protectedStateRoots ?? []).map(physical), forbidden = [haraRoot, ...stateRoots];
    const projectRoots = [...new Set([this.workRoot, this.evidenceRoot])];
    if (projectRoots.some(project => project === sep || contains(project, home)
      || forbidden.some(root => contains(root, project) && !(root === haraRoot && managedWorkRoot && contains(managedWorkRoot, project)))
      || stateRoots.some(root => contains(project, root)))) throw new Error("Runtime working directory is protected Hara state");
    this.baseline = snapshot(this.evidenceRoot);
    if ([...this.baseline.files.values()].some(row => row.kind === "unsafe")) throw new Error("Runtime working directory has unsafe linked files");
    this.stateDirectories = Object.freeze(writes); this.readableCredentialFiles = Object.freeze(ownCredentials);
    const quotedSubpaths = (paths: readonly string[]) => paths.map(path => `(subpath ${quote(path)})`).join("\n  ");
    const literals = (paths: readonly string[]) => paths.map(path => `(literal ${quote(path)})`).join("\n  ");
    const keychains = [physical(join(home, "Library/Keychains"))];
    const secretDirs = [".ssh", ".aws", ".azure", ".gnupg", ".config/gcloud", ".pi", ".kimi",
      ...(input.runtimeId === "kimi" ? [] : [".kimi-code"])].map(name => physical(join(home, name)));
    const pluginRoots: string[] = [];
    if (input.runtimeId === "codex") pluginRoots.push(physical(join(runtimeHome, "plugins")), physical(join(home, ".agents/plugins")));
    if (input.runtimeId === "opencode") {
      pluginRoots.push(physical(join(home, ".config/opencode")));
      for (let p = this.workRoot;; p = dirname(p)) {
        for (const part of ["plugins", "plugin", "tools", "tool"]) pluginRoots.push(physical(join(p, ".opencode", part)));
        if (dirname(p) === p) break;
      }
    }
    const foreignRoots = Object.entries(roots).filter(([id]) => id !== input.runtimeId).map(([, root]) => physical(root));
    const foreignCredentials = allCredentials.filter(path => !ownCredentials.includes(path) && path !== piAuth);
    const generic = '#"(^|/)(auth[.]json|[.]credentials[.]json|oauth_creds[.]json|credentials([.][^/]*)?|[.]git-credentials|[.]netrc|[.]env([.][^/]*)?)$"';
    const readableExceptions = [...ownCredentials, ...(piAuth ? [piAuth] : [])].map(path => `(require-not (literal ${quote(path)}))`).join(" ");
    const genericReadExceptions = readableExceptions + (input.runtimeId === "pi" ? piPackagedCodeReads().map(path => ` (require-not (literal ${quote(path)}))`).join("") : "");
    this.tempRoot = mkdtempSync(join(realpathSync.native(tmpdir()), "hara-native-")); chmodSync(this.tempRoot, 0o700);
    if (forbidden.some(root => contains(root, this.tempRoot))) { rmSync(this.tempRoot, { recursive: true }); throw new Error("Runtime temporary directory overlaps protected Hara state"); }
    const isolated = (input.loginSource === "isolated" || input.runtimeId === "pi") && input.runtimeHome ? runtimeHome : undefined;
    if (isolated && forbidden.some(root => contains(isolated, root))) { rmSync(this.tempRoot, { recursive: true }); throw new Error("Isolated runtime exception cannot contain a Hara protection root"); }
    const protectedPaths = forbidden.map(root => "(require-all (subpath " + quote(root) + ") "
      + (isolated ? "(require-not (subpath " + quote(isolated) + ")) " : "")
      + (root === haraRoot && managedWorkRoot ? "(require-not (subpath " + quote(managedWorkRoot) + "))" : "") + ")").join("\n  ");
    const writable = [this.tempRoot, ...writes, ...(isolated && input.runtimeId !== "pi" ? [isolated] : []), ...(input.tier === "full-protected" ? projectRoots : [])];
    const lines = ["(version 1)", "(allow default)", "(deny file-write*)", `(allow file-write*\n  ${quotedSubpaths(writable)}\n  (literal \"/dev/null\") (literal \"/dev/stdout\") (literal \"/dev/stderr\") (literal \"/dev/tty\"))`,
      // Never create hard-link aliases to defeat a path-based read/write boundary.
      "(deny file-link)",
      `(deny file-write*\n  ${protectedPaths}\n  ${quotedSubpaths([...secretDirs, ...keychains])}\n  ${literals([...allCredentials, ...ownCredentials])}\n  (regex ${generic}))`,
      `(deny file-read-data\n  ${quotedSubpaths([...secretDirs, ...foreignRoots, ...pluginRoots])}\n  ${literals(foreignCredentials)}\n  (require-all (regex ${generic}) ${genericReadExceptions}))`,
      // Jeff 2026-11-03: native host login uses the original Keychain and securityd ACL, no copy.
      `${input.runtimeId === "pi" ? "(deny" : "(allow"} mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.secd") (global-name "com.apple.securityd.xpc"))`,
      ...(input.runtimeId === "pi" ? [`(deny file-read-data ${quotedSubpaths(keychains)})`] : []),
    ];
    for (const root of forbidden) lines.push(`(deny file-read-data (require-all (subpath ${quote(root)}) ${isolated ? `(require-not (subpath ${quote(isolated)}))` : ""} ${root === haraRoot && managedWorkRoot ? `(require-not (subpath ${quote(managedWorkRoot)}))` : ""} ${readableExceptions}))`);
    // Scheme normal strings consume the JSON-escaped path once. A # raw string would
    // double-escape .codex and silently deny every SQLite file. Keep the basename set closed.
    if (input.runtimeId === "codex") lines.push(`(allow file-write* (regex ${quote("^" + runtimeHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/((state|logs|memories|queue|goals)_[0-9]+)[.]sqlite(-wal|-shm|-journal)?$")}) (literal ${quote(join(runtimeHome, "installation_id"))}) (literal ${quote(join(runtimeHome, "history.jsonl"))}) (literal ${quote(join(runtimeHome, "session_index.jsonl"))}))`);
    // Codex 0.163.0 caches model discovery/TTL here with a direct write (no atomic
    // temporary basename). Keep this literal separate from all global config/skills.
    if (input.runtimeId === "codex") lines.push(`(allow file-write* (literal ${quote(join(runtimeHome, "models_cache.json"))}))`);
    // Gemini 0.66 initializes its project registry before auth or JSON output. Its lock retries
    // otherwise look like a silent startup hang. Admit only this state transaction, not the home.
    if (input.runtimeId === "kimi") {
      const prefix = runtimeHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const workspaceTemp = "^" + prefix + "/workspaces[.]json[.]tmp[.][0-9]+[.]" + "[0-9a-f]".repeat(8) + "$";
      lines.push(`(allow file-write-create (require-all (literal ${quote(runtimeHome)}) (vnode-type DIRECTORY)))`,
        `(allow file-write* (literal ${quote(join(runtimeHome, "session_index.jsonl"))}) (literal ${quote(join(runtimeHome, "workspaces.json"))}) (regex ${quote(workspaceTemp)}))`,
        `(allow file-write* (require-all (literal ${quote(join(runtimeHome, "locks"))}) (vnode-type DIRECTORY)))`);
    }
    if (input.runtimeId === "gemini") {
      const prefix = runtimeHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const hex = (length: number) => "[0-9a-f]".repeat(length);
      const registryTemp = "^" + prefix + "/projects[.]json[.]" + hex(8) + "-" + hex(4) + "-4" + hex(3) + "-[89ab]" + hex(3) + "-" + hex(12) + "[.]tmp$";
      lines.push(`(allow file-write* (literal ${quote(join(runtimeHome, "projects.json"))}) (literal ${quote(join(runtimeHome, "installation_id"))}) (regex ${quote(registryTemp)}))`,
        `(allow file-write* (require-all (literal ${quote(join(runtimeHome, "projects.json.lock"))}) (vnode-type DIRECTORY)))`);
    }
    if (piAuth) lines.push(`(allow file-write* (require-all (literal ${quote(join(runtimeHome, "auth.json.lock"))}) (vnode-type DIRECTORY)))`,
      `(deny file-write* ${literals([piAuth, join(runtimeHome, "models.json"), join(runtimeHome, "settings.json")])})`);
    // Host's Gemini injection is immutable during this attempt, including its parent rename path.
    if (input.runtimeId === "gemini") lines.push(`(deny file-write* ${literals([join(this.workRoot, ".gemini"), join(this.workRoot, ".gemini/settings.json"), join(this.workRoot, ".gemini/.hara-settings.lock")])})`);
    // Denials come last as well: no native state exception may open Hara or credential writes.
    lines.push(`(deny file-write*\n  ${protectedPaths}\n  ${quotedSubpaths([...secretDirs, ...keychains])}\n  ${literals([...allCredentials, ...ownCredentials])}\n  (regex ${generic}))`);
    if (managed) {
      const namespace = join(managed.legacyRoot, "colleagues");
      // A broad legacy compatibility grant must never authorize a sibling home or standing rules.
      lines.push(`(deny file-write* (require-all (subpath ${quote(namespace)}) (require-not (subpath ${quote(managed.homeRoot)}))))`);
      lines.push(`(deny file-write-unlink ${literals([...new Set([this.workRoot, managed.legacyRoot, namespace, managed.homeRoot])])})`);
      const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const fold = (value: string) => [...value].map(char => /[a-z]/iu.test(char) ? `[${char.toLowerCase()}${char.toUpperCase()}]` : escape(char)).join("");
      for (const root of new Set([managed.legacyRoot, managed.homeRoot])) {
        const prefix = "^" + escape(root) + "/";
        lines.push(`(deny file-write* (regex ${quote(prefix + "(" + ["AGENTS.md", "CLAUDE.md", "CLAUDE.local.md"].map(fold).join("|") + ")$")}) (regex ${quote(prefix + "(" + [".claude", ".codex"].map(fold).join("|") + ")(/|$)")}))`);
      }
    }
    this.profile = lines.join("\n") + "\n";
    if (Buffer.byteLength(this.profile) > 96 * 1024) { rmSync(this.tempRoot, { recursive: true }); throw new Error("Runtime Seatbelt policy is too large"); }
  }
  get runtimeId(): RegisteredPolicyRuntime { return this.input.runtimeId; }
  get tier(): RuntimePermissionTier { return this.input.tier; }
  /** Whether this launch runs inside an OS write sandbox. Callers keep native read-only modes when it does not. */
  get writeProtection(): RuntimeWriteProtection { return runtimeWriteProtection(this.platform); }
  wrap(input: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }): { command: string; args: string[]; env: NodeJS.ProcessEnv; onProcess(child: ChildProcess, processGroup: boolean): Promise<void>; drainProcess(): Promise<void> } {
    if (this.closed) throw new Error("Runtime execution policy is closed; no launch is admitted");
    const seatbelt = this.writeProtection === "seatbelt";
    // macOS never falls back: a missing Seatbelt executable refuses the launch.
    if (seatbelt && !existsSync(SANDBOX_EXEC)) throw new Error("Runtime write protection requires macOS Seatbelt; no unprotected fallback");
    if (this.platform === "win32") throw new NativeEngineUnsupportedError();
    // Off macOS the constructor admitted only the controlled tier; there is no OS write sandbox.
    if (!seatbelt && this.input.tier !== "controlled") throw new RuntimeTierUnavailableError();
    if (!isAbsolute(input.command)) throw new Error("Runtime command must be resolved by the installer");
    this.processes.markWrapped();
    const launchEnv = { ...input.env };
    for (const name of Object.keys(launchEnv)) if (/^(?:BASH_FUNC_|DYLD_|LD_PRELOAD$|LD_LIBRARY_PATH$|NODE_OPTIONS$|NODE_PATH$|ENV$|BASH_ENV$|SHELLOPTS$|BASHOPTS$)/u.test(name)) delete launchEnv[name];
    const sandbox = seatbelt ? [SANDBOX_EXEC, "-p", this.profile] : [];
    return { onProcess: (child, processGroup) => this.processes.own(child, processGroup), drainProcess: async () => { await this.processes.drain(false); },
      command: "/bin/sh", args: ["-c", RUNTIME_GUARD_SCRIPT, "hara-native-guard", ...sandbox, input.command, ...input.args], env: { ...launchEnv,
      ENV: undefined, BASH_ENV: undefined,
      PATH: [dirname(input.command), input.env.PATH].filter(Boolean).join(delimiter),
      TMPDIR: this.tempRoot + sep, TMP: this.tempRoot, TEMP: this.tempRoot, SQLITE_TMPDIR: this.tempRoot } };
  }
  /** A resident process outlives permits; evidence and risk observations never do. */
  beginAttempt(attemptKey: string): void {
    if (this.closed || !/^[a-zA-Z0-9_-]{1,200}$/u.test(attemptKey)) throw new Error("Invalid native attempt boundary");
    this.processes.beginAttempt();
    this.baseline = snapshot(this.evidenceRoot);
    if ([...this.baseline.files.values()].some(row => row.kind === "unsafe")) throw new Error("Runtime working directory has unsafe linked files");
    this.attemptKey = attemptKey; this.lastEvidence = undefined;
    this.nativeEventCount = 0; this.risks.length = 0; this.ambiguous = false;
  }
  private projectPathAllowed(path: string): boolean {
    return contains(this.evidenceRoot, path) && !(this.colleagueNamespace && contains(this.colleagueNamespace, path)
      && (!this.colleagueHome || !contains(this.colleagueHome, path)));
  }
  observeNativeEvent(event: NormalizedNativeRuntimeEvent): void {
    if (this.closed || this.nativeEventCount >= 1024) return;
    this.nativeEventCount++;
    let kind: RuntimeRiskEvent["kind"] | undefined;
    if (event.path && /delete|remove|unlink/u.test(event.operation ?? "") && !this.projectPathAllowed(resolve(this.workRoot, event.path))) kind = "outside-workspace-delete";
    if (event.command && /\b(?:git\s+push|npm\s+publish|pnpm\s+publish|gh\s+(?:release\s+create|pr\s+merge))\b/u.test(event.command)) kind = "external-publish";
    if (!kind && event.command) {
      const deletion = /(?:^|[;&|]\s*)(?:rm|rmdir|unlink)\s+(?:-[a-zA-Z-]+\s+)*(?:"([^"$`]+)"|'([^']+)'|([^\s;&|]+))/u.exec(event.command);
      const target = deletion?.[1] ?? deletion?.[2] ?? deletion?.[3];
      if (target && !target.includes("$") && !this.projectPathAllowed(resolve(this.workRoot, target))) kind = "outside-workspace-delete";
    }
    if (!kind || this.risks.length >= 64) return;
    this.risks.push({ id: randomUUID(), kind, state: "observed", summary: kind === "external-publish" ? "Native runtime publication command observed" : "Native runtime deletion outside its working directory observed",
      at: new Date().toISOString(), ...(event.nodeId ? { nodeId: event.nodeId.slice(0, 80) } : {}), ...(event.channelId ? { channelId: event.channelId.slice(0, 80) } : {}) });
  }
  invalidateEvidence(): void { this.ambiguous = true; this.lastEvidence = undefined; }
  /** A direct conversational answer cannot hide a native call, incomplete scan or file change. */
  canCompleteConversation(): boolean {
    if (this.closed || this.ambiguous || this.nativeEventCount || !this.baseline.complete) return false;
    const current = snapshot(this.evidenceRoot);
    if (!current.complete || current.files.size !== this.baseline.files.size) return false;
    return [...this.baseline.files].every(([path, before]) => before.kind !== "unsafe"
      && current.files.get(path)?.kind === before.kind && current.files.get(path)?.digest === before.digest
      && current.files.get(path)?.metadata === before.metadata);
  }
  collectWorkspaceEvidence(): NativeWorkspaceEvidence | null {
    if (this.closed || this.ambiguous || this.input.tier !== "full-protected" || !this.baseline.complete) return null;
    const current = snapshot(this.evidenceRoot); if (!current.complete) return null;
    const changes: NativeWorkspaceEvidence["changes"] = [];
    for (const path of [...new Set([...this.baseline.files.keys(), ...current.files.keys()])].sort()) {
      const before = this.baseline.files.get(path), after = current.files.get(path);
      if (before?.digest === after?.digest && before?.kind === after?.kind) {
        // Metadata-only effects cannot be represented by the content-hash evidence DTO.
        if (before?.metadata !== after?.metadata) return null;
        continue;
      }
      if (before && before.kind !== "file" || after && after.kind !== "file") return null;
      if (before && after && before.access !== after.access) return null;
      changes.push({ path: redactSensitiveText(path).text, change: !before ? "created" : !after ? "deleted" : "changed", before: before?.digest ?? null, after: after?.digest ?? null });
    }
    if (!changes.length || changes.length > 256) return null;
    const digest = hash(JSON.stringify(changes));
    if (this.lastEvidence?.digest === digest) return this.lastEvidence = { ...this.lastEvidence, nativeEventCount: this.nativeEventCount };
    return this.lastEvidence = { id: randomUUID(), source: "native-workspace-diff", digest, verified: true, changes,
      attemptKey: this.attemptKey, nativeEventCount: this.nativeEventCount };
  }
  async prepareAttempt(): Promise<void> { await this.processes.prepareAttempt(); }
  /** Only the Host may seal initialized runtime children before the first resident model turn. */
  async prepareResidentRoot(): Promise<void> {
    if (this.closed || this.input.lifetime !== "resident") throw new Error("Only a resident policy may prepare its runtime root");
    await this.processes.prepareResidentRoot();
  }
  /** Single exec: drain the whole tree. Resident: only this attempt's descendants; keep its root. */
  async drainAttempt(input: { keepResidentRoot?: boolean } = {}): Promise<RuntimeDrainReport> {
    if (input.keepResidentRoot && this.input.lifetime !== "resident") throw new Error("Only a resident policy may retain its native root");
    return this.processes.drain(input.keepResidentRoot === true);
  }
  async close(): Promise<void> { if (!this.closed) { await this.processes.close(); this.closed = true; rmSync(this.tempRoot, { recursive: true, force: true }); } }
}
export function createRuntimeExecutionPolicy(input: RuntimeExecutionPolicyInput, options: { platform?: NodeJS.Platform } = {}): RuntimeExecutionPolicy { return new RuntimeExecutionPolicy(input, options); }
