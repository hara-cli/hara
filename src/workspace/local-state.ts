// Host-private primitives for the opt-in local Workspace lane. Never resolve HOME or cwd here.
import { join } from "node:path";
import { withPrivateStateLockSync, writePrivateStateFileSync } from "../security/private-state.js";
import {
  currentWorkspaceResourceBinding, inspectWorkspaceResourceFile, workspaceResourceCommitGuard,
  workspaceStateHome, type WorkspaceResourceStorage, type WorkspaceResourceBinding,
} from "./resource-context.js";

export function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
export function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
}
export function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0; }
export function text(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() && value.length <= max
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}
/** Chat/delegation bodies may contain LF, CR and tabs. IDs, paths and metadata still use text().
 * Do not normalize: request digests must distinguish different bodies, including their newlines. */
export function messageBody(value: unknown, max = 4000): value is string {
  return typeof value === "string" && value.length > 0 && value.trim().length > 0 && value.length <= max
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value);
}
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

/** The supplied storage is already bound to a trusted, explicit host/scope. No public arbitrary-path API. */
export class WorkspaceJsonState<T> {
  private validationBinding?: Readonly<WorkspaceResourceBinding>;
  constructor(readonly storage: WorkspaceResourceStorage, private readonly filename: string,
    private readonly parse: (value: unknown) => T, private readonly empty: () => T) {
    if (!/^[a-z][a-z0-9-]{0,79}\.json$/.test(filename)) throw new Error("invalid private Workspace state filename");
  }
  private file() { return inspectWorkspaceResourceFile(join(workspaceStateHome(), ".hara", this.filename), 4 * 1024 * 1024); }
  /** JSON validators compare provenance with this original structural tuple, not a new authority
   * grant. The actual file read/write and enclosing storage operation keep their fresh fences.
   * Clear synchronously even if a validator throws/returns a Promise; no fact survives an await. */
  private validate(operation: () => T): T {
    const binding = currentWorkspaceResourceBinding();
    if (!binding) throw new Error("Workspace JSON validation requires its bound storage context");
    const previous = this.validationBinding;
    this.validationBinding = binding;
    try { return operation(); } finally { this.validationBinding = previous; }
  }
  private decode(snapshot: ReturnType<typeof inspectWorkspaceResourceFile>["snapshot"]): T {
    if (!snapshot) return this.validate(() => this.empty());
    let raw: unknown;
    try { raw = JSON.parse(snapshot.text); } catch { throw new Error("invalid private Workspace JSON; state was preserved"); }
    return this.validate(() => this.parse(raw));
  }
  private load() {
    const file = this.file();
    return { file, value: this.decode(file.snapshot) };
  }
  read(): T { return this.storage.readJson(this.filename, snapshot => structuredClone(this.decode(snapshot))); }
  /** Read-only absence observations serialize with the SAME CAS lock; no revision/file write. */
  withReadLock<R>(read: () => R): R {
    return this.storage.run(() => withPrivateStateLockSync(workspaceStateHome(), [], this.filename.slice(0, -5), () => {
      const file = this.file(), assertResource = workspaceResourceCommitGuard();
      assertResource?.(); file.assertCurrent(); const result = read();
      if (result && (typeof result === "object" || typeof result === "function") && "then" in result) throw new Error("Workspace read observation must be synchronous");
      assertResource?.(); file.assertCurrent(); return result;
    }));
  }
  update(expectedRevision: number, change: (value: T) => T): T {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("invalid expected Workspace revision");
    return this.storage.run(() => withPrivateStateLockSync(workspaceStateHome(), [], this.filename.slice(0, -5), () => {
      const { file, value } = this.load();
      if ((value as { revision: number }).revision !== expectedRevision) throw new Error("Workspace state changed; refresh before writing");
      if (expectedRevision >= Number.MAX_SAFE_INTEGER) throw new Error("Workspace revision exhausted");
      const changed = { ...change(value), revision: expectedRevision + 1 };
      const next = this.validate(() => this.parse(changed));
      const result = JSON.stringify(next) + "\n";
      if (Buffer.byteLength(result) > 4 * 1024 * 1024) throw new Error("Workspace state is full");
      const assertResource = workspaceResourceCommitGuard();
      writePrivateStateFileSync(file, result, {
        ...(file.snapshot ? { expectedText: file.snapshot.text } : { expectedMissing: true }),
        assertCurrent() { assertResource?.(); file.assertCurrent(); },
      });
      return structuredClone(next);
    }));
  }
  binding() {
    if (this.validationBinding) return { ...this.validationBinding };
    return this.storage.run(() => ({ ...currentWorkspaceResourceBinding()! }));
  }
}
