import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { assertPrivateStateDirectory, bindPrivateHaraStateFile, readPrivateStateFileSnapshotSync,
  withPrivateStateLockSync, writePrivateStateFileSync, type PrivateStateDirectoryIdentity } from "../security/private-state.js";

export class StorageQuotaError extends Error {
  constructor(readonly code: "quota_exceeded" | "unavailable" | "configuration_conflict") {
    super(`Hara storage quota: ${code}`); this.name = "StorageQuotaError";
  }
}
/** Host-configured, persisted budget shared by every Workspace/Agent below one private Hara home.
 * Counts file metadata only: no session, credential, message or attachment contents are read. */
export class HaraStorageQuota {
  readonly home: string;
  private depth = 0;
  private readonly additionalRoots: PrivateStateDirectoryIdentity[];
  constructor(options: { home: string; limitBytes: number; additionalRoots?: readonly PrivateStateDirectoryIdentity[] }) {
    if (!Number.isSafeInteger(options.limitBytes) || options.limitBytes < 4096) throw new StorageQuotaError("configuration_conflict");
    this.home = realpathSync.native(options.home); this.limitBytes = options.limitBytes;
    if ((options.additionalRoots?.length ?? 0) > 16) throw new StorageQuotaError("configuration_conflict");
    this.additionalRoots = (options.additionalRoots ?? []).map(root => ({ ...root }));
  }
  readonly limitBytes: number;
  assertHome(home: string): void {
    if (realpathSync.native(home) !== this.home) throw new StorageQuotaError("configuration_conflict");
  }
  run<T>(action: () => T): T {
    if (this.depth) return action();
    return withPrivateStateLockSync(this.home, ["storage-quota"], "global", () => {
      const binding = bindPrivateHaraStateFile(this.home, ["storage-quota"], "policy.json");
      const roots = this.roots().map(({ path, dev, ino }) => ({ path, dev, ino }));
      const policyText = JSON.stringify({ schemaVersion: 1, limitBytes: this.limitBytes, roots });
      if (Buffer.byteLength(policyText) > 64 * 1024) throw new StorageQuotaError("configuration_conflict");
      const previous = readPrivateStateFileSnapshotSync(binding.path, 64 * 1024);
      if (!previous) writePrivateStateFileSync(binding, policyText, { expectedMissing: true });
      else {
        let policy: unknown; try { policy = JSON.parse(previous.text); } catch { throw new StorageQuotaError("unavailable"); }
        if (!policy || typeof policy !== "object" || Array.isArray(policy) || Object.keys(policy).length !== 3
          || !("schemaVersion" in policy) || policy.schemaVersion !== 1 || !("limitBytes" in policy)
          || !Number.isSafeInteger(policy.limitBytes) || !("roots" in policy) || !Array.isArray(policy.roots)) throw new StorageQuotaError("unavailable");
        // A second process/scope cannot silently widen the first Host's budget.
        if (policy.limitBytes !== this.limitBytes || JSON.stringify(policy.roots) !== JSON.stringify(roots)) throw new StorageQuotaError("configuration_conflict");
      }
      this.depth++;
      try { return action(); } finally { this.depth--; }
    }, { attempts: 10, waitMs: 5 });
  }
  private roots(): PrivateStateDirectoryIdentity[] {
    const base = bindPrivateHaraStateFile(this.home, [], "quota-root-probe").directory;
    const roots = [base, ...this.additionalRoots].sort((a, b) => a.path.localeCompare(b.path));
    const inside = (parent: string, child: string) => { const rel = relative(parent, child); return rel === "" || !isAbsolute(rel) && rel.split(sep)[0] !== ".."; };
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i]; assertPrivateStateDirectory(root);
      if (root.path === resolve(sep) || root.path.length > 4096) throw new StorageQuotaError("configuration_conflict");
      for (let j = 0; j < i; j++) if (inside(roots[j].path, root.path) || inside(root.path, roots[j].path)) throw new StorageQuotaError("configuration_conflict");
    }
    return roots;
  }
  usageBytes(): number {
    if (!this.depth) return this.run(() => this.usageBytes());
    const roots = this.roots();
    const stack = roots.map(root => root.path); let bytes = 0, entries = 0;
    while (stack.length) {
      const path = stack.pop()!;
      if (++entries > 200_000) throw new StorageQuotaError("unavailable");
      if (realpathSync.native(path) !== path) throw new StorageQuotaError("unavailable");
      const before = lstatSync(path);
      // Unknown aliases are not zero usage; never follow them into another user/project tree.
      if (before.isSymbolicLink()) throw new StorageQuotaError("unavailable");
      if (before.isDirectory()) {
        for (const name of readdirSync(path)) stack.push(join(path, name));
        const after = lstatSync(path);
        if (!after.isDirectory() || after.isSymbolicLink() || realpathSync.native(path) !== path || before.dev !== after.dev || before.ino !== after.ino) throw new StorageQuotaError("unavailable");
      } else if (before.isFile()) {
        // Count logical names conservatively, including lock aliases. Synthetic Windows dev/ino
        // values must never deduplicate unrelated files into zero/missing usage.
        bytes += before.size;
      } else throw new StorageQuotaError("unavailable");
      if (!Number.isSafeInteger(bytes)) throw new StorageQuotaError("unavailable");
    }
    for (const root of roots) assertPrivateStateDirectory(root); return bytes;
  }
  admitControlReplacement(nextBytes: number, previousBytes: number): void {
    if (!this.depth || !Number.isSafeInteger(nextBytes) || !Number.isSafeInteger(previousBytes)
      || nextBytes < 0 || nextBytes > previousBytes || previousBytes > 4 * 1024 * 1024) throw new StorageQuotaError("unavailable");
    // Only a caller-verified, CAS-bound restrictive replacement may use this staging allowance.
    // Its permanent footprint cannot grow, even when the existing catalog exceeds 64 KiB.
  }
  admitGrowth(bytes: number, control = false): void {
    if (!this.depth || !Number.isSafeInteger(bytes) || bytes < 0) throw new StorageQuotaError("unavailable");
    // Revocation/recovery/read leases must remain possible at a full data quota. The caller restricts
    // these writes to fixed control schemas; every byte still contributes to subsequent admissions.
    if (control) { if (bytes > 64 * 1024) throw new StorageQuotaError("unavailable"); return; }
    if (this.usageBytes() + bytes > this.limitBytes) throw new StorageQuotaError("quota_exceeded");
  }
}
