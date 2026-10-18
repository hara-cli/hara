// Versioned source material, not executable plugins or a credential/tool grant. Runtime reads only
// the immutable copy pinned inside its Workspace; edits must fork that copy, never the global source.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { bindPrivateHaraStateFile, readPrivateStateFileSnapshotSync, writePrivateStateFileSync } from "../security/private-state.js";
import { scanMemory } from "../memory/guard.js";
import { readModelContextFileSync } from "../fs-read.js";
import { redactSensitiveText } from "../security/secrets.js";
import { canonical, plain } from "./local-state.js";
import type { Tool } from "../tools/registry.js";

export interface WorkspaceSkillBundle { id: string; description: string; version: string; files: Record<string, string>; source: "global" | "private"; enabled: boolean }
const ID = /^[a-z0-9][a-z0-9-]{0,79}$/;
const VERSION = /^[a-f0-9]{64}$/;
const safeFile = (value: string) => value.length <= 240 && value.split("/").every(part => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part));
const digest = (files: Record<string, string>) => createHash("sha256").update(canonical(files)).digest("hex");
function metadata(content: string, fallback: string) {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1] ?? "";
  const field = (key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(head)?.[1]?.trim().replace(/^["']|["']$/g, "");
  return { id: field("name") ?? fallback, description: field("description") ?? "", allowed: field("allowed-tools"), fork: field("context") === "fork" };
}
export function validateWorkspaceSkill(raw: unknown): WorkspaceSkillBundle {
  if (!plain(raw) || typeof raw.id !== "string" || !ID.test(raw.id) || typeof raw.version !== "string" || !VERSION.test(raw.version)
    || !plain(raw.files) || !["global", "private"].includes(String(raw.source)) || typeof raw.enabled !== "boolean") throw new Error("Invalid Workspace skill lock");
  const files: Record<string, string> = Object.create(null);
  for (const [name, value] of Object.entries(raw.files)) {
    if (!safeFile(name) || typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 128 * 1024) throw new Error("Unsafe skill resource");
    files[name] = value;
  }
  if (!files["SKILL.md"] || Object.keys(files).length > 64 || Buffer.byteLength(JSON.stringify(files)) > 512 * 1024 || digest(files) !== raw.version
    || redactSensitiveText(JSON.stringify(files)).redactions.length) throw new Error("Skill content failed integrity or secret checks");
  const info = metadata(files["SKILL.md"], raw.id);
  if (info.id !== raw.id || !info.description || info.description.length > 1000 || !scanMemory(info.description).ok) throw new Error("Unsafe skill metadata");
  return { id: raw.id, description: info.description, version: raw.version, files, source: raw.source as "global" | "private", enabled: raw.enabled };
}
function sourceBundle(root: string, id: string, source: "global" | "private"): WorkspaceSkillBundle | undefined {
  try {
    const files: Record<string, string> = Object.create(null); let total = 0;
    const walk = (directory: string, prefix: string, depth: number) => {
      const info = lstatSync(directory);
      if (depth > 5 || !info.isDirectory() || info.isSymbolicLink() || realpathSync.native(directory) !== directory || (info.mode & 0o022) !== 0) throw new Error("Unsafe skill directory");
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const name = prefix + entry.name; if (!safeFile(name) || entry.isSymbolicLink()) throw new Error("Unsafe skill name");
        const path = join(directory, entry.name), stat = lstatSync(path);
        if (stat.isDirectory()) { walk(path, name + "/", depth + 1); continue; }
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0 || stat.size > 128 * 1024 || Object.keys(files).length >= 64) throw new Error("Unsafe skill file");
        const content = readModelContextFileSync(path, 128 * 1024); total += Buffer.byteLength(content);
        if (total > 512 * 1024) throw new Error("Only bounded UTF-8 skill resources are supported");
        files[name] = content;
      }
    };
    walk(join(root, id), "", 0);
    return validateWorkspaceSkill({ id, files, source, enabled: false, version: digest(files) });
  } catch { return; } // Broken/unreviewed sources do not become execution capabilities.
}
export class WorkspaceSkillLibrary {
  constructor(private readonly home: string) {}
  candidates(project: string): WorkspaceSkillBundle[] {
    const found = new Map<string, WorkspaceSkillBundle>();
    const versionRoot = join(this.home, ".hara/skill-library/v1");
    try {
      if (realpathSync.native(versionRoot) === versionRoot) for (const id of readdirSync(versionRoot).filter(id => ID.test(id)).sort().slice(0, 128)) {
        const folder = join(versionRoot, id); if (realpathSync.native(folder) !== folder) continue;
        const versions = readdirSync(folder).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).slice(0, 128)
          .map(name => ({ name, mtime: lstatSync(join(folder, name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
        for (const version of versions) try {
          const path = join(folder, version.name), info = lstatSync(path);
          if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024 || (info.mode & 0o077) !== 0) continue;
          const snapshot = readPrivateStateFileSnapshotSync(path, 1024 * 1024); if (!snapshot) continue;
          const value = validateWorkspaceSkill(JSON.parse(snapshot.text));
          if (value.id !== id || `${value.version}.json` !== version.name) continue;
          found.set(id, { ...value, enabled: false, source: "global" }); break;
        } catch { /* A corrupt historical version never becomes a skill. */ }
      }
    } catch { /* Library not created yet. */ }
    for (const [root, source] of [[join(this.home, ".hara/skills"), "global"], [join(project, ".hara/skills"), "private"]] as const) {
      let names: string[]; try { if (realpathSync.native(root) !== root) continue; names = readdirSync(root).filter(id => ID.test(id)).sort().slice(0, 128); } catch { continue; }
      for (const id of names) { const bundle = sourceBundle(root, id, source); if (bundle) found.set(id, bundle); }
    }
    return [...found.values()];
  }
  preserve(bundle: WorkspaceSkillBundle): void {
    if (bundle.source !== "global") return;
    const checked = validateWorkspaceSkill(bundle), target = bindPrivateHaraStateFile(this.home, ["skill-library", "v1", checked.id], `${checked.version}.json`);
    const previous = readPrivateStateFileSnapshotSync(target.path, 1024 * 1024), content = JSON.stringify(checked) + "\n";
    if (previous) { const stored = validateWorkspaceSkill(JSON.parse(previous.text)); if (stored.version !== checked.version) throw new Error("Global skill version is immutable"); return; }
    writePrivateStateFileSync(target, content, { expectedMissing: true });
  }
}
export function forkWorkspaceSkill(bundle: WorkspaceSkillBundle, content: string): WorkspaceSkillBundle {
  const files = { ...bundle.files, "SKILL.md": content };
  return validateWorkspaceSkill({ ...bundle, source: "private", files, version: digest(files) });
}
/** Captured version locks for one attempt. Disabling/forking a skill revokes that attempt's reads. */
export function workspaceSkillTool(bundles: WorkspaceSkillBundle[], assertCurrent: (id: string, version: string) => void): Tool {
  return { name: "workspace_skill", kind: "read", description: "Read instructions or a relative text resource from an enabled version-locked skill in THIS Workspace. Start with SKILL.md; continue at nextOffset until complete. This grants no new tools or global paths.",
    input_schema: { type: "object", properties: { id: { type: "string" }, file: { type: "string" }, offset: { type: "integer", minimum: 0 } }, required: ["id"] },
    async run(input, context) {
      if (!plain(input) || Object.keys(input).some(key => !["id", "file", "offset"].includes(key)) || typeof input.id !== "string") throw new Error("Invalid Workspace skill read");
      const bundle = bundles.find(row => row.id === input.id && row.enabled), name = input.file ?? "SKILL.md", offset = input.offset ?? 0;
      if (!bundle || typeof name !== "string" || !safeFile(name) || !Object.hasOwn(bundle.files, name) || !Number.isSafeInteger(offset) || Number(offset) < 0) throw new Error("Enabled Workspace skill resource unavailable");
      assertCurrent(bundle.id, bundle.version);
      const content = bundle.files[name]!, info = metadata(bundle.files["SKILL.md"]!, bundle.id);
      if (!scanMemory(content).ok || info.fork) throw new Error("Workspace skill content or fork policy requires review");
      if (info.allowed !== undefined) {
        const allowed = info.allowed.replace(/^\[|\]$/g, "").split(",").map(value => value.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
        if (!context.restrictToolsForSkill?.(bundle.id, allowed).ok) throw new Error("Workspace skill tool policy cannot be enforced");
      }
      const start = Number(offset); let chunk = content.slice(start, start + 6000);
      const result = () => JSON.stringify({ id: bundle.id, version: bundle.version, file: name, content: chunk,
        nextOffset: start + chunk.length < content.length ? start + chunk.length : null, files: Object.keys(bundle.files).slice(0, 12) });
      while (result().length > 7800 && chunk.length) chunk = chunk.slice(0, Math.floor(chunk.length * .75));
      return result();
    } };
}
