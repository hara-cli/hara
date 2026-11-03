// Host-owned outer process boundary. Native permission switches cannot relax this Seatbelt profile.
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertWorkspaceRunContextCurrent, type WorkspaceRunPermit } from "../workspace/execution.js";
import { redactSensitiveText } from "../security/secrets.js";

export type RuntimePermissionTier = "full-protected" | "controlled";
export type RegisteredPolicyRuntime = "codex" | "claude" | "opencode" | "gemini" | "copilot" | "cursor" | "kimi" | "grok";
const RUNTIMES: readonly string[] = ["codex", "claude", "opencode", "gemini", "copilot", "cursor", "kimi", "grok"];
export const isRuntimePermissionTier = (value: unknown): value is RuntimePermissionTier => value === "full-protected" || value === "controlled";
export interface RuntimeExecutionPolicyInput {
  runtimeId: RegisteredPolicyRuntime; tier: RuntimePermissionTier; workRoot: string; accountHome: string;
  runtimeHome?: string; protectedStateRoots?: readonly string[]; lifetime?: "attempt" | "resident";
  /** Existing installer decision, never an invitation to log in or copy credentials. */
  loginSource?: "host" | "isolated";
}
export interface NormalizedNativeRuntimeEvent {
  type: "file" | "command" | "tool" | "risk"; status: "started" | "completed" | "failed";
  id?: string; path?: string; operation?: string; command?: string; nodeId?: string; channelId?: string;
}
export interface RuntimeRiskEvent {
  id: string; kind: "outside-workspace-delete" | "external-publish"; state: "observed"; summary: string; at: string;
  nodeId?: string; channelId?: string;
}
interface FileStamp { kind: "file" | "link" | "unsafe"; digest: string }
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
  if (!isAbsolute(path)) throw new Error("Runtime boundary must be absolute");
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
function snapshot(root: string): { files: Map<string, FileStamp>; complete: boolean } {
  const files = new Map<string, FileStamp>(), pending = [root]; let bytes = 0, complete = true;
  while (pending.length) {
    const directory = pending.pop()!;
    let rows; try { rows = readdirSync(directory, { withFileTypes: true }); } catch { complete = false; continue; }
    for (const row of rows) {
      if ([".git", "node_modules", ".hara"].includes(row.name)) continue;
      const path = join(directory, row.name), name = relative(root, path);
      if (files.size >= 4000) { complete = false; break; }
      try {
        if (!contains(root, realpathSync.native(dirname(path)))) { complete = false; continue; }
        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) { files.set(name, { kind: "link", digest: String(stat.ino) + ":" + stat.mtimeMs }); continue; }
        if (stat.isDirectory()) { pending.push(path); continue; }
        if (!stat.isFile() || stat.nlink !== 1) { files.set(name, { kind: "unsafe", digest: String(stat.ino) + ":" + stat.mtimeMs }); continue; }
        if (/(?:^|\/)(?:\.env(?:\.[^/]*)?|auth\.json|\.credentials\.json|credentials(?:\.[^/]*)?|oauth_creds\.json)$/u.test(name)) continue;
        bytes += stat.size; if (stat.size > 4 * 1024 * 1024 || bytes > 32 * 1024 * 1024) { complete = false; continue; }
        const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        let data: Buffer, after;
        try {
          const opened = fstatSync(fd), named = lstatSync(path);
          if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.nlink !== 1 || !opened.isFile()
            || named.dev !== opened.dev || named.ino !== opened.ino || realpathSync.native(path) !== path) { complete = false; continue; }
          data = readFileSync(fd); after = fstatSync(fd);
        } finally { closeSync(fd); }
        if (stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || after.nlink !== 1) { complete = false; continue; }
        files.set(name, { kind: "file", digest: hash(data) });
      } catch { complete = false; }
    }
  }
  return { files, complete };
}
export function workspaceRunPermissionTier(permit: WorkspaceRunPermit): RuntimePermissionTier {
  assertWorkspaceRunContextCurrent(permit);
  const value = (permit.binding.agent as unknown as { permissionTier?: unknown }).permissionTier;
  if (value === undefined) return "controlled"; // a durable old task is never silently upgraded
  if (!isRuntimePermissionTier(value)) throw new Error("Invalid frozen runtime permission tier");
  return value;
}
export function runtimeExecutionPolicyKey(input: RuntimeExecutionPolicyInput): string {
  return hash(JSON.stringify([input.runtimeId, input.tier, physical(input.workRoot), physical(input.accountHome),
    input.runtimeHome ? physical(input.runtimeHome) : null, input.protectedStateRoots?.map(physical) ?? [], input.loginSource ?? "host"]));
}
export class RuntimeExecutionPolicy {
  readonly key: string; readonly tempRoot: string; readonly profile: string;
  readonly stateDirectories: readonly string[]; readonly readableCredentialFiles: readonly string[];
  readonly risks: RuntimeRiskEvent[] = [];
  readonly workRoot: string;
  private closed = false; private nativeEventCount = 0;
  private baseline: ReturnType<typeof snapshot>;
  private attemptKey: string = randomUUID();
  private lastEvidence?: NativeWorkspaceEvidence;
  private readonly input: RuntimeExecutionPolicyInput;
  constructor(input: RuntimeExecutionPolicyInput) {
    if (!RUNTIMES.includes(input.runtimeId) || !isRuntimePermissionTier(input.tier)) throw new Error("Invalid runtime execution policy");
    this.input = { ...input }; this.key = runtimeExecutionPolicyKey(input);
    this.workRoot = physical(input.workRoot); const home = physical(input.accountHome);
    if (!lstatSync(this.workRoot).isDirectory() || this.workRoot === sep || contains(this.workRoot, home)) throw new Error("Unsafe runtime working directory");
    const roots: Record<RegisteredPolicyRuntime, string> = {
      codex: join(home, ".codex"), claude: join(home, ".claude"), opencode: join(home, ".local/share/opencode"),
      gemini: join(home, ".gemini"), copilot: join(home, ".copilot"), cursor: join(home, ".cursor"), kimi: join(home, ".kimi"), grok: join(home, ".grok"),
    };
    const runtimeHome = input.runtimeHome ? physical(input.runtimeHome) : physical(roots[input.runtimeId]);
    const dirs: Record<RegisteredPolicyRuntime, string[]> = {
      codex: ["sessions", "archived_sessions", "log", "tmp", "shell_snapshots"],
      claude: ["projects", "todos", "debug", "session-env", "shell-snapshots", "file-history", "cache", "plans", "paste-cache"],
      opencode: ["."], gemini: ["tmp", "history"], copilot: ["session-state", "logs"], cursor: ["chats"], kimi: ["sessions", "logs"], grok: ["sessions", "logs"],
    };
    const writes = dirs[input.runtimeId].map(name => physical(join(runtimeHome, name)));
    if (input.runtimeId === "opencode") writes.push(physical(join(home, ".cache/opencode")), physical(join(home, ".local/state/opencode")));
    if (input.runtimeId === "cursor") writes.push(physical(join(home, ".cursor-agent/sessions")));
    const authNames: Record<RegisteredPolicyRuntime, string[]> = {
      codex: ["auth.json"], claude: [".credentials.json"], opencode: ["auth.json"], gemini: ["oauth_creds.json", "google_accounts.json"],
      copilot: ["config.json"], cursor: ["cli-config.json"], kimi: ["config.toml"], grok: ["user-settings.json", "auth.json"],
    };
    const allCredentials = Object.entries(roots).flatMap(([id, root]) => authNames[id as RegisteredPolicyRuntime].map(name => physical(join(root, name))));
    const ownCredentials = authNames[input.runtimeId].map(name => physical(join(runtimeHome, name)));
    if (input.runtimeId === "copilot") ownCredentials.push(physical(join(home, ".config/gh/hosts.yml")));
    allCredentials.push(physical(join(home, ".config/gh/hosts.yml")));
    const forbidden = [physical(join(home, ".hara")), ...(input.protectedStateRoots ?? []).map(physical)];
    if (forbidden.some(root => contains(root, this.workRoot))) throw new Error("Runtime working directory is protected Hara state");
    this.baseline = snapshot(this.workRoot);
    if ([...this.baseline.files.values()].some(row => row.kind === "unsafe")) throw new Error("Runtime working directory has unsafe linked files");
    this.tempRoot = mkdtempSync(join(realpathSync.native(tmpdir()), "hara-native-")); chmodSync(this.tempRoot, 0o700);
    if (forbidden.some(root => contains(root, this.tempRoot))) { rmSync(this.tempRoot, { recursive: true }); throw new Error("Runtime temporary directory overlaps protected Hara state"); }
    this.stateDirectories = Object.freeze(writes); this.readableCredentialFiles = Object.freeze(ownCredentials);
    const quotedSubpaths = (paths: readonly string[]) => paths.map(path => `(subpath ${quote(path)})`).join("\n  ");
    const literals = (paths: readonly string[]) => paths.map(path => `(literal ${quote(path)})`).join("\n  ");
    const keychains = [physical(join(home, "Library/Keychains"))];
    const secretDirs = [".ssh", ".aws", ".azure", ".gnupg", ".config/gcloud"].map(name => physical(join(home, name)));
    const foreignCredentials = allCredentials.filter(path => !ownCredentials.includes(path));
    const generic = '#"(^|/)(auth[.]json|[.]credentials[.]json|oauth_creds[.]json|credentials([.][^/]*)?|[.]git-credentials|[.]netrc|[.]env([.][^/]*)?)$"';
    const readableExceptions = ownCredentials.map(path => `(require-not (literal ${quote(path)}))`).join(" ");
    const writable = [this.tempRoot, ...writes, ...(input.tier === "full-protected" ? [this.workRoot] : [])];
    const lines = ["(version 1)", "(allow default)", "(deny file-write*)", `(allow file-write*\n  ${quotedSubpaths(writable)}\n  (literal \"/dev/null\") (literal \"/dev/stdout\") (literal \"/dev/stderr\") (literal \"/dev/tty\"))`,
      // Never create hard-link aliases to defeat a path-based read/write boundary.
      "(deny file-link)",
      `(deny file-write*\n  ${quotedSubpaths([...forbidden, ...secretDirs, ...keychains])}\n  ${literals([...allCredentials, ...ownCredentials])}\n  (regex ${generic}))`,
      `(deny file-read-data\n  ${quotedSubpaths(secretDirs)}\n  ${literals(foreignCredentials)}\n  (require-all (regex ${generic}) ${readableExceptions}))`,
      // Jeff 2026-11-03: native host login uses the original Keychain and securityd ACL, no copy.
      '(allow mach-lookup (global-name "com.apple.securityd") (global-name "com.apple.secd") (global-name "com.apple.securityd.xpc"))',
    ];
    for (const root of forbidden) lines.push(`(deny file-read-data (require-all (subpath ${quote(root)}) ${readableExceptions}))`);
    if (input.runtimeId === "codex") lines.push(`(allow file-write* (regex #${quote("^" + runtimeHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/(state_[0-9]+|logs_[0-9]+)[.]sqlite(-wal|-shm)?$")}) (literal ${quote(join(runtimeHome, "history.jsonl"))}) (literal ${quote(join(runtimeHome, "session_index.jsonl"))}))`);
    // Denials come last as well: no native state exception may open Hara or credential writes.
    lines.push(`(deny file-write*\n  ${quotedSubpaths([...forbidden, ...secretDirs, ...keychains])}\n  ${literals([...allCredentials, ...ownCredentials])}\n  (regex ${generic}))`);
    this.profile = lines.join("\n") + "\n";
    if (Buffer.byteLength(this.profile) > 96 * 1024) { rmSync(this.tempRoot, { recursive: true }); throw new Error("Runtime Seatbelt policy is too large"); }
  }
  wrap(input: { command: string; args: readonly string[]; env: NodeJS.ProcessEnv }): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
    if (this.closed || process.platform !== "darwin") throw new Error("Runtime write protection requires macOS Seatbelt; no unprotected fallback");
    if (!isAbsolute(input.command)) throw new Error("Runtime command must be resolved by the installer");
    return { command: "/usr/bin/sandbox-exec", args: ["-p", this.profile, input.command, ...input.args], env: { ...input.env,
      PATH: [dirname(input.command), input.env.PATH].filter(Boolean).join(delimiter),
      TMPDIR: this.tempRoot + sep, TMP: this.tempRoot, TEMP: this.tempRoot, SQLITE_TMPDIR: this.tempRoot } };
  }
  /** A resident process outlives permits; evidence and risk observations never do. */
  beginAttempt(attemptKey: string): void {
    if (this.closed || !/^[a-zA-Z0-9_-]{1,200}$/u.test(attemptKey)) throw new Error("Invalid native attempt boundary");
    this.baseline = snapshot(this.workRoot); this.attemptKey = attemptKey; this.lastEvidence = undefined;
    this.nativeEventCount = 0; this.risks.length = 0;
  }
  observeNativeEvent(event: NormalizedNativeRuntimeEvent): void {
    if (this.closed || this.nativeEventCount >= 1024) return;
    this.nativeEventCount++;
    let kind: RuntimeRiskEvent["kind"] | undefined;
    if (event.path && /delete|remove|unlink/u.test(event.operation ?? "") && !contains(this.workRoot, resolve(this.workRoot, event.path))) kind = "outside-workspace-delete";
    if (event.command && /\b(?:git\s+push|npm\s+publish|pnpm\s+publish|gh\s+(?:release\s+create|pr\s+merge))\b/u.test(event.command)) kind = "external-publish";
    if (!kind || this.risks.length >= 64) return;
    this.risks.push({ id: randomUUID(), kind, state: "observed", summary: kind === "external-publish" ? "Native runtime publication command observed" : "Native runtime deletion outside its working directory observed",
      at: new Date().toISOString(), ...(event.nodeId ? { nodeId: event.nodeId.slice(0, 80) } : {}), ...(event.channelId ? { channelId: event.channelId.slice(0, 80) } : {}) });
  }
  collectWorkspaceEvidence(): NativeWorkspaceEvidence | null {
    if (this.closed || this.input.tier !== "full-protected" || !this.baseline.complete) return null;
    const current = snapshot(this.workRoot); if (!current.complete) return null;
    const changes: NativeWorkspaceEvidence["changes"] = [];
    for (const path of [...new Set([...this.baseline.files.keys(), ...current.files.keys()])].sort()) {
      const before = this.baseline.files.get(path), after = current.files.get(path);
      if (before?.digest === after?.digest && before?.kind === after?.kind) continue;
      if (before && before.kind !== "file" || after && after.kind !== "file") return null;
      changes.push({ path: redactSensitiveText(path).text, change: !before ? "created" : !after ? "deleted" : "changed", before: before?.digest ?? null, after: after?.digest ?? null });
    }
    if (!changes.length || changes.length > 256) return null;
    const digest = hash(JSON.stringify(changes));
    if (this.lastEvidence?.digest === digest) return this.lastEvidence;
    return this.lastEvidence = { id: randomUUID(), source: "native-workspace-diff", digest, verified: true, changes,
      attemptKey: this.attemptKey, nativeEventCount: this.nativeEventCount };
  }
  async close(): Promise<void> { if (!this.closed) { this.closed = true; rmSync(this.tempRoot, { recursive: true, force: true }); } }
}
export function createRuntimeExecutionPolicy(input: RuntimeExecutionPolicyInput): RuntimeExecutionPolicy { return new RuntimeExecutionPolicy(input); }
