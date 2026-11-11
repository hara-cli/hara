import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { assertPrivateStateDirectory, bindPrivateHaraStateFile, readPrivateStateFileSnapshotSync,
  withPrivateStateLockSync, writePrivateStateFileSync } from "../security/private-state.js";
import { AgentHubError } from "./errors.js";
import { HUB_BODY_BYTES, HUB_LIMITS } from "./attachments.js";

const MESSAGE_FILE = /^message-[a-f0-9]{64}\.json$/;
/** Host-owned only. No renderer/token caller can select the home, namespace or filenames. */
export class AgentHubPrivateStore {
  private readonly namespace: readonly string[];
  constructor(private readonly home: string, scopeKey: string) {
    if (!/^[a-f0-9]{64}$/.test(scopeKey)) throw new AgentHubError("invalid_request");
    this.namespace = ["agent-hub", scopeKey];
  }
  private binding(filename: string) {
    if (filename !== "catalog.json" && !MESSAGE_FILE.test(filename)) throw new AgentHubError("store_unavailable");
    return bindPrivateHaraStateFile(this.home, this.namespace, filename);
  }
  transaction<T>(fn: () => T): T {
    try { return withPrivateStateLockSync(this.home, this.namespace, "hub", fn, { attempts: 10, waitMs: 5 }); }
    catch (error) { throw error instanceof AgentHubError ? error : new AgentHubError("store_unavailable"); }
  }
  read(filename: string): string | null {
    const bound = this.binding(filename); assertPrivateStateDirectory(bound.directory);
    return readPrivateStateFileSnapshotSync(bound.path, filename === "catalog.json" ? HUB_LIMITS.catalogBytes : HUB_BODY_BYTES + 64 * 1024)?.text ?? null;
  }
  write(filename: string, text: string, expectedText: string | null, assertCurrent?: () => void): void {
    const bound = this.binding(filename);
    writePrivateStateFileSync(bound, text, { ...(expectedText === null ? { expectedMissing: true } : { expectedText }), assertCurrent });
  }
  /** Includes orphaned staged messages from a crash, preventing unaccounted quota growth on retry. */
  usage(): { bytes: number; messages: number } {
    const bound = this.binding("catalog.json"); assertPrivateStateDirectory(bound.directory);
    const names = readdirSync(bound.directory.path);
    if (names.length > HUB_LIMITS.messages + 64) throw new AgentHubError("quota_exceeded");
    const lock = lstatSync(join(bound.directory.path, "hub.lock"));
    let bytes = 0, messages = 0;
    for (const name of names) {
      const info = lstatSync(join(bound.directory.path, name));
      const ownedLockAlias = info.nlink === 2 && info.dev === lock.dev && info.ino === lock.ino
        && (name === "hub.lock" || /^\.hara-lock-[A-Za-z0-9-]+\.tmp$/.test(name));
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 && !ownedLockAlias
        || process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) throw new AgentHubError("store_unavailable");
      bytes += info.size;
      if (MESSAGE_FILE.test(name)) messages++;
      else if (name !== "catalog.json" && !/^hub\.lock(?:\.|$)/.test(name) && !/^\.hara-(?:private|lock|claim)-/.test(name)) throw new AgentHubError("store_unavailable");
    }
    assertPrivateStateDirectory(bound.directory); return { bytes, messages };
  }
}
