import { bindPrivateHaraStateFile, readPrivateStateFileSnapshotSync, withPrivateStateLockSync, writePrivateStateFileSync } from "../security/private-state.js";
import { inspectWorkspaceResourceFile, workspaceResourceCommitGuard, workspaceStateHome, type WorkspaceResourceStorage } from "./resource-context.js";
import { plain } from "./local-state.js";

type State = { schemaVersion: number; revision: number };
/** A single-source versioned document; unknown versions and recovered backups are never overwritten. */
export class VersionedSettings<T extends State> {
  constructor(private readonly home: () => string, private readonly filename: string, private readonly version: number,
    private readonly empty: () => T, private readonly parse: (raw: unknown) => T,
    private readonly migrations: Record<number, (raw: any) => any> = {}, private readonly storage?: WorkspaceResourceStorage,
    private readonly safeBackup: (old: any, next: T) => unknown = old => old) {}
  private run<R>(fn: () => R): R { return this.storage ? this.storage.run(fn) : fn(); }
  private file(name = this.filename) {
    if (this.storage) return inspectWorkspaceResourceFile(`${workspaceStateHome()}/.hara/${name}`, 4 * 1024 * 1024);
    const bound = bindPrivateHaraStateFile(this.home(), [], name);
    return { ...bound, snapshot: readPrivateStateFileSnapshotSync(bound.path, 4 * 1024 * 1024), assertCurrent() {} };
  }
  private backupName() { return this.filename.replace(/\.json$/, "-backup.json"); }
  private load() {
    const file = this.file();
    if (!file.snapshot) return { file, value: this.empty(), readOnly: false, recovered: false };
    try {
      const raw = JSON.parse(file.snapshot.text);
      if (!plain(raw) || !Number.isSafeInteger(raw.schemaVersion) || Number(raw.schemaVersion) < 1) throw new Error("invalid version");
      if (Number(raw.schemaVersion) > this.version) return { file, value: this.parse({ ...raw, schemaVersion: this.version }), readOnly: true, recovered: false };
      let next: any = raw;
      while (next.schemaVersion < this.version) {
        const migrate = this.migrations[next.schemaVersion]; if (!migrate) throw new Error("unsupported old version");
        const expected = next.schemaVersion + 1; next = migrate(next);
        if (next.schemaVersion !== expected) throw new Error("nonsequential migration");
      }
      const value = this.parse(next);
      if (raw.schemaVersion !== this.version) {
        this.backup(this.safeBackup(raw, value));
        writePrivateStateFileSync(file, JSON.stringify(value) + "\n", { expectedText: file.snapshot.text, assertCurrent: workspaceResourceCommitGuard() });
      }
      return { file: this.file(), value, readOnly: false, recovered: false };
    } catch {
      const backup = this.file(this.backupName());
      try { return { file, value: this.parse(JSON.parse(backup.snapshot!.text)), readOnly: true, recovered: true }; }
      catch { throw new Error("Settings are damaged; original and backup preserved; no empty overwrite"); }
    }
  }
  private backup(value: unknown) {
    const target = this.file(this.backupName());
    writePrivateStateFileSync(target, JSON.stringify(value) + "\n", {
      ...(target.snapshot ? { expectedText: target.snapshot.text } : { expectedMissing: true }), assertCurrent: workspaceResourceCommitGuard() });
  }
  read() { return this.run(() => withPrivateStateLockSync(this.home(), [], this.filename.slice(0, -5), () => {
    const { value, readOnly, recovered } = this.load(); return { value: structuredClone(value), readOnly, recovered };
  })); }
  update(expected: number, change: (value: T) => T): T {
    return this.run(() => withPrivateStateLockSync(this.home(), [], this.filename.slice(0, -5), () => {
      const loaded = this.load();
      if (loaded.readOnly) throw new Error("Settings are read-only: newer schema or backup recovery; original preserved");
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
