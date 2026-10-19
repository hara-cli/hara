// Trusted Host startup only. Never a renderer/model-selected source or a scheduler handoff.
// The frozen source backup is encrypted; its wrapping key and imported credentials live in Vault.
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readLegacyBackupBytes } from "./legacy-backup.js";
import { LegacyConnectionCatalog } from "./legacy-connections.js";
import { WorkspaceLegacyConnectionImport } from "./legacy-connection-import.js";
import { WorkspaceLegacyCoordinator, type LegacyDomainAdapter } from "./legacy-coordinator.js";
import { buildLegacyInheritancePlan } from "./legacy-plan.js";
import { legacyAgentInputs } from "./legacy-agents.js";
import { LegacyOwnerFileDomain } from "./legacy-file-domain.js";
import { WorkspaceLegacyMemoryImport } from "./legacy-memory.js";
import { WorkspaceInheritedSkills } from "./legacy-skills.js";
import { WorkspaceSkillLibrary, type WorkspaceSkillBundle } from "./skills.js";
import { WorkspaceLegacyResources, planLegacyResources } from "./legacy-resources.js";
import { legacyScheduleRows, legacySchedulesDomain } from "./legacy-schedules.js";
import { canonical, plain, WorkspaceJsonState } from "./local-state.js";
import { sameWorkspaceResourceBinding, type WorkspaceResourceBinding, type WorkspaceResourceStorage } from "./resource-context.js";
import type { CredentialVault } from "./credential-vault.js";
import type { LocalWorkspaceCatalog } from "./local-catalog.js";
import type { WorkspaceResources } from "./resources.js";
import type { WorkspaceFeatures } from "./features.js";

const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonical(value)).digest("hex");
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
type Seeds = ReturnType<LegacyConnectionCatalog["inheritanceSeeds"]>;
interface Material {
  schemaVersion: 1; sourceFingerprint: string; sourceHome: string; plan: ReturnType<typeof buildLegacyInheritancePlan>;
  jobs: unknown[]; roles: { file: string; content: string }[]; memories: { sourceRef: string; sourceHash: string; content: string }[];
  skills: WorkspaceSkillBundle[]; seeds: Seeds; credentials: Record<string, ReturnType<LegacyConnectionCatalog["resolve"]>>;
}
interface Backup { revision: number; resourceBinding: WorkspaceResourceBinding; keyRef: string; sourceHome: string; ciphertext: string | null; iv: string | null; tag: string | null; backupHash: string | null }
export interface LegacyStartupStatus { state: "not_needed" | "pending" | "verified" | "rolled_back"; reason: string | null; roles: number; schedules: number; skills: number; sourceFingerprint: string | null; handoff: false }
export const noLegacyStartup = (): LegacyStartupStatus => ({ state: "not_needed", reason: null, roles: 0, schedules: 0, skills: 0, sourceFingerprint: null, handoff: false });

