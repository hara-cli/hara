import { bindPrivateHaraStateFile, readPrivateStateFileSnapshotSync, withPrivateStateLockSync, writePrivateStateFileSync } from "../security/private-state.js";
import { inspectWorkspaceResourceFile, workspaceResourceCommitGuard, workspaceStateHome, type WorkspaceResourceStorage } from "./resource-context.js";
import { plain } from "./local-state.js";
import { createHash } from "node:crypto";

type State = { schemaVersion: number; revision: number };
/** A valid old document needs a currently unavailable side effect, not repair or an empty overwrite.
 * Never attach the underlying vault error/cause: it may contain credential or host-private details. */
export class SettingsMigrationPendingError extends Error {
  constructor() { super("Settings migration is pending; original preserved"); this.name = "SettingsMigrationPendingError"; }
}
/** A single-source versioned document; unknown versions and recovered backups are never overwritten. */
export class VersionedSettings<T extends State> {
  private blockedSource: string | undefined;
  constructor(private readonly home: () => string, private readonly filename: string, private readonly version: number,
    private readonly empty: () => T, private readonly parse: (raw: unknown) => T,
    private readonly migrations: Record<number, (raw: any, options: { readOnly: boolean }) => any> = {}, private readonly storage?: WorkspaceResourceStorage,
    private readonly safeBackup: (old: any, next: T) => unknown = old => old) {}
  private run<R>(fn: () => R): R { return this.storage ? this.storage.run(fn) : fn(); }
  private file(name = this.filename) {
    if (this.storage) return inspectWorkspaceResourceFile(`${workspaceStateHome()}/.hara/${name}`, 4 * 1024 * 1024);
    const bound = bindPrivateHaraStateFile(this.home(), [], name);
    return { ...bound, snapshot: readPrivateStateFileSnapshotSync(bound.path, 4 * 1024 * 1024), assertCurrent() {} };
  }
  private backupName() { return this.filename.replace(/\.json$/, "-backup.json"); }
  private pending(file: ReturnType<VersionedSettings<T>["file"]>, recovered = false) {
    return { file, value: this.empty(), readOnly: true, recovered, migrationPending: true };
  }
  private migrate(raw: any, readOnly: boolean): T {
    let next = raw;
    while (next.schemaVersion < this.version) {
      const migrate = this.migrations[next.schemaVersion]; if (!migrate) throw new Error("unsupported old version");
      const expected = next.schemaVersion + 1; next = migrate(next, { readOnly });
      if (next.schemaVersion !== expected) throw new Error("nonsequential migration");
    }
    return this.parse(next);
  }
  private recover(file: ReturnType<VersionedSettings<T>["file"]>, backup = this.file(this.backupName())) {
    try {
      const raw = JSON.parse(backup.snapshot!.text);
      if (!plain(raw) || !Number.isSafeInteger(raw.schemaVersion) || Number(raw.schemaVersion) < 1) throw new Error("invalid backup version");
      // Pure older formats can be projected in memory; side-effecting migrations must refuse readOnly.
      const value = Number(raw.schemaVersion) > this.version ? this.parse({ ...raw, schemaVersion: this.version }) : this.migrate(raw, true);
      return { file, value, readOnly: true, recovered: true, migrationPending: false };
    } catch (error) {
      if (error instanceof SettingsMigrationPendingError) return this.pending(file, true);
      throw new Error("Settings are damaged; original and backup preserved; no empty overwrite");
    }
  }
  private load() {
    const file = this.file();
    if (!file.snapshot) {
      const backup = this.file(this.backupName());
      if (backup.snapshot) return this.recover(file, backup);
      return { file, value: this.empty(), readOnly: false, recovered: false, migrationPending: false };
    }
    const fingerprint = createHash("sha256").update(file.snapshot.text).digest("hex");
    if (this.blockedSource === fingerprint) return this.pending(file);
    let raw, value: T;
    try {
      raw = JSON.parse(file.snapshot.text);
      if (!plain(raw) || !Number.isSafeInteger(raw.schemaVersion) || Number(raw.schemaVersion) < 1) throw new Error("invalid version");
      if (Number(raw.schemaVersion) > this.version) return { file, value: this.parse({ ...raw, schemaVersion: this.version }), readOnly: true, recovered: false, migrationPending: false };
      value = this.migrate(raw, false);
    } catch (error) {
      if (error instanceof SettingsMigrationPendingError) { this.blockedSource = fingerprint; return this.pending(file); }
      return this.recover(file);
    }
    // A write failure is not proof that valid source JSON was damaged. Let callers isolate the
    // unavailable setting; do not reclassify it or manufacture an empty writable state.
    this.blockedSource = undefined;
    if (raw.schemaVersion !== this.version) {
      this.backup(this.safeBackup(raw, value));
      writePrivateStateFileSync(file, JSON.stringify(value) + "\n", { expectedText: file.snapshot.text, assertCurrent: workspaceResourceCommitGuard() });
    }
    return { file: this.file(), value, readOnly: false, recovered: false, migrationPending: false };
  }
  private backup(value: unknown) {
    const target = this.file(this.backupName());
    writePrivateStateFileSync(target, JSON.stringify(value) + "\n", {
      ...(target.snapshot ? { expectedText: target.snapshot.text } : { expectedMissing: true }), assertCurrent: workspaceResourceCommitGuard() });
  }
  read() { return this.run(() => withPrivateStateLockSync(this.home(), [], this.filename.slice(0, -5), () => {
    const { value, readOnly, recovered, migrationPending } = this.load(); return { value: structuredClone(value), readOnly, recovered, migrationPending };
  })); }
  retryMigration() { this.blockedSource = undefined; }
  update(expected: number, change: (value: T) => T): T {
    return this.run(() => withPrivateStateLockSync(this.home(), [], this.filename.slice(0, -5), () => {
      const loaded = this.load();
      if (loaded.readOnly) throw new Error("Settings are read-only: pending migration, newer schema or backup recovery; original preserved");
      if (loaded.value.revision !== expected) throw new Error("Settings changed; refresh before writing");
      const value = this.parse({ ...change(structuredClone(loaded.value)), revision: expected + 1, schemaVersion: this.version });
      this.backup(loaded.value);
      writePrivateStateFileSync(loaded.file, JSON.stringify(value) + "\n", {
        ...(loaded.file.snapshot ? { expectedText: loaded.file.snapshot.text } : { expectedMissing: true }), assertCurrent: workspaceResourceCommitGuard() });
      // The recovery copy must not resurrect a removed connection or point at a deleted Keychain ref.
      this.backup(value);
      return structuredClone(value);
    }));
  }
}
