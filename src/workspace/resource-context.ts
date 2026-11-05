// Host-private storage routing, not membership, an execution grant, or an OS sandbox.
// Never select this context from a model argument, renderer path, cwd, or foreground default.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  assertPrivateStateDirectory, bindPrivateHaraStateFile, ensurePrivateStateSubdirectory, privateStateMutationCount,
  readPrivateStateFileSnapshotSync, withPrivateStateLockSync, writePrivateStateFileSync, type PrivateStateDirectoryIdentity,
} from "../security/private-state.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
type Authority =
  | { kind: "local"; localAuthorityId: string }
  | { kind: "account"; accountRegion: "CN" | "GLOBAL"; issuer: string; realmId: string };

export interface WorkspaceResourceScope { schemaVersion: 1; workspaceId: string; authority: Authority }
export interface WorkspaceResourceBinding { schemaVersion: 1; scopeKey: string; generation: string }

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
}
function invalid(): never { throw new Error("invalid or unsupported Workspace resource scope"); }

/** Strict identity tuple. Account mapping must already have been verified by the trusted composition
 * layer; syntax validation here does NOT authenticate an Account/Realm or permit cloud execution. */
export function parseWorkspaceResourceScope(value: unknown): WorkspaceResourceScope {
  if (!record(value) || !keys(value, ["schemaVersion", "workspaceId", "authority"])
    || value.schemaVersion !== 1 || typeof value.workspaceId !== "string"
    || !value.workspaceId.startsWith("ws_") || !UUID.test(value.workspaceId.slice(3))
    || !record(value.authority)) return invalid();
  const a = value.authority;
  if (a.kind === "local" && keys(a, ["kind", "localAuthorityId"])
    && typeof a.localAuthorityId === "string" && UUID.test(a.localAuthorityId)) {
    return Object.freeze({ schemaVersion: 1, workspaceId: value.workspaceId,
      authority: Object.freeze({ kind: "local", localAuthorityId: a.localAuthorityId }) });
  }
  if (a.kind !== "account" || !keys(a, ["kind", "accountRegion", "issuer", "realmId"])
    || (a.accountRegion !== "CN" && a.accountRegion !== "GLOBAL")
    || typeof a.issuer !== "string" || a.issuer.length > 512
    || typeof a.realmId !== "string" || !UUID.test(a.realmId)) return invalid();
  let issuer: URL;
  try { issuer = new URL(a.issuer); } catch { return invalid(); }
  if (issuer.protocol !== "https:" || issuer.origin !== a.issuer || issuer.username || issuer.password
    || issuer.search || issuer.hash || issuer.hostname.length > 253) return invalid();
  return Object.freeze({ schemaVersion: 1, workspaceId: value.workspaceId,
    authority: Object.freeze({ kind: "account", accountRegion: a.accountRegion, issuer: a.issuer, realmId: a.realmId }) });
}

export function workspaceResourceScopeKey(scope: WorkspaceResourceScope): string {
  return createHash("sha256").update("hara-workspace-resources-v1\0")
    .update(JSON.stringify(parseWorkspaceResourceScope(scope))).digest("hex");
}
export function isWorkspaceResourceBinding(value: unknown): value is WorkspaceResourceBinding {
  return record(value) && keys(value, ["schemaVersion", "scopeKey", "generation"])
    && value.schemaVersion === 1 && typeof value.scopeKey === "string" && HASH.test(value.scopeKey)
    && typeof value.generation === "string" && UUID.test(value.generation);
}
export function sameWorkspaceResourceBinding(a: WorkspaceResourceBinding, b: WorkspaceResourceBinding): boolean {
  return isWorkspaceResourceBinding(a) && isWorkspaceResourceBinding(b)
    && a.scopeKey === b.scopeKey && a.generation === b.generation;
}

interface StorageContext {
  readonly home: string;
  readonly binding: WorkspaceResourceBinding;
  readonly scope: WorkspaceResourceScope;
  readonly fileBindings: Map<string, ReturnType<typeof bindPrivateHaraStateFile>>;
  /** Full fence. This exact function is the commit guard and is never deduplicated. */
  assertCurrent(): void;
  /** Read-side fence: skipped only inside a verified synchronous frame (see below), else full. */
  assertFramed(): void;
  trackDirectory(directory: PrivateStateDirectoryIdentity): void;
}
const contexts = new AsyncLocalStorage<StorageContext>();