function directory(path: string): boolean {
  try { const info = lstatSync(path);
    if (!isAbsolute(path) || !info.isDirectory() || info.isSymbolicLink() || realpathSync.native(path) !== path
      || process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)) throw new Error("Unsafe legacy source directory");
    return true;
  } catch (error: any) { if (error?.code === "ENOENT") return false; throw error; }
}
export function hasLegacyStartupSource(sourceHome: string): boolean {
  if (!directory(sourceHome) || !directory(join(sourceHome, ".hara"))) return false;
  for (const relative of ["config.json", "profiles.json", "cron/jobs.json", "roles", "memory", "skills", "skill-library", "workspace/.hara/memory"]) {
    try { lstatSync(join(sourceHome, ".hara", relative)); return true; }
    catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  }
  return false;
}
/** A bounded readonly projection, NOT a traversal of old sessions, plugins, business projects or launchd. */
function capture(sourceHome: string, vault: CredentialVault): Material | null {
  if (!directory(sourceHome) || !directory(join(sourceHome, ".hara"))) return null;
  const captures: [string, string][] = [], knownFiles = new Map<string, string>(); let total = 0;
  const read = (relative: string, max = 512 * 1024) => {
    const parts = relative.split("/"); let parent = sourceHome;
    for (const part of parts.slice(0, -1)) { parent = join(parent, part); if (!directory(parent)) return null; }
    const path = join(sourceHome, relative);
    try { const info = lstatSync(path);
      // Legacy Markdown/config commonly used 0644. Reading an owned, non-writable source does
      // not grant execution or publish it: the frozen copy is encrypted and target state is 0600.
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)) throw new Error("Unsafe legacy source file");
      const bytes = readLegacyBackupBytes(path, max); total += bytes.length;
      if (total > 2 * 1024 * 1024 || captures.length >= 512) throw new Error("Legacy startup source exceeds bounded backup");
      const content = bytes.toString("utf8"); if (!Buffer.from(content).equals(bytes)) throw new Error("Legacy source is not UTF-8");
      captures.push([relative, hash(bytes)]); knownFiles.set(path, hash(bytes)); return content;
    } catch (error: any) { if (error?.code === "ENOENT") return null; throw error; }
  };
  const json = (relative: string, fallback: unknown) => { const text = read(relative); return text === null ? fallback : JSON.parse(text); };
  const config = json(".hara/config.json", {}), profiles = json(".hara/profiles.json", {}), raw = json(".hara/cron/jobs.json", []);
  const jobs = Array.isArray(raw) ? raw : plain(raw) && Array.isArray(raw.jobs) ? raw.jobs : null;
  if (!jobs) throw new Error("Legacy task source requires review");
  const roles: Material["roles"] = [], memories: Material["memories"] = [];
  const rolesRoot = join(sourceHome, ".hara/roles");
  if (directory(rolesRoot)) for (const file of readdirSync(rolesRoot).sort()) {
    if (!/^[a-zA-Z0-9_-]+\.md$/.test(file)) continue;
    const content = read(`.hara/roles/${file}`); if (content !== null) roles.push({ file, content });
  }
  const walkMemory = (relative: string, depth: number) => {
    if (!directory(join(sourceHome, relative))) return;
    if (depth > 5) throw new Error("Legacy memory depth requires review");
    for (const file of readdirSync(join(sourceHome, relative)).sort()) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(file) || [".", ".."].includes(file)) throw new Error("Unsafe legacy memory name");
      const rel = `${relative}/${file}`, info = lstatSync(join(sourceHome, rel));
      if (info.isSymbolicLink()) throw new Error("Legacy memory link requires review");
      if (info.isDirectory()) walkMemory(rel, depth + 1);
      else if (file.endsWith(".md")) { const content = read(rel, 256 * 1024); if (content !== null) memories.push({ sourceRef: "memory-" + hash(rel).slice(0, 32), sourceHash: hash(content), content }); }
    }
  };
  walkMemory(".hara/memory", 0); walkMemory(".hara/workspace/.hara/memory", 0);
  // Old installed skills were available source material. The inherited immutable lock preserves that
  // availability; it still grants no new executable tools and user overrides remain authoritative.
  const skills = new WorkspaceSkillLibrary(sourceHome).candidates(join(sourceHome, ".hara/workspace")).map(row => ({ ...row, enabled: true }));
  captures.push(...skills.map(row => [`skill:${row.id}`, row.version] as [string, string]));
  const source = new LegacyConnectionCatalog(sourceHome, vault), seeds = source.inheritanceSeeds(), credentials: Material["credentials"] = {};
  for (const seed of seeds) if (seed.keySaved) credentials[seed.id] = source.resolve(seed.id, undefined, true, true);
  for (const [path, expected] of knownFiles) if (hash(readLegacyBackupBytes(path, 512 * 1024)) !== expected) throw new Error("Legacy source changed during backup");
  if (!jobs.length && !roles.length && !memories.length && !skills.length && !seeds.length) return null;
  const sourceFingerprint = hash(captures.sort(([a], [b]) => a.localeCompare(b)));
  const plan = buildLegacyInheritancePlan({ sourceFingerprint, now: Date.now(), jobs, roles, config, profiles, sessions: [], flows: [] });
  return { schemaVersion: 1, sourceFingerprint, sourceHome, jobs, roles, memories, skills, seeds, credentials, plan };
}

