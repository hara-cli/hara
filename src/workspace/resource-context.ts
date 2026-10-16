// Host-private storage routing, not membership, an execution grant, or an OS sandbox.
// Never select this context from a model argument, renderer path, cwd, or foreground default.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import {
  bindPrivateHaraStateFile, ensurePrivateStateSubdirectory, readPrivateStateFileSnapshotSync,
  withPrivateStateLockSync, writePrivateStateFileSync, type PrivateStateDirectoryIdentity,
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
  assertCurrent(): void;
  trackDirectory(directory: PrivateStateDirectoryIdentity): void;
}
const contexts = new AsyncLocalStorage<StorageContext>();

/** @internal Only the explicitly bound stores use this; process HOME/USERPROFILE never changes. */
export function workspaceStateHome(): string {
  const context = contexts.getStore();
  context?.assertCurrent();
  return context?.home ?? homedir();
}
export function currentWorkspaceResourceBinding(): WorkspaceResourceBinding | undefined {
  return contexts.getStore()?.binding;
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
  const directory = ensurePrivateStateSubdirectory(workspaceStateHome(), [".hara", ...components]);
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
  const binding = bindWorkspaceResourceFile(path);
  const snapshot = readPrivateStateFileSnapshotSync(binding.path, maxBytes);
  binding.assertCurrent();
  return { ...binding, snapshot };
}

/** @internal File identity/namespace operations can bind without allocating the entire transcript. */
export function bindWorkspaceResourceFile(path: string) {
  const context = contexts.getStore();
  if (!context) throw new Error("no Workspace resource storage context");
  const home = workspaceStateHome();
  const rel = relative(home, path);
  const components = rel.split(sep);
  if (isAbsolute(rel) || components.length < 2 || components[0] !== ".hara"
    || components.some(value => !value || value === "." || value === "..")) throw new Error("file is outside Workspace resource storage");
  const binding = bindPrivateHaraStateFile(home, components.slice(1, -1), basename(path));
  context.trackDirectory(binding.directory);
  const assertCurrent = (): void => { context.assertCurrent(); verifyDirectory(binding.directory); };
  assertCurrent();
  return { path: binding.path, assertCurrent };
}

function pathExists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error: any) { if (error?.code === "ENOENT") return false; throw error; }
}

function verifyDirectory(identity: PrivateStateDirectoryIdentity): void {
  const info = lstatSync(identity.path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== identity.dev || info.ino !== identity.ino
    || realpathSync.native(identity.path) !== identity.path) throw new Error("Workspace resource directory identity changed");
}

/** @internal Constructed only by the host-side WorkspaceResources facade. Not an RPC or execution
 * context: other stores/tools/Host grants have NOT been partitioned by entering this storage context. */
export class WorkspaceResourceStorage {
  readonly scope: WorkspaceResourceScope;
  readonly scopeKey: string;
  private readonly host: PrivateStateDirectoryIdentity;
  private readonly directories: string[];
  private context?: StorageContext;

  constructor(home: string, scope: WorkspaceResourceScope) {
    if (typeof home !== "string" || !isAbsolute(home)) throw new Error("Workspace resources require an explicit absolute host home");
    const canonical = realpathSync.native(home);
    const info = lstatSync(canonical);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("invalid Workspace resources host home");
    this.host = { path: canonical, dev: info.dev, ino: info.ino };
    this.scope = parseWorkspaceResourceScope(scope);
    this.scopeKey = workspaceResourceScopeKey(this.scope);
    this.directories = ["workspace-data", "v1", this.scopeKey];
  }

  /** Explicit first initialization/reopen; never copies profiles, memory, sessions, or Account login.
   * Missing/corrupt markers beside existing state fail closed rather than reassigning ownership. */
  initialize(): void {
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
        writePrivateStateFileSync(marker, JSON.stringify({ schemaVersion: 1, scope: this.scope, generation: randomUUID() }) + "\n", { expectedMissing: true });
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
        writePrivateStateFileSync(dataMarker, dataText, { expectedMissing: true });
      } else if (dataSnapshot.text !== dataText) {
        throw new Error("Workspace resource storage generation or data binding mismatch; state was preserved");
      }
      const frozenText = snapshot.text;
      const tracked = new Map<string, PrivateStateDirectoryIdentity>();
      return Object.freeze({ home: state.path, binding, trackDirectory: (directory: PrivateStateDirectoryIdentity) => {
        const known = tracked.get(directory.path);
        if (known) { verifyDirectory(known); return; }
        if (tracked.size >= 10_000) throw new Error("Workspace resource directory tracking limit exceeded");
        verifyDirectory(directory);
        tracked.set(directory.path, { ...directory });
      }, assertCurrent: () => {
        verifyDirectory(this.host);
        verifyDirectory(marker.directory);
        verifyDirectory(state);
        verifyDirectory(dataMarker.directory);
        const current = readPrivateStateFileSnapshotSync(marker.path, 4096);
        if (!current || current.text !== frozenText) throw new Error("Workspace resource scope marker changed; reopen is required");
        const currentData = readPrivateStateFileSnapshotSync(dataMarker.path, 4096);
        if (!currentData || currentData.text !== dataText) throw new Error("Workspace resource data binding changed; state was preserved");
        for (const directory of tracked.values()) verifyDirectory(directory);
      } }) satisfies StorageContext;
    });
    this.context = context;
  }

  run<T>(operation: () => T): T {
    const context = this.context;
    if (!context) throw new Error("Workspace resources are not initialized");
    context.assertCurrent();
    return contexts.run(context, () => {
      let result: T;
      try { result = operation(); } catch (error) { context.assertCurrent(); throw error; }
      if (result instanceof Promise) {
        return result.then(value => { context.assertCurrent(); return value; }, error => {
          context.assertCurrent(); throw error;
        }) as T;
      }
      context.assertCurrent();
      return result;
    });
  }
}
