import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { bindPrivateHaraStateFile, ensurePrivateStateSubdirectory, readPrivateStateFileSnapshotSync, writePrivateStateFileSync } from "../security/private-state.js";
import { exact, plain, UUID } from "./local-state.js";

/** Only an explicitly empty, private operator-selected fixture root can opt into this Dev lane. */
export function openLocalWorkspaceDevRoot(root: string): { root: string; home: string; project: string } {
  if (!isAbsolute(root) || realpathSync.native(root) !== root) throw new Error("Workspace Dev root must be an explicit canonical private directory");
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== "win32"
    && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) throw new Error("Workspace Dev root must be owner-only");
  const entries = readdirSync(root);
  if (entries.length && !entries.includes(".hara")) throw new Error("Workspace Dev refuses an existing non-fixture directory");
  const marker = bindPrivateHaraStateFile(root, [], "workspace-dev-fixture.json");
  let snapshot = readPrivateStateFileSnapshotSync(marker.path, 4096);
  if (!snapshot) {
    if (entries.length) throw new Error("Workspace Dev fixture marker missing; existing directory preserved");
    writePrivateStateFileSync(marker, JSON.stringify({ schemaVersion: 1, kind: "synthetic-workspace-dev", instanceId: randomUUID() }) + "\n", { expectedMissing: true });
    snapshot = readPrivateStateFileSnapshotSync(marker.path, 4096);
  }
  let value: unknown;
  try { value = JSON.parse(snapshot!.text); } catch { throw new Error("invalid Workspace Dev fixture marker"); }
  if (!plain(value) || !exact(value, ["schemaVersion", "kind", "instanceId"]) || value.schemaVersion !== 1 || value.kind !== "synthetic-workspace-dev"
    || typeof value.instanceId !== "string" || !UUID.test(value.instanceId)) throw new Error("invalid Workspace Dev fixture marker");
  const home = ensurePrivateStateSubdirectory(root, ["home"]).path;
  const project = ensurePrivateStateSubdirectory(root, ["project"]).path;
  return { root, home, project };
}
