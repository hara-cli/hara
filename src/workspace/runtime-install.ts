import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import type { RuntimeFailureContext } from "../agent-runtime/failure-diagnostics.js";
import { userInfo } from "node:os";
import { join, dirname, isAbsolute, resolve } from "node:path";
import { WorkspaceJsonState, exact, plain, UUID } from "./local-state.js";
import { sameWorkspaceResourceBinding, workspaceResourceDirectory, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { OPTIONAL_RUNTIMES, RUNTIME_DOWNLOAD_HOSTS, RUNTIME_LABELS, resolveOfficialRuntimeArtifact, manualRuntimeInstallation } from "./runtime-catalog.js";
import { runtimeArchiveMember } from "./runtime-archive.js";
import { WorkspaceRuntimeProxy } from "./runtime-proxy.js";
import { validOpenCodeNativeHeader } from "../coding/bundled-opencode.js";
import { detectInstalledRuntimes, inspectLocalRuntime, type DetectionOptions, type DetectedRuntime } from "./runtime-detect.js";
import { WorkspaceRuntimeVersionStore, projectRuntimeVersionStatus, type RuntimeVersionCurrent } from "./runtime-version-history.js";

export type OptionalRuntimeId = "opencode" | "codex" | "claude" | "agy" | "gemini" | "kimi";
export interface RuntimeTarget { platform: NodeJS.Platform; arch: string }
export interface RuntimeArtifact { runtimeId: OptionalRuntimeId; version: string; target: RuntimeTarget; url: string;
  sha256: string; format: "raw" | "tar.gz" | "zip"; member: string | null; maxBytes: number }
interface Registration { artifact: RuntimeArtifact; executableSha256: string; bytes: number; installedAt: string }
/**
 * Which CLI login a bound runtime launches with.
 *
 * - `host` (default for new bindings): use the OS account home so a runtime the user
 *   already logged into works immediately. Hara never copies or links the host credential into its
 *   private runtime home; the child receives the OS account home explicitly.
 * - `isolated`: the historical behaviour — `HOME`/`CODEX_HOME` point at this Workspace's private
 *   `runtime-homes/<id>` directory, so the user signs in again inside Hara.
 *
 * The record is stored per binding so switching back to `isolated` stays available to anyone who wants
 * the separated home. A missing record means `isolated`: older state files never gain host access
 * without an explicit, confirmed switch.
 */
export type RuntimeLoginSource = "host" | "isolated";
export interface RuntimeLoginBinding { runtimeId: OptionalRuntimeId; source: RuntimeLoginSource; confirmedAt: string }
interface InstallState { resourceBinding: WorkspaceResourceBinding; revision: number; entries: Registration[]; loginSources: RuntimeLoginBinding[] }
interface LocalState { resourceBinding: WorkspaceResourceBinding; revision: number; entries: DetectedRuntime[]; loginSources: RuntimeLoginBinding[] }
export interface RuntimeInstallCard { id: string; runtimeId: OptionalRuntimeId; label: string; version: string;
  origin: string; sha256: string; maxBytes: number; expiresAt: string; target: RuntimeTarget }
interface Proposal { card: RuntimeInstallCard; artifact: RuntimeArtifact; controllerId: string; assertCurrent(): void; assertInstallCurrent(): void }
interface Operation { id: string; runtimeId: OptionalRuntimeId; state: "downloading" | "registered" | "cancelled" | "failed"; controller: AbortController }
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const HASH = /^[a-f0-9]{64}$/;
const MAX_HOST_CACHE_BYTES = 4 * 1024 * 1024;
/** A host file is not Hara state, so it cannot use the private-state binder. It still refuses links and
 * anything but a plain regular file, and never creates, repairs or rewrites the path. */
function readOptionalHostText(path: string, maxBytes: number): string | null {
  let before;
  try { before = lstatSync(path); } catch { return null; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size <= 0 || before.size > maxBytes) return null;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1 || opened.size !== before.size) return null;
    const chunks: Buffer[] = []; let total = 0; const chunk = Buffer.alloc(64 * 1024);
    for (;;) {
      const length = readSync(fd, chunk, 0, chunk.length, null);
      if (!length) break;
      total += length;
      if (total > maxBytes) return null;
      chunks.push(Buffer.from(chunk.subarray(0, length)));
    }
    if (total !== before.size) return null;
    return Buffer.concat(chunks).toString("utf8");
  } catch { return null; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ } }
}
const fail = (): never => { throw new Error("Runtime installation unavailable or unsafe; no global configuration was changed"); };
export const optionalRuntimeId = (value: unknown): value is OptionalRuntimeId => typeof value === "string" && OPTIONAL_RUNTIMES.includes(value as OptionalRuntimeId);
const LOGIN_SOURCE_FIELDS = ["runtimeId", "source", "confirmedAt"] as const;
const isLoginSource = (value: unknown): value is RuntimeLoginSource => value === "host" || value === "isolated";
const validConfirmedAt = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

/** Legacy state files carry no `loginSources`. They stay isolated: host credentials are never granted
 * by a migration the user did not confirm. Unknown or malformed records fail closed instead of being
 * dropped, so a damaged file cannot silently widen credential scope. */
function parseLoginSources(value: unknown): RuntimeLoginBinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > OPTIONAL_RUNTIMES.length) return fail();
  const seen = new Set<string>();
  return value.map(row => {
    if (!plain(row) || !exact(row, [...LOGIN_SOURCE_FIELDS]) || !optionalRuntimeId(row.runtimeId)
      || seen.has(row.runtimeId) || !isLoginSource(row.source) || !validConfirmedAt(row.confirmedAt)) return fail();
    seen.add(row.runtimeId);
    return { runtimeId: row.runtimeId, source: row.source, confirmedAt: row.confirmedAt };
  });
}