/**
 * A8 synchronous fence frame. Opened by WorkspaceResourceStorage.run immediately after a full
 * assertCurrent and closed by `finally` when operation() returns, i.e. before any await, promise
 * continuation, timer or I/O callback can run. It is a plain module variable on purpose: AsyncLocalStorage
 * would propagate it into continuations, and clearing it from a microtask would let earlier-queued
 * continuations observe it (FIFO). Inside the frame read-side fences skip the repeated scope/marker/
 * tracked-directory checks while no in-process private-state data mutation happened since the last full
 * fence. Never skipped: the commit guard (assertCurrent), every run() entry, directory creation, leaf
 * directory/file identity checks, and every check after an await (no frame exists then).
 */
interface VerifiedFrame { readonly context: StorageContext; mutations: number }
let verifiedFrame: VerifiedFrame | undefined;

function withVerifiedFrame<T>(context: StorageContext, operation: () => T): T {
  const previous = verifiedFrame;
  verifiedFrame = { context, mutations: privateStateMutationCount() };
  try { return operation(); } finally { verifiedFrame = previous; }
}

/** @internal Only the explicitly bound stores use this; process HOME/USERPROFILE never changes. */
export function workspaceStateHome(): string {
  const context = contexts.getStore();
  context?.assertFramed();
  return context?.home ?? homedir();
}
export function currentWorkspaceResourceBinding(): WorkspaceResourceBinding | undefined {
  return contexts.getStore()?.binding;
}
/** @internal Structural scope for validating stored provenance, not fresh membership authority. */
export function currentWorkspaceResourceScope(): WorkspaceResourceScope | undefined {
  return contexts.getStore()?.scope;
}

/** @internal Capture the original context before awaiting file preparation; never follow a later
 * foreground selection or freshly opened storage generation at the irreversible commit. */
export function workspaceResourceCommitGuard(): (() => void) | undefined {
  return contexts.getStore()?.assertCurrent;
}

/** @internal Non-recursive, link-rejecting path creation under the already bound private home. */
export function workspaceResourceDirectory(components: readonly string[]): string {
  const context = contexts.getStore();
  if (!context) throw new Error("no Workspace resource storage context");
  // May create directories: full fence before the namespace mutation, never framed.
  context.assertCurrent();
  const directory = ensurePrivateStateSubdirectory(context.home, [".hara", ...components]);
  context.trackDirectory(directory);
  return directory.path;
}

/** @internal Lexical recall must not canonicalize an editable memory-file alias into a foreign store.
 * The shared private binder rejects every directory alias, and its reader rejects final/hard links. */
export function readWorkspaceResourceText(path: string, maxBytes: number): string {
  return inspectWorkspaceResourceFile(path, maxBytes).snapshot?.text ?? "";
}

/** @internal Capture the original private directory and snapshot before any asynchronous preparation.
 * Callers must retain assertCurrent through commit, not canonicalize a late alias into a new target. */
export function inspectWorkspaceResourceFile(path: string, maxBytes: number) {
  const { assertFramed, ...binding } = bindResourceFile(path);
  const snapshot = readPrivateStateFileSnapshotSync(binding.path, maxBytes);
  assertFramed();
  return { ...binding, snapshot };
}

/** @internal File identity/namespace operations can bind without allocating the entire transcript.
 * The returned assertCurrent is always the full fence; callers use it as a commit guard. */
export function bindWorkspaceResourceFile(path: string) {
  const { assertFramed: _framed, ...binding } = bindResourceFile(path);
  return binding;
}

function bindResourceFile(path: string) {
  const context = contexts.getStore();
  if (!context) throw new Error("no Workspace resource storage context");
  const home = context.home;
  const rel = relative(home, path);
  const components = rel.split(sep);
  if (isAbsolute(rel) || components.length < 2 || components[0] !== ".hara"
    || components.some(value => !value || value === "." || value === "..")) throw new Error("file is outside Workspace resource storage");
  // Reuse only this immutable directory/path proof. Every caller still reads fresh bytes and
  // rechecks authority, generation, all tracked directories and final file identity around I/O.
  let binding = context.fileBindings.get(path);
  if (!binding) {
    // A new binding may create private directories. Fence before that mutation; a cache hit
    // only projects immutable path data and is fenced below before any caller can do I/O.
    context.assertCurrent();
    const fresh = bindPrivateHaraStateFile(home, components.slice(1, -1), basename(path));
    binding = Object.freeze({ path: fresh.path, directory: Object.freeze({ ...fresh.directory }) });
    context.trackDirectory(binding.directory);
    if (context.fileBindings.size >= 256) context.fileBindings.clear();
    context.fileBindings.set(path, binding);
  }
  const directory = binding.directory;
  const assertCurrent = (): void => { context.assertCurrent(); assertPrivateStateDirectory(directory); };
  // The leaf directory identity is always re-verified; only the context-wide part may be framed.
  const assertFramed = (): void => { context.assertFramed(); assertPrivateStateDirectory(directory); };
  assertFramed();
  return { path: binding.path, directory, assertCurrent, assertFramed };
}

