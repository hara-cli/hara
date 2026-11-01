import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { userInfo } from "node:os";
import { WorkspaceJsonState, exact, plain, UUID } from "./local-state.js";
import { sameWorkspaceResourceBinding, workspaceResourceDirectory, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import { OPTIONAL_RUNTIMES, RUNTIME_DOWNLOAD_HOSTS, RUNTIME_LABELS, resolveOfficialRuntimeArtifact } from "./runtime-catalog.js";
import { runtimeArchiveMember } from "./runtime-archive.js";
import { validOpenCodeNativeHeader } from "../coding/bundled-opencode.js";
import { detectInstalledRuntimes, inspectLocalRuntime, type DetectionOptions, type DetectedRuntime } from "./runtime-detect.js";

export type OptionalRuntimeId = "opencode" | "codex" | "claude" | "agy";
export interface RuntimeTarget { platform: NodeJS.Platform; arch: string }
export interface RuntimeArtifact { runtimeId: OptionalRuntimeId; version: string; target: RuntimeTarget; url: string;
  sha256: string; format: "raw" | "tar.gz" | "zip"; member: string | null; maxBytes: number }
interface Registration { artifact: RuntimeArtifact; executableSha256: string; bytes: number; installedAt: string }
interface InstallState { resourceBinding: WorkspaceResourceBinding; revision: number; entries: Registration[] }
export interface RuntimeInstallCard { id: string; runtimeId: OptionalRuntimeId; label: string; version: string;
  origin: string; sha256: string; maxBytes: number; expiresAt: string; target: RuntimeTarget }
interface Proposal { card: RuntimeInstallCard; artifact: RuntimeArtifact; controllerId: string; assertCurrent(): void; assertInstallCurrent(): void }
interface Operation { id: string; runtimeId: OptionalRuntimeId; state: "downloading" | "registered" | "cancelled" | "failed"; controller: AbortController }
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const HASH = /^[a-f0-9]{64}$/;
const fail = (): never => { throw new Error("Runtime installation unavailable or unsafe; no global configuration was changed"); };
export function optionalRuntimeId(value: unknown): value is OptionalRuntimeId { return typeof value === "string" && OPTIONAL_RUNTIMES.includes(value as OptionalRuntimeId); }

/** Workspace-bound installation registry, NOT a claim that a general-Agent driver is implemented.
 * Host-only fixture resolver/fetch policy cannot be supplied by RPC, model tools or downloaded metadata. */
export class WorkspaceRuntimeInstaller {
  private readonly state: WorkspaceJsonState<InstallState>;
  private readonly locals: WorkspaceJsonState<{ resourceBinding: WorkspaceResourceBinding; revision: number; entries: DetectedRuntime[] }>;
  private detected: DetectedRuntime[] = [];
  private discovery?: Promise<void>;
  private readonly proposals = new Map<string, Proposal>();
  private readonly operations = new Map<string, Operation>();
  private readonly active = new Map<OptionalRuntimeId, Operation>();
  private readonly metadata = new Set<AbortController>();
  private readonly target: RuntimeTarget;
  private closed = false;
  constructor(private readonly storage: WorkspaceResourceStorage, private readonly options: {
    target?: RuntimeTarget;
    fixtureOrigin?: string;
    resolveArtifact?: (id: OptionalRuntimeId, target: RuntimeTarget, signal?: AbortSignal) => Promise<RuntimeArtifact>;
    onChange?: () => void;
    discovery?: DetectionOptions;
  } = {}) {
    this.target = Object.freeze({ platform: options.target?.platform ?? process.platform, arch: options.target?.arch ?? process.arch });
    if (options.fixtureOrigin) { const url = new URL(options.fixtureOrigin); if (url.origin !== options.fixtureOrigin || url.protocol !== "http:" || url.hostname !== "127.0.0.1") fail(); }
    const binding = () => this.state.binding();
    this.state = new WorkspaceJsonState(storage, "runtime-installations-v1.json", value => {
      if (!plain(value) || !exact(value, ["resourceBinding", "revision", "entries"]) || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, binding())
        || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
        || !Array.isArray(value.entries) || value.entries.length > 64) return fail();
      const seen = new Set<string>();
      for (const row of value.entries) {
        if (!plain(row) || !exact(row, ["artifact", "executableSha256", "bytes", "installedAt"]) || typeof row.executableSha256 !== "string" || !HASH.test(row.executableSha256)
          || !Number.isSafeInteger(row.bytes) || Number(row.bytes) < 64 || Number(row.bytes) > 512 * 1024 * 1024 || typeof row.installedAt !== "string" || !Number.isFinite(Date.parse(row.installedAt))) return fail();
        const artifact = this.validateArtifact(row.artifact), key = `${artifact.runtimeId}:${artifact.version}:${artifact.sha256}`;
        if (seen.has(key)) return fail(); seen.add(key);
      }
      return structuredClone(value) as unknown as InstallState;
    }, () => ({ resourceBinding: binding(), revision: 0, entries: [] }));
    this.locals = new WorkspaceJsonState(storage, "runtime-local-v1.json", value => {
      if (!plain(value) || !exact(value, ["resourceBinding", "revision", "entries"]) || !sameWorkspaceResourceBinding(value.resourceBinding as WorkspaceResourceBinding, this.state.binding())
        || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1 || !Array.isArray(value.entries) || value.entries.length > 4) return fail();
      const seen = new Set<string>();
      for (const row of value.entries) {
        if (!plain(row) || !optionalRuntimeId(row.runtimeId) || seen.has(row.runtimeId) || !exact(row, ["runtimeId", "path", "realPath", "version", "fingerprint", "source"])
          || typeof row.path !== "string" || typeof row.realPath !== "string" || typeof row.version !== "string" || typeof row.source !== "string" || typeof row.fingerprint !== "string" || !HASH.test(row.fingerprint)) return fail();
        seen.add(row.runtimeId);
      }
      return structuredClone(value) as unknown as { resourceBinding: WorkspaceResourceBinding; revision: number; entries: DetectedRuntime[] };
    }, () => ({ resourceBinding: this.state.binding(), revision: 0, entries: [] }));
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
  registerLocal(runtimeId: OptionalRuntimeId, fingerprint: string): void {
    if (this.closed) return fail();
    const found = this.detected.find(row => row.runtimeId === runtimeId && row.fingerprint === fingerprint);
    const current = found && inspectLocalRuntime(found.path, true);
    if (!found || !current || current.realPath !== found.realPath || current.fingerprint !== fingerprint) return fail();
    if (runtimeId === "codex") this.privateHome(runtimeId);
    const state = this.locals.read();
    this.locals.update(state.revision, value => ({ ...value, entries: [...value.entries.filter(row => row.runtimeId !== runtimeId), found] }));
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
  resolveLocal(runtimeId: OptionalRuntimeId): { command: string; env: NodeJS.ProcessEnv } {
    const row = this.locals.read().entries.find(row => row.runtimeId === runtimeId), checked = row && inspectLocalRuntime(row.path, true);
    if (!row || !checked || checked.realPath !== row.realPath || checked.fingerprint !== row.fingerprint) return fail();
    if (runtimeId === "agy") return { command: row.path, env: { HOME: this.options.discovery?.home ?? userInfo().homedir,
      USERPROFILE: this.options.discovery?.home ?? userInfo().homedir, PATH: `${dirname(row.path)}:${this.options.discovery?.path ?? process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`,
      DISABLE_AUTOUPDATER: "1", HARA_UPDATE_CHECK: "0" } };
    const privateHome = this.privateHome(runtimeId);
    return { command: row.path, env: { HOME: privateHome, USERPROFILE: privateHome, CODEX_HOME: join(privateHome, ".codex"),
      CLAUDE_CONFIG_DIR: join(privateHome, ".claude"), PATH: `${dirname(row.path)}:${this.options.discovery?.path ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`,
      DISABLE_AUTOUPDATER: "1", HARA_UPDATE_CHECK: "0" } };
  }
  resolveBound(runtimeId: OptionalRuntimeId): { command: string; env: NodeJS.ProcessEnv } {
    if (this.locals.read().entries.some(row => row.runtimeId === runtimeId)) return this.resolveLocal(runtimeId);
    const installed = this.state.read().entries.filter(row => row.artifact.runtimeId === runtimeId).at(-1);
    if (!installed) return fail();
    return this.resolve(runtimeId, installed.artifact.version, installed.artifact.sha256);
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
  approve(id: string, approved: boolean, controllerId: string): { operationId: string | null; state: string } {
    if (this.closed || typeof approved !== "boolean" || !UUID.test(id)) return fail();
    const proposal = this.proposals.get(id);
    if (!proposal || proposal.controllerId !== controllerId || Date.parse(proposal.card.expiresAt) <= Date.now()) return fail();
    proposal.assertCurrent(); this.proposals.delete(id); // single use, including a refusal
    if (!approved) return { operationId: null, state: "declined" };
    if (this.active.has(proposal.card.runtimeId)) throw new Error("Runtime installation is already active; do not resend");
    for (const [id, prior] of this.operations) if (this.operations.size >= 64 && prior.state !== "downloading") this.operations.delete(id);
    const operation: Operation = { id: randomUUID(), runtimeId: proposal.card.runtimeId, state: "downloading", controller: new AbortController() };
    this.operations.set(operation.id, operation); this.active.set(operation.runtimeId, operation);
    void this.install(proposal, operation).finally(() => {
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
  private async install(proposal: Proposal, operation: Operation): Promise<void> {
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
      if (!current.entries.some(row => row.artifact.runtimeId === artifact.runtimeId && row.artifact.sha256 === artifact.sha256 && row.artifact.version === artifact.version)) {
        this.state.update(current.revision, value => ({ ...value, entries: [...value.entries, registration] }));
      }
      operation.state = "registered";
    } catch { operation.state = operation.controller.signal.aborted ? "cancelled" : "failed"; }
  }
  list() {
    const value = this.state.read(), locals = this.locals.read();
    return { revision: value.revision, builtIn: "pi", options: OPTIONAL_RUNTIMES.map(runtimeId => {
      const local = locals.entries.find(row => row.runtimeId === runtimeId), detected = this.detected.find(row => row.runtimeId === runtimeId);
      if (local || detected) {
        const selected = local ?? detected!, inspected = inspectLocalRuntime(selected.path);
        const valid = Boolean(inspected && inspected.realPath === selected.realPath && inspected.fingerprint === selected.fingerprint);
        return { runtimeId, label: RUNTIME_LABELS[runtimeId], installed: valid, registered: Boolean(local && valid), version: selected.version,
          path: selected.path, fingerprint: valid ? selected.fingerprint : null, source: selected.source,
          generalAgentDriverAvailable: Boolean(local && valid && (runtimeId === "codex" || runtimeId === "claude")), state: valid ? local ? "local_registered" : "detected" : "integrity_failed" };
      }
      const installed = value.entries.filter(row => row.artifact.runtimeId === runtimeId).at(-1);
      let verified = false; if (installed) try { verified = Boolean(this.inspect(installed.artifact, installed)); } catch { /* tampering revokes use, never repair or fallback */ }
      return { runtimeId, label: RUNTIME_LABELS[runtimeId], installed: verified, registered: verified, version: installed?.artifact.version ?? null,
        generalAgentDriverAvailable: Boolean(verified && (runtimeId === "codex" || runtimeId === "claude")), state: installed ? verified ? "registered" : "integrity_failed" : "not_installed" };
    }), operations: [...this.operations.values()].slice(-64).map(({ controller: _c, ...row }) => row) };
  }
  resolve(runtimeId: OptionalRuntimeId, version: string, artifactSha256: string): { command: string; env: NodeJS.ProcessEnv } {
    if (runtimeId === "agy") return fail();
    const row = this.state.read().entries.find(row => row.artifact.runtimeId === runtimeId && row.artifact.version === version && row.artifact.sha256 === artifactSha256);
    if (!row) return fail(); const checked = this.inspect(row.artifact, row); if (!checked) return fail();
    const privateHome = this.privateHome(runtimeId);
    return { command: checked.path, env: { HOME: privateHome, USERPROFILE: privateHome, CODEX_HOME: join(privateHome, ".codex"),
      CLAUDE_CONFIG_DIR: join(privateHome, ".claude"), XDG_CONFIG_HOME: join(privateHome, "config"), XDG_DATA_HOME: join(privateHome, "data"),
      XDG_CACHE_HOME: join(privateHome, "cache"), DISABLE_AUTOUPDATER: "1", HARA_UPDATE_CHECK: "0" } };
  }
  async close(): Promise<void> {
    this.closed = true; this.proposals.clear(); for (const operation of this.active.values()) operation.controller.abort();
    for (const controller of this.metadata) controller.abort();
    // Own downloads have a finite deadline; callers can observe incomplete drain rather than delete locks.
    const deadline = Date.now() + 5000;
    while ((this.active.size || this.metadata.size) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    if (this.active.size || this.metadata.size) throw new Error("Runtime downloads have not drained");
  }
}
