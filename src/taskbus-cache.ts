import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { bindPrivateHaraStateFile, readPrivateStateFileSnapshotSync, writePrivateStateFileSync, withPrivateStateLockSync } from "./security/private-state.js";
import { redactSensitiveValue } from "./security/secrets.js";
import type { MailScope } from "./mail.js";

/** Private, user/enrollment-pinned replicas. Only connectivity failures allow an offline read. */
export async function cachedTaskbusRead(scope: MailScope, operation: string, input: unknown, fetch: () => Promise<unknown>): Promise<any> {
  const file = bindPrivateHaraStateFile(homedir(), ["mail", "desk-cache", scope.identityKey], "snapshot.json");
  const key = createHash("sha256").update(JSON.stringify([operation, input])).digest("hex");
  const read = () => { const snapshot = readPrivateStateFileSnapshotSync(file.path, 2 * 1024 * 1024); return { snapshot, data: snapshot ? JSON.parse(snapshot.text) : {} }; };
  try {
    const value = redactSensitiveValue(await fetch()).value as Record<string, unknown>;
    const at = Date.now();
    withPrivateStateLockSync(homedir(), ["mail", "desk-cache", scope.identityKey], "snapshot", () => {
      const { snapshot, data } = read(); data[key] = { at, value };
      const entries = Object.entries(data).sort((a: any, b: any) => b[1].at - a[1].at).slice(0, 100);
      while (entries.length && JSON.stringify(Object.fromEntries(entries)).length > 1_900_000) entries.pop();
      writePrivateStateFileSync(file, JSON.stringify(Object.fromEntries(entries)), snapshot ? { expectedText: snapshot.text } : { expectedMissing: true });
    });
    return { ...value, offline: false, syncedAt: at };
  } catch (error: any) {
    if (error?.code !== "UNAVAILABLE") throw error;
    const cached = read().data[key];
    if (!cached) throw error;
    return { ...cached.value, offline: true, syncedAt: cached.at };
  }
}