/** @internal A narrow read-only inventory permit for one exact memory bucket. Never a generic
 * allowProtected flag: profiles, Agent config, other Workspaces and arbitrary roots are refused. */
export function bindWorkspaceMemoryInventory(root: string) {
  const context = contexts.getStore();
  if (!context) throw new Error("Workspace memory inventory requires an explicit resource context");
  const home = workspaceStateHome();
  const parts = relative(join(home, ".hara", "memory"), root).split(sep);
  if (!isAbsolute(root) || ((parts.length !== 1 || parts[0] !== "global")
    && (parts.length !== 2 || parts[0] !== "projects" || !HASH.test(parts[1]!)))) {
    throw new Error("Workspace memory inventory requires one exact bound memory bucket");
  }
  const assertDirectory = (path: string): void => {
    if (contexts.getStore() !== context) throw new Error("Workspace memory inventory permit belongs to another resource context");
    context.assertCurrent();
    const rel = relative(root, path);
    if (!isAbsolute(path) || isAbsolute(rel) || rel.split(sep).includes("..")) throw new Error("directory escaped Workspace memory inventory");
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync.native(path) !== path
      || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) throw new Error("unsafe Workspace memory inventory directory");
    context.trackDirectory({ path, dev: info.dev, ino: info.ino });
    context.assertCurrent();
  };
  assertDirectory(root);
  return Object.freeze({ root, assertDirectory });
}

function pathExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error: any) { if (error?.code === "ENOENT") return false; throw error; }
}

function verifyDirectory(identity: PrivateStateDirectoryIdentity): void {
  const info = lstatSync(identity.path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== identity.dev || info.ino !== identity.ino
    || realpathSync.native(identity.path) !== identity.path) throw new Error("Workspace resource directory identity changed");
}

/** Every component of a canonical absolute path from the first below the root down to the path itself. */
function directoryChain(path: string): string[] {
  const chain: string[] = [];
  for (let current = path, parent = dirname(current); parent !== current; current = parent, parent = dirname(current)) chain.push(current);
  return chain.reverse();
}

/**
 * A8 tracked-directory fence. `verifyDirectory` proves "leaf dev/ino unchanged and realpath(T) === T"; for a
 * canonical absolute T the realpath half is exactly "no component of T is a symlink" (POSIX realpath walks
 * and lstats each component). This fence instead lstats every component itself, requiring a real directory
 * whose dev/ino equals the identity pinned when the directory was first tracked, and shares components
 * between directories within ONE full fence (N dirs x depth D realpath walks become about N + D lstats).
 * Replacement strength is never lower: symlink insertion is rejected at the component, any ancestor or
 * leaf inode/device replacement (including a mount over an ancestor) is rejected, and the original leaf
 * identity check is unchanged. The only accepted difference: a case- or Unicode-normalization-only rename
 * of an existing component on an insensitive volume keeps every pinned inode and is no longer rejected;
 * it cannot redirect to other data. Windows keeps realpath (reparse points/8.3 names are not lstat-shaped).
 */
class DirectoryChainFence {
  private readonly pinned = new Map<string, { dev: number; ino: number }>();
  private readonly enabled = process.platform !== "win32";

  /** Pin a directory that is not yet known, between two full realpath proofs of it. */
  track(identity: PrivateStateDirectoryIdentity): void {
    verifyDirectory(identity);
    if (!this.enabled) return;
    const recorded: [string, { dev: number; ino: number }][] = [];
    for (const path of directoryChain(identity.path)) {
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Workspace resource directory identity changed");
      const known = this.pinned.get(path);
      if (known && (known.dev !== info.dev || known.ino !== info.ino)) throw new Error("Workspace resource directory identity changed");
      recorded.push([path, { dev: info.dev, ino: info.ino }]);
    }
    verifyDirectory(identity);
    const leaf = recorded.at(-1)?.[1];
    if (!leaf || leaf.dev !== identity.dev || leaf.ino !== identity.ino) throw new Error("Workspace resource directory identity changed");
    for (const [path, pin] of recorded) this.pinned.set(path, pin);
  }