export class WorkspaceLegacyStartup {
  private readonly backup: WorkspaceJsonState<Backup>;
  private coordinator?: WorkspaceLegacyCoordinator;
  constructor(private readonly input: { sourceHome: string; storage: WorkspaceResourceStorage; catalog: LocalWorkspaceCatalog;
    resources: WorkspaceResources; features: WorkspaceFeatures; vault: CredentialVault }) {
    this.backup = new WorkspaceJsonState(input.storage, "workspace-legacy-source-backup-v1.json", raw => {
      if (!plain(raw) || !sameWorkspaceResourceBinding(raw.resourceBinding as WorkspaceResourceBinding, this.backup.binding())
        || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1 || raw.sourceHome !== input.sourceHome
        || typeof raw.keyRef !== "string" || !new RegExp(`^${input.storage.scopeKey}:legacy-source:gen_[a-f0-9-]{36}$`).test(raw.keyRef)
        || !(raw.ciphertext === null && raw.iv === null && raw.tag === null && raw.backupHash === null
          || typeof raw.ciphertext === "string" && raw.ciphertext.length <= 3800000 && typeof raw.iv === "string" && /^[a-f0-9]{24}$/.test(raw.iv)
          && typeof raw.tag === "string" && /^[a-f0-9]{32}$/.test(raw.tag) && digest(raw.backupHash) && hash(raw.ciphertext) === raw.backupHash)) throw new Error("Legacy encrypted backup changed; preserved");
      return structuredClone(raw) as unknown as Backup;
    }, () => ({ revision: 0, resourceBinding: this.backup.binding(), keyRef: `${input.storage.scopeKey}:legacy-source:gen_${randomUUID()}`, sourceHome: input.sourceHome, ciphertext: null, iv: null, tag: null, backupHash: null }));
  }
  private open(): Material | null {
    let before = this.backup.read();
    if (before.ciphertext === null) {
      const captured = capture(this.input.sourceHome, this.input.vault); if (!captured) return null;
      // Reference intent precedes Vault writes. A denied/unknown Vault write never falls back to disk.
      if (!before.revision) before = this.backup.update(0, () => before);
      let key = this.input.vault.get(before.keyRef);
      if (!key) { key = randomBytes(32).toString("hex"); this.input.vault.set(before.keyRef, key); }
      if (!/^[a-f0-9]{64}$/.test(key) || this.input.vault.get(before.keyRef) !== key) throw new Error("Legacy backup Vault pending");
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv);
      cipher.setAAD(Buffer.from(canonical(before.resourceBinding)));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(captured)), cipher.final()]).toString("base64");
      before = this.backup.update(before.revision, old => ({ ...old, ciphertext, iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), backupHash: hash(ciphertext) }));
    }
    const key = this.input.vault.get(before.keyRef); if (!key || !/^[a-f0-9]{64}$/.test(key)) throw new Error("Legacy backup Vault unavailable");
    const cipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), Buffer.from(before.iv!, "hex"));
    cipher.setAAD(Buffer.from(canonical(before.resourceBinding))); cipher.setAuthTag(Buffer.from(before.tag!, "hex"));
    const material: Material = JSON.parse(Buffer.concat([cipher.update(Buffer.from(before.ciphertext!, "base64")), cipher.final()]).toString("utf8"));
    if (material.schemaVersion !== 1 || material.sourceHome !== this.input.sourceHome || !digest(material.sourceFingerprint) || material.plan.sourceFingerprint !== material.sourceFingerprint) throw new Error("Legacy backup identity changed");
    return material;
  }
  private prepare() {
    const m = this.open(); if (!m) return null;
    const { storage, catalog, resources, features, vault } = this.input, source = {
      inheritanceSeeds: () => structuredClone(m.seeds),
      resolve: (id: string) => { const value = m.credentials[id]; if (!value) throw new Error("Frozen legacy credential unavailable"); return structuredClone(value); },
    };
    const credentials = Object.values(m.credentials).flatMap(row => row.input.apiKey ? [row.input.apiKey] : []);
    const connections = new WorkspaceLegacyConnectionImport(storage, source, vault, m.sourceFingerprint);
    const folders = new WorkspaceLegacyResources(storage), main = resources.agents.initializeMain(), roles = legacyAgentInputs(m.roles, m.plan.roles);
    const schedule = () => legacySchedulesDomain(storage, features, m.sourceFingerprint, legacyScheduleRows({ jobs: m.jobs, plan: m.plan.tasks,
      sourceFingerprint: m.sourceFingerprint, workspaceId: storage.scope.workspaceId, mainAgentId: main.agentId, resources: folders, knownCredentials: credentials }));
    const schedules: LegacyDomainAdapter = { id: "schedules", apply: () => schedule().apply(), verify: r => schedule().verify(r), preflightRollback: () => schedule().preflightRollback(), rollback: () => schedule().rollback() };
    this.coordinator = new WorkspaceLegacyCoordinator(storage, catalog, () => ({ sourceFingerprint: m.sourceFingerprint,
      planHash: hash(m.plan), backupHash: this.backup.read().backupHash! }), [connections,
      new LegacyOwnerFileDomain(storage, "roles", m.sourceFingerprint, [".hara/workspace-agents.json", ".hara/workspace-agents-owner.json"], roles.length,
        () => { resources.agents.importLegacy(roles, resources.agents.list().revision); }),
      new WorkspaceLegacyMemoryImport(storage, m.sourceFingerprint, m.memories, credentials), new WorkspaceInheritedSkills(storage).domain(m.sourceFingerprint, m.skills),
      folders.domain(m.sourceFingerprint, planLegacyResources({ jobs: m.jobs, projects: [], legacyWorkspacePath: join(m.sourceHome, ".hara/workspace") })), schedules], { profile: "agents-and-schedules-v1" });
    return m;
  }
  async initialize(reapply = false): Promise<LegacyStartupStatus> {
    const m = this.prepare(); if (!m) return noLegacyStartup();
    const before = this.coordinator!.read();
    if (before.phase !== "verified" && (before.phase !== "rolled_back" || reapply)) { await this.coordinator!.apply(); await this.coordinator!.verify(); }
    return { state: this.coordinator!.read().phase === "rolled_back" ? "rolled_back" : "verified", reason: null,
      roles: m.roles.length, schedules: m.jobs.length, skills: m.skills.length, sourceFingerprint: m.sourceFingerprint, handoff: false };
  }
  async rollback() { if (!this.coordinator && !this.prepare()) return; await this.coordinator!.rollback(); }
}