/** Workspace-bound installation registry, NOT a claim that a general-Agent driver is implemented.
 * Host-only fixture resolver/fetch policy cannot be supplied by RPC, model tools or downloaded metadata. */
export class WorkspaceRuntimeInstaller {
  readonly proxy: WorkspaceRuntimeProxy;
  private readonly state: WorkspaceJsonState<InstallState>;
  private readonly locals: WorkspaceJsonState<LocalState>;
  private detected: DetectedRuntime[] = [];
  private discovery?: Promise<void>;
  private readonly proposals = new Map<string, Proposal>();
  private readonly operations = new Map<string, Operation>();
  private readonly active = new Map<OptionalRuntimeId, Operation>();
  private readonly metadata = new Set<AbortController>();
  private readonly target: RuntimeTarget;
  private closed = false;
  private readonly nativeResources = new Set<() => Promise<void>>();
  /** Host-owned native sessions share this installer's lifetime, including non-Host harnesses. */
  ownNativeResource(close: () => Promise<void>): void {
    if (this.closed) throw new Error("Workspace runtime installer is closed");
    this.nativeResources.add(close);
  }
  constructor(private readonly storage: WorkspaceResourceStorage, private readonly options: {
    target?: RuntimeTarget;
    fixtureOrigin?: string;
    resolveArtifact?: (id: OptionalRuntimeId, target: RuntimeTarget, signal?: AbortSignal) => Promise<RuntimeArtifact>;
    onChange?: () => void;
    discovery?: DetectionOptions;
    /** Test-only OS account home seam; production always calls userInfo().homedir. */
    accountHome?: () => string;
  } = {}) {
    this.proxy = new WorkspaceRuntimeProxy(storage);
    this.target = Object.freeze({ platform: options.target?.platform ?? process.platform, arch: options.target?.arch ?? process.arch });
    if (options.fixtureOrigin) { const url = new URL(options.fixtureOrigin); if (url.origin !== options.fixtureOrigin || url.protocol !== "http:" || url.hostname !== "127.0.0.1") fail(); }
    const binding = () => this.state.binding();
    this.state = new WorkspaceJsonState<InstallState>(storage, "runtime-installations-v1.json", value => {
      if (!plain(value) || !exact(value, ["resourceBinding", "revision", "entries", ...(value.loginSources === undefined ? [] : ["loginSources"])])
        || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, binding())
        || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
        || !Array.isArray(value.entries) || value.entries.length > 64) return fail();
      const seen = new Set<string>();
      for (const row of value.entries) {
        if (!plain(row) || !exact(row, ["artifact", "executableSha256", "bytes", "installedAt"]) || typeof row.executableSha256 !== "string" || !HASH.test(row.executableSha256)
          || !Number.isSafeInteger(row.bytes) || Number(row.bytes) < 64 || Number(row.bytes) > 512 * 1024 * 1024 || typeof row.installedAt !== "string" || !Number.isFinite(Date.parse(row.installedAt))) return fail();
        const artifact = this.validateArtifact(row.artifact), key = `${artifact.runtimeId}:${artifact.version}:${artifact.sha256}`;
        if (seen.has(key)) return fail(); seen.add(key);
      }
      return { ...structuredClone(value), loginSources: parseLoginSources(value.loginSources) } as unknown as InstallState;
    }, () => ({ resourceBinding: binding(), revision: 0, entries: [], loginSources: [] }));
    this.locals = new WorkspaceJsonState<LocalState>(storage, "runtime-local-v1.json", value => {
      if (!plain(value) || !exact(value, ["resourceBinding", "revision", "entries", ...(value.loginSources === undefined ? [] : ["loginSources"])])
        || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, this.state.binding())
        || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || !Array.isArray(value.entries) || value.entries.length > OPTIONAL_RUNTIMES.length) return fail();
      const seen = new Set<string>();
      for (const row of value.entries) {
        if (!plain(row) || !optionalRuntimeId(row.runtimeId) || seen.has(row.runtimeId) || !exact(row, ["runtimeId", "path", "realPath", "version", "fingerprint", "source"])
          || typeof row.path !== "string" || typeof row.realPath !== "string" || typeof row.version !== "string" || typeof row.source !== "string" || typeof row.fingerprint !== "string" || !HASH.test(row.fingerprint)) return fail();
        seen.add(row.runtimeId);
      }
      return { ...structuredClone(value), loginSources: parseLoginSources(value.loginSources) } as unknown as LocalState;
    }, () => ({ resourceBinding: this.state.binding(), revision: 0, entries: [], loginSources: [] }));
  }
  async discover(): Promise<void> {
    if (this.closed || !this.options.discovery) return;
    if (!this.discovery) this.discovery = (async () => {
      this.storage.run(() => {});
      const found = await detectInstalledRuntimes(this.options.discovery!);
      if (this.closed) return;
      this.storage.run(() => {}); this.detected = found;
    })().finally(() => { this.discovery = undefined; });
    return this.discovery;
  }
  registerLocal(runtimeId: OptionalRuntimeId, fingerprint: string, loginSource: RuntimeLoginSource = runtimeId === "agy" ? "isolated" : "host"): void {
    if (this.closed) return fail();
    // A confirmed legacy binding may switch login source after restart, before a fresh discovery.
    // Its stored path and fingerprint are re-inspected just like a newly detected binary.
    const found = this.detected.find(row => row.runtimeId === runtimeId && row.fingerprint === fingerprint)
      ?? this.locals.read().entries.find(row => row.runtimeId === runtimeId && row.fingerprint === fingerprint);
    const current = found && inspectLocalRuntime(found.path, true);
    if (!found || !current || current.realPath !== found.realPath || current.fingerprint !== fingerprint) return fail();
    if (!isLoginSource(loginSource) || runtimeId === "agy" && loginSource !== "isolated"
      || ["opencode", "gemini", "kimi"].includes(runtimeId) && loginSource !== "host") return fail();
    if (loginSource === "isolated" && runtimeId === "codex") this.privateHome(runtimeId);
    const state = this.locals.read();
    this.locals.update(state.revision, value => ({ ...value, entries: [...value.entries.filter(row => row.runtimeId !== runtimeId), found],
      loginSources: [...value.loginSources.filter(row => row.runtimeId !== runtimeId),
        { runtimeId, source: loginSource, confirmedAt: new Date().toISOString() }] }));
  }
  /** Which stored login this binding launches with. Absent means the legacy isolated home. */
  loginSource(runtimeId: OptionalRuntimeId): RuntimeLoginSource {
    if (!optionalRuntimeId(runtimeId)) return "isolated";
    return this.locals.read().loginSources.find(row => row.runtimeId === runtimeId)?.source
      ?? this.state.read().loginSources.find(row => row.runtimeId === runtimeId)?.source ?? "isolated";
  }
  /**
   * Explicit, confirmed switch between the host login and this Workspace's private home.
   * Core records the decision; the renderer's confirmation card is the human gate. Re-registering the
   * same fingerprint is the only way a legacy isolated binding can gain host access.
   */
  setLoginSource(runtimeId: unknown, source: unknown): RuntimeLoginSource {
    if (!optionalRuntimeId(runtimeId) || !isLoginSource(source) || runtimeId === "agy" && source !== "isolated"
      || ["opencode", "gemini", "kimi"].includes(runtimeId) && source !== "host") throw new Error("Invalid runtime login source");
    const local = this.locals.read().entries.some(row => row.runtimeId === runtimeId);
    if (!local && !this.state.read().entries.some(row => row.artifact.runtimeId === runtimeId)) return fail();
    if (source === "isolated" && runtimeId === "codex") this.privateHome(runtimeId);
    const record = (current: { loginSources: RuntimeLoginBinding[] }) => [...current.loginSources.filter(row => row.runtimeId !== runtimeId),
      { runtimeId, source, confirmedAt: new Date().toISOString() }];
    if (local) {
      const current = this.locals.read();
      this.locals.update(current.revision, value => ({ ...value, loginSources: record(value) }));
    } else {
      const current = this.state.read();
      this.state.update(current.revision, value => ({ ...value, loginSources: record(value) }));
    }
    return source;
  }
  private privateHome(runtimeId: OptionalRuntimeId): string {
    return this.storage.run(() => {
      const home = workspaceResourceDirectory(["runtime-homes", runtimeId]);
      // Codex cannot populate its inventory when CODEX_HOME is only an uncreated path.
      // Use the same link-rejecting Workspace namespace as HOME; never project the user's .codex.
      if (runtimeId === "codex") workspaceResourceDirectory(["runtime-homes", runtimeId, ".codex"]);
      return home;
    });
  }
  /** Bun's os.userInfo() follows HOME on macOS; query the passwd record independently. */
  private accountHome(): string {
    let home: string;
    if (this.options.accountHome) home = this.options.accountHome();
    else if (process.platform === "darwin") {
      const uid = process.geteuid?.();
      if (uid === undefined) return fail();
      let fields: string[];
      try {
        fields = execFileSync("/usr/bin/id", ["-P"], { encoding: "utf8", timeout: 1500,
          maxBuffer: 4096, env: { PATH: "/usr/bin:/bin" } }).trim().split(":");
      } catch { return fail(); }
      if (fields.length !== 10 || fields[2] !== String(uid)) return fail();
      home = fields[8]!;
    } else home = this.options.discovery?.home ?? userInfo().homedir;
    if (!isAbsolute(home) || home === "/" || /[\u0000-\u001f\u007f]/.test(home)) return fail();
    return home;
  }
  /** Launch a host-bound runtime with the account login directory, without copying credentials. */
  private hostEnv(command: string): NodeJS.ProcessEnv {
    const { CODEX_HOME: _codexHome, CLAUDE_CONFIG_DIR: _claudeConfigDir, GEMINI_CLI_HOME: _geminiHome,
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: _geminiSettings, GEMINI_CLI_SYSTEM_DEFAULTS_PATH: _geminiDefaults,
      GEMINI_CLI_TRUSTED_FOLDERS_PATH: _geminiTrust, GEMINI_SANDBOX: _geminiSandbox, KIMI_SHARE_DIR: _kimiShare, KIMI_CODE_HOME: _kimiCodeHome, ...ambient } = process.env;
    const home = this.accountHome();
    return {
      ...ambient,
      HOME: home, USERPROFILE: home,
      PATH: `${dirname(command)}:${this.options.discovery?.path ?? ambient.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`,
      DISABLE_AUTOUPDATER: "1", HARA_UPDATE_CHECK: "0",
    };
  }
  private resolveLocalUnproxied(runtimeId: OptionalRuntimeId): { command: string; env: NodeJS.ProcessEnv; loginSource: RuntimeLoginSource } {
    const row = this.locals.read().entries.find(row => row.runtimeId === runtimeId), checked = row && inspectLocalRuntime(row.path, true);
    if (!row || !checked || checked.realPath !== row.realPath || checked.fingerprint !== row.fingerprint) return fail();
    if (runtimeId === "agy") return { command: row.path, env: { HOME: this.options.discovery?.home ?? userInfo().homedir,
      USERPROFILE: this.options.discovery?.home ?? userInfo().homedir, PATH: `${dirname(row.path)}:${this.options.discovery?.path ?? process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`,
      DISABLE_AUTOUPDATER: "1", HARA_UPDATE_CHECK: "0" }, loginSource: "isolated" };
    const loginSource = this.loginSource(runtimeId);
    if (["opencode", "gemini", "kimi"].includes(runtimeId) && loginSource !== "host") return fail();
    if (loginSource === "host") return { command: row.path, env: this.hostEnv(row.path), loginSource };
    const privateHome = this.privateHome(runtimeId);
    return { command: row.path, env: { HOME: privateHome, USERPROFILE: privateHome, CODEX_HOME: join(privateHome, ".codex"),
      CLAUDE_CONFIG_DIR: join(privateHome, ".claude"), PATH: `${dirname(row.path)}:${this.options.discovery?.path ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`,
      DISABLE_AUTOUPDATER: "1", HARA_UPDATE_CHECK: "0" }, loginSource };
  }
  resolveLocal(runtimeId: OptionalRuntimeId) {
    const resolved = this.resolveLocalUnproxied(runtimeId);
    return { ...resolved, env: this.proxy.apply(resolved.env) };
  }
  /** Check only an explicit Workspace proxy, then revalidate the registered binary at physical launch. */
  /** The bundled Pi has no external login and never receives this account's credentials. */
  async prepareBuiltinPi(signal?: AbortSignal): Promise<{ accountHome: string; proxyUrl: string | null }> {
    const checked = await this.proxy.check(signal);
    return { accountHome: realpathSync.native(this.accountHome()), proxyUrl: checked.proxyUrl };
  }
  async prepareBound(runtimeId: OptionalRuntimeId, signal?: AbortSignal) {
    const checked = await this.proxy.check(signal), resolved = this.resolveBoundUnproxied(runtimeId);
    return { ...resolved, env: this.proxy.applyChecked(resolved.env, checked), proxyUrl: checked.proxyUrl };
  }
  resolveBound(runtimeId: OptionalRuntimeId) {
    const resolved = this.resolveBoundUnproxied(runtimeId);
    return { ...resolved, env: this.proxy.apply(resolved.env) };
  }
  private resolveBoundUnproxied(runtimeId: OptionalRuntimeId): { command: string; env: NodeJS.ProcessEnv; loginSource: RuntimeLoginSource } {
    if (this.locals.read().entries.some(row => row.runtimeId === runtimeId)) return this.resolveLocalUnproxied(runtimeId);
    const installed = this.state.read().entries.filter(row => row.artifact.runtimeId === runtimeId).at(-1);
    if (!installed) return fail();
    return this.resolveUnproxied(runtimeId, installed.artifact.version, installed.artifact.sha256);
  }
  /** Host-attested directories, revalidated against the exact installed command and login selection. */
  executionPolicyDirectories(runtimeId: "codex" | "claude" | "opencode" | "gemini" | "kimi",
    launched: { command: string; env: NodeJS.ProcessEnv; loginSource: RuntimeLoginSource }) {
    const current = this.resolveBoundUnproxied(runtimeId);
    if (current.command !== launched.command || current.loginSource !== launched.loginSource || current.env.HOME !== launched.env.HOME
      || current.env.CODEX_HOME !== launched.env.CODEX_HOME || current.env.CLAUDE_CONFIG_DIR !== launched.env.CLAUDE_CONFIG_DIR) return fail();
    const accountHome = this.accountHome(), home = current.env.HOME; if (!home) return fail();
    const runtimeHome = runtimeId === "claude" ? current.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude")
      : runtimeId === "codex" ? current.env.CODEX_HOME ?? join(home, ".codex")
      : runtimeId === "gemini" ? join(home, ".gemini") : runtimeId === "kimi" ? join(home, ".kimi")
      : join(current.env.XDG_DATA_HOME ?? join(home, ".local/share"), "opencode");
    return Object.freeze({ accountHome, runtimeHome, protectedStateRoots: Object.freeze([this.storage.runtimeProtectedStateRoot()]) });
  }
  /** Diagnostic metadata only: no login files, environment dump, paths or version probe. */
  failureContext(runtimeId: "codex" | "claude" | "opencode" | "gemini" | "kimi",
    launched?: { env: NodeJS.ProcessEnv; loginSource: RuntimeLoginSource }): RuntimeFailureContext {
    let version: string | null = null, loginSource: RuntimeFailureContext["loginSource"] = "unknown";
    try {
      const local = this.locals.read().entries.find(row => row.runtimeId === runtimeId);
      version = local?.version ?? this.state.read().entries.filter(row => row.artifact.runtimeId === runtimeId).at(-1)?.artifact.version ?? null;
      loginSource = launched?.loginSource ?? this.loginSource(runtimeId);
    } catch { /* unavailable metadata is unknown, never proof of a missing login */ }
    let homeMatchesAccount: boolean | null = null;
    if (launched?.env.HOME) {
      try {
        const comparable = (path: string) => process.platform === "win32" ? realpathSync(resolve(path)).toLowerCase() : realpathSync(resolve(path));
        homeMatchesAccount = comparable(launched.env.HOME) === comparable(this.accountHome());
      } catch { /* account lookup failure is not a mismatched home */ }
    }
    return { runtime: runtimeId, version, loginSource, homeMatchesAccount,
      ...(runtimeId === "kimi" ? { extensionsIsolation: "inherited" as const } : {}) };
  }
  /**
   * Read-only snapshot of the host's own Codex model cache, only while this binding launches with the
   * host login. The file is read through the same no-follow/no-hardlink checks as private state, but it
   * is never copied into `runtime-homes/*` and never written; a missing or unsafe file simply yields null.
   */
  hostCodexModelCache(): string | null {
    if (this.loginSource("codex") !== "host") return null;
    this.resolveBound("codex"); // revalidate the current registration before reading host metadata
    const root = join(this.accountHome(), ".codex");
    try {
      if (!isAbsolute(root) || /[\u0000-\u001f\u007f]/.test(root)) return null;
      return readOptionalHostText(join(root, "models_cache.json"), MAX_HOST_CACHE_BYTES);
    } catch { return null; }
  }
  /** Read-only login guidance for the registered executable and this Workspace's private home.
   * No login is launched and no global auth/config is read or projected. */
  codexLoginInstructions(): { runtimeId: "codex"; shell: "posix" | "powershell"; command: string } {
    const { command, env, loginSource } = this.resolveBound("codex");
    // Host mode reuses the machine login; there is nothing to sign in again for, and returning a
    // command that re-points HOME would quietly contradict the mode the user confirmed.
    if (loginSource === "host") throw new Error("Codex reuses the host login; no separate sign-in is required");
    const quote = (value: string) => "'" + value.replaceAll("'", process.platform === "win32" ? "''" : "'\"'\"'") + "'";
    const values = ["HOME", "USERPROFILE", "CODEX_HOME"] as const;
    if (values.some(key => !env[key] || /[\r\n\0]/.test(env[key]!)) || /[\r\n\0]/.test(command)) return fail();
    const login = process.platform === "win32"
      ? values.map(key => `$env:${key}=${quote(env[key]!)}`).join("; ") + `; & ${quote(command)} login`
      : "env " + values.map(key => `${key}=${quote(env[key]!)}`).join(" ") + ` ${quote(command)} login`;
    return { runtimeId: "codex", shell: process.platform === "win32" ? "powershell" : "posix", command: login };
  }
  private assertUrl(raw: string): URL {
    const url = new URL(raw);
    if (url.username || url.password || url.hash || url.href.length > 8192) return fail();
    if (this.options.fixtureOrigin && url.origin === this.options.fixtureOrigin) return url;
    if (url.protocol !== "https:" || url.port || !RUNTIME_DOWNLOAD_HOSTS.includes(url.hostname as typeof RUNTIME_DOWNLOAD_HOSTS[number])) return fail();
    return url;
  }
  private validateArtifact(value: unknown): RuntimeArtifact {
    if (!plain(value) || !exact(value, ["runtimeId", "version", "target", "url", "sha256", "format", "member", "maxBytes"])
      || !optionalRuntimeId(value.runtimeId) || value.runtimeId === "agy" || typeof value.version !== "string" || !/^\d+\.\d+\.\d+$/.test(value.version)
      || !plain(value.target) || !exact(value.target, ["platform", "arch"]) || value.target.platform !== this.target.platform || value.target.arch !== this.target.arch
      || typeof value.url !== "string" || typeof value.sha256 !== "string" || !HASH.test(value.sha256)
      || !["raw", "tar.gz", "zip"].includes(String(value.format)) || (value.member !== null && (typeof value.member !== "string" || !/^[A-Za-z0-9_.+/-]{1,200}$/.test(value.member)))
      || !Number.isSafeInteger(value.maxBytes) || Number(value.maxBytes) < 64 || Number(value.maxBytes) > 256 * 1024 * 1024) return fail();
    const url = this.assertUrl(value.url);
    // Persist only the public immutable origin URL, never redirect credentials/signed URLs.
    if (url.search) return fail();
    return structuredClone(value) as unknown as RuntimeArtifact;
  }
  private async download(url: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    const deadline = AbortSignal.timeout(120000), bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let next = url;
    for (let redirects = 0; redirects <= 3; redirects++) {
      this.storage.run(() => {}); this.assertUrl(next);
      const response = await fetch(next, { signal: bounded, redirect: "manual", headers: { "User-Agent": "Hara-runtime-installer", "Accept": "application/octet-stream, application/json" } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location"); await response.body?.cancel();
        if (!location || redirects === 3) return fail(); next = new URL(location, next).href; continue;
      }
      if (!response.ok || !response.body) return fail();
      const length = response.headers.get("content-length");
      if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) { await response.body.cancel(); return fail(); }
      const chunks: Buffer[] = []; let bytes = 0;
      try {
        for await (const chunk of response.body) { bytes += chunk.length; if (bytes > maxBytes) throw new Error("Runtime download exceeded limit"); chunks.push(Buffer.from(chunk)); }
      } catch { await response.body.cancel().catch(() => {}); return fail(); }
      if (!bytes || length && bytes !== Number(length)) return fail();
      return Buffer.concat(chunks);
    }
    return fail();
  }
  async propose(runtimeId: OptionalRuntimeId, controllerId: string, assertCurrent: () => void, assertInstallCurrent = () => this.storage.run(() => {})): Promise<RuntimeInstallCard> {
    if (manualRuntimeInstallation(runtimeId)) throw new Error("This runtime requires manual installation using its official guide; detect and register it afterward");
    if (runtimeId === "agy") throw new Error("Antigravity is local registration only; no official download is configured");
    await this.discover();
    if (this.detected.some(row => row.runtimeId === runtimeId && inspectLocalRuntime(row.path))) throw new Error("A local installation is already available; confirm registration instead of downloading");
    for (const [id, proposal] of this.proposals) if (Date.parse(proposal.card.expiresAt) <= Date.now()) this.proposals.delete(id);
    if (this.closed || !optionalRuntimeId(runtimeId) || this.proposals.size + this.metadata.size >= 16) return fail(); assertCurrent();
    const controller = new AbortController(); this.metadata.add(controller);
    let descriptor: RuntimeArtifact;
    try { descriptor = this.options.resolveArtifact
      ? await this.options.resolveArtifact(runtimeId, this.target, controller.signal)
      : await resolveOfficialRuntimeArtifact(runtimeId, this.target, this.download.bind(this), controller.signal); }
    finally { this.metadata.delete(controller); }
    if (this.closed) return fail(); assertCurrent(); const artifact = this.validateArtifact(descriptor);
    if (artifact.runtimeId !== runtimeId) return fail();
    const card: RuntimeInstallCard = Object.freeze({ id: randomUUID(), runtimeId, label: RUNTIME_LABELS[runtimeId], version: artifact.version,
      origin: new URL(artifact.url).origin, sha256: artifact.sha256, maxBytes: artifact.maxBytes,
      target: this.target, expiresAt: new Date(Date.now() + 5 * 60000).toISOString() });
    this.proposals.set(card.id, { card, artifact: Object.freeze(artifact), controllerId, assertCurrent, assertInstallCurrent }); return card;
  }
  approve(id: string, approved: boolean, controllerId: string, loginSource: RuntimeLoginSource = "host"): { operationId: string | null; state: string } {
    if (this.closed || typeof approved !== "boolean" || !UUID.test(id) || !isLoginSource(loginSource)) return fail();
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.controllerId !== controllerId || Date.parse(proposal.card.expiresAt) <= Date.now()) return fail();
    proposal.assertCurrent();
    if (approved && proposal.card.runtimeId === "agy" && loginSource !== "isolated") throw new Error("Agy requires isolated login");
    if (approved && ["opencode", "gemini", "kimi"].includes(proposal.card.runtimeId) && loginSource !== "host") throw new Error("This runtime requires host login");
    this.proposals.delete(id); // single use, including a refusal
    if (!approved) return { operationId: null, state: "declined" };
    if (this.active.has(proposal.card.runtimeId)) throw new Error("Runtime installation is already active; do not resend");
    for (const [id, prior] of this.operations) if (this.operations.size >= 64 && prior.state !== "downloading") this.operations.delete(id);
    const operation: Operation = { id: randomUUID(), runtimeId: proposal.card.runtimeId, state: "downloading", controller: new AbortController() };
    this.operations.set(operation.id, operation); this.active.set(operation.runtimeId, operation);
    void this.install(proposal, operation, loginSource).finally(() => {
      this.active.delete(operation.runtimeId);
      try { this.options.onChange?.(); } catch { /* A disconnected observer cannot invalidate a durable outcome. */ }
    });
    return { operationId: operation.id, state: operation.state };
  }
  dismiss(controllerId: string): void { for (const [id, p] of this.proposals) if (p.controllerId === controllerId) this.proposals.delete(id); }
  cancel(operationId: string): void { const operation = this.operations.get(operationId); if (operation?.state === "downloading") operation.controller.abort(); }
  private directory(artifact: RuntimeArtifact): string {
    return this.storage.run(() => workspaceResourceDirectory(["runtime-installations", artifact.runtimeId, artifact.version, artifact.sha256]));
  }
  private inspect(artifact: RuntimeArtifact, expected?: Registration): { path: string; bytes: Buffer } | undefined {
    const directory = this.directory(artifact), path = join(directory, artifact.target.platform === "win32" ? `${artifact.runtimeId}.exe` : artifact.runtimeId);
    let fd: number | undefined;
    try {
      let before; try { before = lstatSync(path); } catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; }
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 64 || before.size > 512 * 1024 * 1024
        || process.platform !== "win32" && (before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o500)) return fail();
      fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1 || opened.mode !== before.mode) return fail();
      const chunks: Buffer[] = []; let total = 0; const chunk = Buffer.alloc(1024 * 1024);
      for (;;) { const length = readSync(fd, chunk, 0, chunk.length, null); if (!length) break; total += length; if (total > before.size) return fail(); chunks.push(Buffer.from(chunk.subarray(0, length))); }
      const bytes = Buffer.concat(chunks), after = lstatSync(path), read = fstatSync(fd);
      if (total !== before.size || [opened, read, after].some(row => row.dev !== before.dev || row.ino !== before.ino || row.nlink !== 1 || row.size !== before.size
        || row.mode !== before.mode || row.mtimeMs !== before.mtimeMs || row.ctimeMs !== before.ctimeMs)
        || expected && (bytes.length !== expected.bytes || hash(bytes) !== expected.executableSha256)
        || !validOpenCodeNativeHeader(bytes, artifact.target.platform, artifact.target.arch)) return fail();
      this.storage.run(() => {}); return { path, bytes };
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  private async install(proposal: Proposal, operation: Operation, loginSource: RuntimeLoginSource): Promise<void> {
    try {
      const { artifact } = proposal, signal = operation.controller.signal;
      proposal.assertInstallCurrent();
      const archive = await this.download(artifact.url, artifact.maxBytes, signal);
      proposal.assertInstallCurrent(); signal.throwIfAborted(); if (hash(archive) !== artifact.sha256) return fail();
      const bytes = runtimeArchiveMember(archive, artifact.format, artifact.member);
      if (!validOpenCodeNativeHeader(bytes, artifact.target.platform, artifact.target.arch)) return fail();
      const registration: Registration = { artifact, executableSha256: hash(bytes), bytes: bytes.length, installedAt: new Date().toISOString() };
      const prior = this.inspect(artifact);
      if (prior && hash(prior.bytes) !== registration.executableSha256) return fail();
      if (!prior) {
        const directory = this.directory(artifact), path = join(directory, artifact.target.platform === "win32" ? `${artifact.runtimeId}.exe` : artifact.runtimeId);
        // Never leave a partial executable at the registered path, and never overwrite another file.
        // A crash can retain an unregistered private stage; it is not executable through this registry.
        const stage = join(directory, `.download-${randomUUID()}`);
        const fd = openSync(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
        try {
          writeFileSync(fd, bytes); fsyncSync(fd); fchmodSync(fd, 0o500); fsyncSync(fd);
          proposal.assertInstallCurrent(); signal.throwIfAborted(); linkSync(stage, path);
        } finally { closeSync(fd); unlinkSync(stage); }
        const dirFd = openSync(directory, constants.O_RDONLY); try { if (process.platform !== "win32") fsyncSync(dirFd); } finally { closeSync(dirFd); }
      }
      proposal.assertInstallCurrent(); signal.throwIfAborted(); this.inspect(artifact, registration);
      const current = this.state.read();
      this.state.update(current.revision, value => ({ ...value,
        entries: value.entries.some(row => row.artifact.runtimeId === artifact.runtimeId && row.artifact.sha256 === artifact.sha256 && row.artifact.version === artifact.version)
          ? value.entries : [...value.entries, registration],
        loginSources: [...value.loginSources.filter(row => row.runtimeId !== artifact.runtimeId),
          { runtimeId: artifact.runtimeId, source: loginSource, confirmedAt: new Date().toISOString() }] }));
      operation.state = "registered";
    } catch { operation.state = operation.controller.signal.aborted ? "cancelled" : "failed"; }
  }
  /** Capture the already trusted executable at the physical launch. This closure is Host-only
   * diagnostic bookkeeping; it cannot register a binary or turn a discovered version into trust. */
  captureSuccessfulUse(runtimeId: OptionalRuntimeId, command: string): () => void {
    let before: ReturnType<WorkspaceRuntimeInstaller["boundVersionIdentity"]> = null;
    try { before = this.boundVersionIdentity(runtimeId); } catch { /* optional history */ }
    if (!before || before.command !== command) return () => {};
    const captured = before;
    return () => {
      if (this.closed) return;
      try {
        const current = this.boundVersionIdentity(runtimeId);
        if (!current || current.command !== captured.command || current.realPath !== captured.realPath
          || current.fingerprint !== captured.fingerprint || current.version !== captured.version) return;
        new WorkspaceRuntimeVersionStore(this.storage).recordSuccessfulUse(runtimeId, captured.version, captured.fingerprint);
      } catch { /* Damaged/stale history is preserved and never changes an execution result. */ }
    };
  }
  private boundVersionIdentity(runtimeId: OptionalRuntimeId): { command: string; realPath: string; version: string | null; fingerprint: string } | null {
    if (!optionalRuntimeId(runtimeId)) return null;
    const version = (value: string) => value === value.trim() && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value) ? value : null;
    const local = this.locals.read().entries.find(row => row.runtimeId === runtimeId);
    if (local) {
      const checked = inspectLocalRuntime(local.path, true);
      if (!checked || checked.realPath !== local.realPath || checked.fingerprint !== local.fingerprint) return null;
      return { command: local.path, realPath: checked.realPath, version: version(local.version), fingerprint: checked.fingerprint };
    }
    const installed = this.state.read().entries.filter(row => row.artifact.runtimeId === runtimeId).at(-1);
    const checked = installed && this.inspect(installed.artifact, installed);
    return installed && checked ? { command: checked.path, realPath: checked.path,
      version: version(installed.artifact.version), fingerprint: installed.executableSha256 } : null;
  }
  private versionProjection() {
    let history: ReturnType<WorkspaceRuntimeVersionStore["list"]> | null;
    try { history = new WorkspaceRuntimeVersionStore(this.storage).list(); } catch { history = null; }
    return (runtimeId: OptionalRuntimeId, current: RuntimeVersionCurrent) => {
      const projected = projectRuntimeVersionStatus(history?.find(row => row.runtimeId === runtimeId) ?? null, current);
      return history === null ? { ...projected, change: "unknown" as const, compatibility: "unknown" as const } : projected;
    };
  }
  list() {
    const value = this.state.read(), locals = this.locals.read(), versionStatus = this.versionProjection();
    // Local registrations win over an older downloaded install, so their recorded source is the
    // effective one; merge in that same order instead of letting a stale record shadow it.
    const loginSources = [...locals.loginSources, ...value.loginSources.filter(row => !locals.loginSources.some(prior => prior.runtimeId === row.runtimeId))];
    return { revision: value.revision, builtIn: "pi", options: OPTIONAL_RUNTIMES.map(runtimeId => {
      const local = locals.entries.find(row => row.runtimeId === runtimeId), detected = this.detected.find(row => row.runtimeId === runtimeId);
      const loginSource = loginSources.find(row => row.runtimeId === runtimeId)?.source ?? "isolated";
      if (local || detected) {
        const localCheck = local && inspectLocalRuntime(local.path);
        const registered = Boolean(local && localCheck && localCheck.realPath === local.realPath && localCheck.fingerprint === local.fingerprint);
        const detectedCheck = detected && inspectLocalRuntime(detected.path);
        const discovered = Boolean(detected && detectedCheck && detectedCheck.realPath === detected.realPath && detectedCheck.fingerprint === detected.fingerprint);
        // A newly discovered replacement may be explained/confirmed, but the old binding still
        // refuses it until registerLocal receives a new explicit human confirmation.
        const selected = registered ? local! : discovered ? detected! : local ?? detected!;
        const inspected = registered ? localCheck : discovered ? detectedCheck : localCheck ?? detectedCheck;
        const valid = registered || discovered, version = valid ? selected.version : null;
        return { runtimeId, label: RUNTIME_LABELS[runtimeId], ...(runtimeId === "kimi" ? { extensionsIsolation: "inherited" as const } : {}), ...(manualRuntimeInstallation(runtimeId) ? { manualInstallation: manualRuntimeInstallation(runtimeId)! } : {}), installed: valid, registered, version,
          path: selected.path, fingerprint: valid ? selected.fingerprint : null, source: selected.source, loginSource,
          versionStatus: versionStatus(runtimeId, { version, fingerprint: inspected?.fingerprint ?? null,
            registered, requiresRetrust: !registered && Boolean(local || discovered) }),
          generalAgentDriverAvailable: Boolean(registered && (runtimeId === "codex" || runtimeId === "claude" || ["opencode", "gemini", "kimi"].includes(runtimeId) && loginSource === "host")), state: valid ? registered ? "local_registered" : "detected" : "integrity_failed" };
      }
      const installed = value.entries.filter(row => row.artifact.runtimeId === runtimeId).at(-1);
      let verified = false; if (installed) try { verified = Boolean(this.inspect(installed.artifact, installed)); } catch { /* tampering revokes use, never repair or fallback */ }
      const version = verified ? installed!.artifact.version : null;
      return { runtimeId, label: RUNTIME_LABELS[runtimeId], ...(runtimeId === "kimi" ? { extensionsIsolation: "inherited" as const } : {}), ...(manualRuntimeInstallation(runtimeId) ? { manualInstallation: manualRuntimeInstallation(runtimeId)! } : {}), installed: verified, registered: verified, version,
        versionStatus: versionStatus(runtimeId, { version, fingerprint: verified ? installed!.executableSha256 : null,
          registered: verified, requiresRetrust: Boolean(installed && !verified) }),
        loginSource, generalAgentDriverAvailable: Boolean(verified && (runtimeId === "codex" || runtimeId === "claude" || ["opencode", "gemini", "kimi"].includes(runtimeId) && loginSource === "host")), state: installed ? verified ? "registered" : "integrity_failed" : "not_installed" };
    }), operations: [...this.operations.values()].slice(-64).map(({ controller: _c, ...row }) => row) };
  }
  private resolveUnproxied(runtimeId: OptionalRuntimeId, version: string, artifactSha256: string): { command: string; env: NodeJS.ProcessEnv; loginSource: RuntimeLoginSource } {
    if (runtimeId === "agy") return fail();
    const row = this.state.read().entries.find(row => row.artifact.runtimeId === runtimeId && row.artifact.version === version && row.artifact.sha256 === artifactSha256);
    if (!row) return fail(); const checked = this.inspect(row.artifact, row); if (!checked) return fail();
    const loginSource = this.loginSource(runtimeId);
    if (["opencode", "gemini", "kimi"].includes(runtimeId) && loginSource !== "host") return fail();
    if (loginSource === "host") return { command: checked.path, env: this.hostEnv(checked.path), loginSource };
    const privateHome = this.privateHome(runtimeId);
    return { command: checked.path, env: { HOME: privateHome, USERPROFILE: privateHome, CODEX_HOME: join(privateHome, ".codex"),
      CLAUDE_CONFIG_DIR: join(privateHome, ".claude"), XDG_CONFIG_HOME: join(privateHome, "config"), XDG_DATA_HOME: join(privateHome, "data"),
      XDG_CACHE_HOME: join(privateHome, "cache"), DISABLE_AUTOUPDATER: "1", HARA_UPDATE_CHECK: "0" }, loginSource };
  }
  resolve(runtimeId: OptionalRuntimeId, version: string, artifactSha256: string) {
    const resolved = this.resolveUnproxied(runtimeId, version, artifactSha256);
    return { ...resolved, env: this.proxy.apply(resolved.env) };
  }
  async close(): Promise<void> {
    this.closed = true; this.proposals.clear(); for (const operation of this.active.values()) operation.controller.abort();
    for (const controller of this.metadata) controller.abort();
    await Promise.all([...this.nativeResources].map(close => close())); this.nativeResources.clear();
    // Own downloads have a finite deadline; callers can observe incomplete drain rather than delete locks.
    const deadline = Date.now() + 5000;
    while ((this.active.size || this.metadata.size) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    if (this.active.size || this.metadata.size) throw new Error("Runtime downloads have not drained");
  }
}