  /** One full-fence pass. `checked` lives for a single synchronous assertCurrent call only. */
  verify(identity: PrivateStateDirectoryIdentity, checked: Set<string>): void {
    if (!this.enabled) { verifyDirectory(identity); return; }
    const chain = directoryChain(identity.path);
    if (!chain.every(path => this.pinned.has(path))) { verifyDirectory(identity); return; }
    for (const path of chain) {
      if (checked.has(path)) continue;
      const pin = this.pinned.get(path)!;
      const info = lstatSync(path);
      if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== pin.dev || info.ino !== pin.ino) {
        throw new Error("Workspace resource directory identity changed");
      }
      checked.add(path);
    }
    const leaf = this.pinned.get(identity.path)!;
    if (leaf.dev !== identity.dev || leaf.ino !== identity.ino) throw new Error("Workspace resource directory identity changed");
  }
}

/** @internal Constructed only by the host-side WorkspaceResources facade. Not an RPC or execution
 * context: other stores/tools/Host grants have NOT been partitioned by entering this storage context. */
export class WorkspaceResourceStorage {
  readonly scope: WorkspaceResourceScope;
  readonly scopeKey: string;
  private readonly host: PrivateStateDirectoryIdentity;
  private readonly directories: string[];
  private context?: StorageContext;

  constructor(home: string, scope: WorkspaceResourceScope, private readonly assertAuthority?: () => void) {
    if (assertAuthority !== undefined && typeof assertAuthority !== "function") throw new Error("invalid Workspace resource authority fence");
    if (typeof home !== "string" || !isAbsolute(home)) throw new Error("Workspace resources require an explicit absolute host home");
    const canonical = realpathSync.native(home);
    const info = lstatSync(canonical);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("invalid Workspace resources host home");
    this.host = { path: canonical, dev: info.dev, ino: info.ino };
    this.scope = parseWorkspaceResourceScope(scope);
    this.scopeKey = workspaceResourceScopeKey(this.scope);
    this.directories = ["workspace-data", "v1", this.scopeKey];
  }

  /** Host-only protection root, never a renderer writable grant. From Claude runtime 5555d2a. */
  runtimeProtectedStateRoot(): string {
    this.checkAuthority(); verifyDirectory(this.host); return join(this.host.path, ".hara");
  }

  /** Explicit first initialization/reopen; never copies profiles, memory, sessions, or Account login.
   * Missing/corrupt markers beside existing state fail closed rather than reassigning ownership. */
  initialize(): void {
    this.checkAuthority();
    if (this.context) { this.context.assertCurrent(); return; }
    verifyDirectory(this.host);
    const context = withPrivateStateLockSync(this.host.path, this.directories, "scope", () => {
      const marker = bindPrivateHaraStateFile(this.host.path, this.directories, "scope.json");
      const statePath = join(marker.directory.path, "state");
      const stateExisted = pathExists(statePath);
      let snapshot = readPrivateStateFileSnapshotSync(marker.path, 4096);
      if (!snapshot) {
        if (stateExisted) {
          throw new Error("Workspace resource scope marker is missing; existing state was preserved");
        }
        writePrivateStateFileSync(marker, JSON.stringify({ schemaVersion: 1, scope: this.scope, generation: randomUUID() }) + "\n", { expectedMissing: true, assertCurrent: () => this.checkAuthority() });
        snapshot = readPrivateStateFileSnapshotSync(marker.path, 4096);
      }
      if (!snapshot) throw new Error("Workspace resource scope marker disappeared");
      let parsed: any;
      try { parsed = JSON.parse(snapshot.text); } catch { throw new Error("invalid Workspace resource scope marker; state was preserved"); }
      if (!record(parsed) || !keys(parsed, ["schemaVersion", "scope", "generation"]) || parsed.schemaVersion !== 1
        || workspaceResourceScopeKey(parseWorkspaceResourceScope(parsed.scope)) !== this.scopeKey
        || typeof parsed.generation !== "string" || !UUID.test(parsed.generation)) {
        throw new Error("Workspace resource scope marker mismatch; state was preserved");
      }
      const binding = Object.freeze({ schemaVersion: 1 as const, scopeKey: this.scopeKey, generation: parsed.generation });
      if (this.context && !sameWorkspaceResourceBinding(this.context.binding, binding)) throw new Error("Workspace resource storage generation changed");
      const state = ensurePrivateStateSubdirectory(this.host.path, [".hara", ...this.directories, "state"]);
      // Bind the data directory independently of its outer selector. A modified valid outer generation
      // must not relabel existing keys or let an old cache/lock become authority for a new generation.
      const dataMarker = bindPrivateHaraStateFile(state.path, [], "resource-binding.json");
      const dataText = JSON.stringify(binding) + "\n";
      const dataSnapshot = readPrivateStateFileSnapshotSync(dataMarker.path, 4096);
      if (!dataSnapshot) {
        if (stateExisted) throw new Error("Workspace data binding is missing; existing state was preserved");
        writePrivateStateFileSync(dataMarker, dataText, { expectedMissing: true, assertCurrent: () => this.checkAuthority() });
      } else if (dataSnapshot.text !== dataText) {
        throw new Error("Workspace resource storage generation or data binding mismatch; state was preserved");
      }
      const frozenText = snapshot.text;
      const tracked = new Map<string, PrivateStateDirectoryIdentity>();
      const fence = new DirectoryChainFence();
      for (const directory of [this.host, marker.directory, state, dataMarker.directory]) fence.track(directory);
      const assertFramed = (): void => {
        const frame = verifiedFrame;
        if (frame?.context === created && frame.mutations === privateStateMutationCount()) return;
        created.assertCurrent();
        if (frame?.context === created) frame.mutations = privateStateMutationCount();
      };
      const created: StorageContext = Object.freeze({ home: state.path, binding, scope: this.scope, fileBindings: new Map<string, ReturnType<typeof bindPrivateHaraStateFile>>(), assertFramed, trackDirectory: (directory: PrivateStateDirectoryIdentity) => {
        const known = tracked.get(directory.path);
        if (known) { verifyDirectory(known); return; }
        if (tracked.size >= 10_000) throw new Error("Workspace resource directory tracking limit exceeded");
        fence.track(directory);
        tracked.set(directory.path, { ...directory });
      }, assertCurrent: () => {
        this.checkAuthority();
        const checked = new Set<string>();
        fence.verify(this.host, checked);
        fence.verify(marker.directory, checked);
        fence.verify(state, checked);
        fence.verify(dataMarker.directory, checked);
        const current = readPrivateStateFileSnapshotSync(marker.path, 4096);
        if (!current || current.text !== frozenText) throw new Error("Workspace resource scope marker changed; reopen is required");
        const currentData = readPrivateStateFileSnapshotSync(dataMarker.path, 4096);
        if (!currentData || currentData.text !== dataText) throw new Error("Workspace resource data binding changed; state was preserved");
        for (const directory of tracked.values()) fence.verify(directory, checked);
      } }) satisfies StorageContext;
      return created;
    });
    this.context = context;
  }

  private checkAuthority(): void {
    if (this.assertAuthority && this.assertAuthority() !== undefined) {
      throw new Error("Workspace resource authority fence must be synchronous and return void");
    }
  }

  /** Host-private single JSON read. The mapper is synchronous validation only: return data only
   * after fresh scope/authority checks around the verified open/read and mapper. This avoids
   * re-entering the whole scope merely to project a path inside another read wrapper. */
  readJson<T>(filename: string, decode: (snapshot: ReturnType<typeof readPrivateStateFileSnapshotSync>) => T): T {
    if (!/^[a-z][a-z0-9-]{0,79}\.json$/.test(filename)) throw new Error("invalid private Workspace state filename");
    const context = this.context;
    if (!context) throw new Error("Workspace resources are not initialized");
    return contexts.run(context, () => {
      // The binder performs the full fresh scope/authority fence immediately before I/O and
      // verifies the original private parent. Cache hits reuse path identity only, never allow.
      // Standalone this is two full fences. Nested inside a verified frame of this context both are
      // framed: the enclosing run() fences fully before it returns anything to its own caller.
      const file = bindResourceFile(join(context.home, ".hara", filename));
      try {
        const snapshot = readPrivateStateFileSnapshotSync(file.path, 4 * 1024 * 1024);
        assertPrivateStateDirectory(file.directory);
        const result = decode(snapshot);
        if (result !== null && (typeof result === "object" || typeof result === "function")
          && typeof (result as { then?: unknown }).then === "function") throw new Error("Workspace JSON validation must be synchronous");
        return result;
      } finally { context.assertFramed(); }
    });
  }

  run<T>(operation: () => T): T {
    const context = this.context;
    if (!context) throw new Error("Workspace resources are not initialized");
    // Entry is always a full fence, even when nested: run(() => {}) is used as a freshness guard.
    context.assertCurrent();
    return contexts.run(context, () => {
      let result: T;
      // Exit fences run after the frame closed: full unless an enclosing verified frame of this same
      // context will fence before returning. Promise settlement is always a full, fresh fence.
      try { result = withVerifiedFrame(context, operation); } catch (error) { context.assertFramed(); throw error; }
      if (result instanceof Promise) {
        return result.then(value => { context.assertCurrent(); return value; }, error => {
          context.assertCurrent(); throw error;
        }) as T;
      }
      context.assertFramed();
      return result;
    });
  }
}
