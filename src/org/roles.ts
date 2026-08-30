// Org roles — markdown agent definitions from Hara and Claude Code.
// Frontmatter: execution metadata plus a bounded public identity. Body = private persona/system and is
// loaded only for the selected role; it must never be exposed through the Agent catalog.
import { writeFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { findProjectRoot } from "../context/agents-md.js";
import { pluginRoleDirs } from "../plugins/plugins.js";
import {
  readModelContextFileSync,
  readRegularFileSnapshotNoFollow,
  type RegularFileSnapshot,
} from "../fs-read.js";
import { atomicWriteText, bindAtomicWritePath } from "../fs-write.js";
import { scanMemory } from "../memory/guard.js";
import {
  getProfile,
  isValidProfileId,
  isValidSpaceId,
  resolveActive,
  spaceIdForProfile,
} from "../profile/profile.js";
import {
  agentIdentityFromMetadata,
  normalizeAgentPublicIdentityInput,
  type AgentPublicIdentity,
  type AgentPublicIdentityInput,
} from "./agent-identity.js";
import { loadExternalAgentRoles } from "./external-agent-roles.js";
import { withPrivateStateLockSync } from "../security/private-state.js";

const MAX_ROLE_BYTES = 512 * 1024;
const MAX_ORG_POLICY_BYTES = 128 * 1024;
const MAX_ORG_BUNDLE_BYTES = 2 * 1024 * 1024;
const ROLE_DIGEST_CAP = 16_000;
const ROLE_DESCRIPTION_CAP = 180;

export type RoleSource = "plugin" | "openclaw" | "hermes" | "org" | "claude-global" | "global" | "claude-project" | "project";

export interface Role {
  id: string;
  description: string;
  owns: string[];
  rejects: string[];
  model?: string;
  /** Optional Agent-level reasoning override. Absence inherits the selected Space/connection default. */
  reasoningEffort?: string;
  allowTools?: string[];
  denyTools?: string[];
  /** Enforce a genuinely read-only tool surface. Reviewer roles default to true unless explicitly disabled. */
  readOnly?: boolean;
  /** Hidden from automatic routing/catalogs, but still addressable explicitly with --role or agent(role). */
  modelInvocable?: boolean;
  /** Why a foreign role stays explicit-only instead of entering automatic routing. */
  compatibilityWarnings?: string[];
  source?: RoleSource;
  /** Exact immutable Control bundle that supplied this managed persona. Company execution compares this
   *  with the freshly synchronized policy immediately before inference and every tool side effect. */
  organizationPolicyVersion?: number;
  file?: string;
  /** Safe presentation identity. The private persona remains in `system` and never enters catalogs. */
  identity?: AgentPublicIdentity;
  /** Immutable, public install provenance for a hired catalog blueprint. It never grants tools. */
  blueprint?: AgentBlueprintProvenance;
  /** Optional execution workspace owned by an imported global Agent. */
  home?: string;
  system: string;
}

export interface CreateNativeAgentInput {
  id: string;
  description?: string;
  instructions?: string;
  profile: AgentPublicIdentityInput;
  blueprint?: AgentBlueprintInstallInput;
  execution?: AgentExecutionPreferencesInput;
}

export interface AgentExecutionPreferencesInput {
  /** Empty/null clears the override and follows the Space default. */
  model?: string | null;
  /** Empty/null clears the override and follows the Space default. */
  reasoningEffort?: string | null;
}

export interface AgentBlueprintInstallInput {
  id: string;
  version: string;
  publisher: string;
  source: string;
  sourceRevision: string;
  license: string;
}

export interface AgentBlueprintProvenance extends AgentBlueprintInstallInput {
  /** SHA-256 over normalized provenance plus the installed private prompt body. */
  digest: string;
}

export function rolesDir(cwd: string): string {
  return join(findProjectRoot(cwd), ".hara", "roles");
}
/** Global roles — reusable personas across all projects. */
export function globalRolesDir(): string {
  return join(homedir(), ".hara", "roles");
}
/** Claude Code's personal subagents are portable role prompts. Read them in place so users do not need
 *  to copy or fork the prompt collection into Hara. Native ~/.hara/roles overrides an id collision. */
export function globalClaudeAgentsDir(): string {
  return join(homedir(), ".claude", "agents");
}
/** Org-pushed roles are immutable-Space-scoped. A local profile id is only a mutable route alias and can be
 * re-enrolled into another company, so using it as the prompt directory key would let the replacement
 * company inherit the previous tenant's persona/tool policy. Callers may pass either a profile id (resolved
 * to its current Space) or an already-authoritative Space id. */
export function orgRolesDir(profileOrSpaceId?: string): string {
  const selected = profileOrSpaceId ?? resolveActive().id;
  const profile = isValidProfileId(selected) ? getProfile(selected) : undefined;
  const storageScope = profile?.kind === "gateway" ? spaceIdForProfile(profile) : selected;
  if (!isValidProfileId(storageScope) && !isValidSpaceId(storageScope)) {
    throw new Error("invalid profile or Space id for organization role storage");
  }
  // Scope ids are case-sensitive while common macOS/Windows filesystems are not. A fixed lowercase digest
  // prevents aliases from sharing a managed prompt directory. v2 deliberately separates old profile-keyed
  // bundles so a pre-upgrade stale directory can never be mistaken for current company policy.
  const storageKey = createHash("sha256")
    .update("hara-org-roles-v2\0")
    .update(storageScope, "utf8")
    .digest("hex");
  return join(homedir(), ".hara", "org-roles", storageKey);
}

export interface OrganizationExecutionPolicy {
  /** Monotonic Control bundle revision. A role persona and its execution floor are one snapshot. */
  version: number;
  modelAllow?: string[];
  modelDeny?: string[];
  toolDeny?: string[];
  requireApprovalForWrites?: boolean;
  /** Company-admin consent for member-owned BYOK routes. Omitted/false remains fail-closed. */
  allowPersonalModelConnections?: boolean;
}

export interface OrganizationBundleRole {
  name: string;
  description?: string;
  owns?: string[];
  rejects?: string[];
  model?: string;
  reasoning_effort?: string;
  allow_tools?: string[];
  deny_tools?: string[];
  system: string;
}

export interface OrganizationRoleBundleEnvelope {
  version: number;
  org_policy: Record<string, unknown>;
  roles: OrganizationBundleRole[];
}

export interface OrganizationRoleBundleSnapshot {
  version: number;
  policy: OrganizationExecutionPolicy;
  roles: Role[];
  envelope: OrganizationRoleBundleEnvelope;
}

function organizationPolicyList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error(`managed organization policy '${field}' must be a bounded string array`);
  }
  const result: string[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "string"
      || !entry.trim()
      || entry.length > 256
      || /[\u0000-\u001f\u007f]/.test(entry)
    ) throw new Error(`managed organization policy '${field}' contains an invalid value`);
    const normalized = entry.trim();
    if (!result.includes(normalized)) result.push(normalized);
  }
  return result;
}

/** Read the Control-reviewed execution floor for one immutable company Space. Missing or malformed policy
 * is intentionally distinguishable from an empty policy: company inference must not silently run before
 * its authenticated bundle has been synchronized. */
export function parseOrganizationExecutionPolicyEnvelope(parsed: unknown): OrganizationExecutionPolicy {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("managed organization policy envelope is invalid");
  }
  const policy = (parsed as Record<string, unknown>).org_policy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("managed organization policy payload is invalid");
  }
  const input = policy as Record<string, unknown>;
  const version = (parsed as Record<string, unknown>).version;
  if (!Number.isSafeInteger(version) || Number(version) < 0) {
    throw new Error("managed organization policy version is invalid");
  }
  const supported = new Set([
    "modelAllow",
    "modelDeny",
    "toolDeny",
    "requireApprovalForWrites",
    "allowPersonalModelConnections",
    "budget",
  ]);
  const unknown = Object.keys(input).filter((key) => !supported.has(key));
  if (unknown.length) throw new Error(`managed organization policy contains unsupported field '${unknown[0]}'`);
  if (
    input.requireApprovalForWrites !== undefined
    && typeof input.requireApprovalForWrites !== "boolean"
  ) throw new Error("managed organization policy 'requireApprovalForWrites' must be boolean");
  if (
    input.allowPersonalModelConnections !== undefined
    && typeof input.allowPersonalModelConnections !== "boolean"
  ) throw new Error("managed organization policy 'allowPersonalModelConnections' must be boolean");
  return {
    version: Number(version),
    ...(input.modelAllow !== undefined ? { modelAllow: organizationPolicyList(input.modelAllow, "modelAllow") } : {}),
    ...(input.modelDeny !== undefined ? { modelDeny: organizationPolicyList(input.modelDeny, "modelDeny") } : {}),
    ...(input.toolDeny !== undefined ? { toolDeny: organizationPolicyList(input.toolDeny, "toolDeny") } : {}),
    ...(input.requireApprovalForWrites === true ? { requireApprovalForWrites: true } : {}),
    ...(input.allowPersonalModelConnections !== undefined
      ? { allowPersonalModelConnections: input.allowPersonalModelConnections }
      : {}),
  };
}

const SAFE_ORG_ROLE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const WINDOWS_RESERVED_ROLE_NAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const ORG_BUNDLE_KEYS = new Set(["version", "org_policy", "roles"]);
const ORG_ROLE_KEYS = new Set([
  "name", "description", "owns", "rejects", "model", "reasoning_effort", "allow_tools", "deny_tools", "system",
]);
const AGENT_REASONING_EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function organizationRoleReasoningEffort(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !AGENT_REASONING_EFFORTS.has(value)) {
    throw new Error("managed organization role 'reasoning_effort' is invalid");
  }
  return value;
}

function organizationRoleString(value: unknown, field: string, required = false): string | undefined {
  if (value === undefined && !required) return undefined;
  if (
    typeof value !== "string"
    || (required && !value.trim())
    || value.length > MAX_ROLE_BYTES
    || value.includes("\0")
  ) throw new Error(`managed organization role '${field}' is invalid`);
  return value;
}

function organizationRoleList(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 128) {
    throw new Error(`managed organization role '${field}' must be a bounded string array`);
  }
  return value.map((entry) => {
    if (
      typeof entry !== "string"
      || !entry.trim()
      || entry.length > 256
      || /[\u0000-\u001f\u007f]/.test(entry)
    ) throw new Error(`managed organization role '${field}' contains an invalid value`);
    return entry.trim();
  });
}

function parseOrganizationBundleRole(value: unknown): OrganizationBundleRole {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("managed organization role entry is invalid");
  }
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !ORG_ROLE_KEYS.has(key));
  if (unknown.length) throw new Error(`managed organization role contains unsupported field '${unknown[0]}'`);
  const name = organizationRoleString(input.name, "name", true)!;
  if (!SAFE_ORG_ROLE_NAME.test(name) || WINDOWS_RESERVED_ROLE_NAME.test(name)) {
    throw new Error(`managed organization role name '${name}' is unsafe`);
  }
  return {
    name,
    ...(input.description !== undefined ? { description: organizationRoleString(input.description, "description") } : {}),
    ...(input.owns !== undefined ? { owns: organizationRoleList(input.owns, "owns") } : {}),
    ...(input.rejects !== undefined ? { rejects: organizationRoleList(input.rejects, "rejects") } : {}),
    ...(input.model !== undefined ? { model: organizationRoleString(input.model, "model") } : {}),
    ...(input.reasoning_effort !== undefined
      ? { reasoning_effort: organizationRoleReasoningEffort(input.reasoning_effort) }
      : {}),
    ...(input.allow_tools !== undefined ? { allow_tools: organizationRoleList(input.allow_tools, "allow_tools") } : {}),
    ...(input.deny_tools !== undefined ? { deny_tools: organizationRoleList(input.deny_tools, "deny_tools") } : {}),
    system: organizationRoleString(input.system, "system", true)!,
  };
}

/** Strictly validate one authenticated Control response before it can replace the last known-good
 * company snapshot. Roles and policy live in this single envelope so readers can never combine persona
 * v1 with policy v2 while concurrent refreshes race. */
export function parseOrganizationRoleBundleEnvelope(raw: unknown): OrganizationRoleBundleSnapshot {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("managed organization role bundle is invalid");
  }
  const input = raw as Record<string, unknown>;
  const unknown = Object.keys(input).filter((key) => !ORG_BUNDLE_KEYS.has(key));
  if (unknown.length) throw new Error(`managed organization role bundle contains unsupported field '${unknown[0]}'`);
  if (!Number.isSafeInteger(input.version) || Number(input.version) < 0) {
    throw new Error("managed organization role bundle version is invalid");
  }
  if (!input.org_policy || typeof input.org_policy !== "object" || Array.isArray(input.org_policy)) {
    throw new Error("managed organization role bundle policy is missing or invalid");
  }
  if (!Array.isArray(input.roles) || input.roles.length > 256) {
    throw new Error("managed organization role bundle roles are missing or invalid");
  }
  const version = Number(input.version);
  const orgPolicy = { ...(input.org_policy as Record<string, unknown>) };
  const wireRoles = input.roles.map(parseOrganizationBundleRole);
  const names = new Set<string>();
  for (const role of wireRoles) {
    if (names.has(role.name)) throw new Error(`managed organization role '${role.name}' is duplicated`);
    names.add(role.name);
  }
  const envelope = { version, org_policy: orgPolicy, roles: wireRoles } satisfies OrganizationRoleBundleEnvelope;
  const policy = parseOrganizationExecutionPolicyEnvelope({ version, org_policy: orgPolicy });
  const roles = wireRoles.map((role): Role => {
    const metadata: Record<string, unknown> = {
      name: role.name,
      description: role.description ?? "",
      owns: role.owns ?? [],
      rejects: role.rejects ?? [],
      ...(role.model ? { model: role.model } : {}),
      ...(role.reasoning_effort ? { reasoningEffort: role.reasoning_effort } : {}),
      ...(role.allow_tools ? { allowTools: role.allow_tools } : {}),
      ...(role.deny_tools ? { denyTools: role.deny_tools } : {}),
    };
    return {
      id: role.name,
      description: role.description ?? "",
      owns: role.owns ?? [],
      rejects: role.rejects ?? [],
      ...(role.model ? { model: role.model } : {}),
      ...(role.reasoning_effort ? { reasoningEffort: role.reasoning_effort } : {}),
      ...(role.allow_tools ? { allowTools: role.allow_tools } : {}),
      ...(role.deny_tools ? { denyTools: role.deny_tools } : {}),
      source: "org",
      organizationPolicyVersion: version,
      identity: agentIdentityFromMetadata(metadata, role.name, role.description ?? "", "org"),
      system: role.system.trim(),
    };
  });
  return { version, policy, roles, envelope };
}

export function loadOrganizationRoleBundle(spaceId: string): OrganizationRoleBundleSnapshot | null {
  if (spaceId === "personal") return null;
  if (!isValidSpaceId(spaceId)) throw new Error("invalid Space id for managed organization role bundle");
  const directory = orgRolesDir(spaceId);
  const storageKey = directory.split(/[\\/]/).pop()!;
  return withPrivateStateLockSync(homedir(), ["org-roles", storageKey], "_bundle.json.snapshot", () => {
    const file = join(directory, "_bundle.json");
    if (!existsSync(file)) return null;
    const raw = readModelContextFileSync(file, MAX_ORG_BUNDLE_BYTES);
    try {
      return parseOrganizationRoleBundleEnvelope(JSON.parse(raw));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error("managed organization role bundle is not valid JSON");
      throw error;
    }
  }, { busyMessage: "managed organization role bundle is busy; retry the operation" });
}

export function loadOrganizationExecutionPolicy(spaceId: string): OrganizationExecutionPolicy | null {
  return loadOrganizationRoleBundle(spaceId)?.policy ?? null;
}

export function assertOrganizationModelAllowed(
  policy: OrganizationExecutionPolicy,
  model: string,
): void {
  if (policy.modelDeny?.includes(model)) {
    throw new Error(`model '${model}' is denied by organization policy`);
  }
  if (policy.modelAllow && !policy.modelAllow.includes(model)) {
    throw new Error(`model '${model}' is not allowed by organization policy`);
  }
}
/** Claude-Code subagents (`.claude/agents/*.md`) — consumed for ecosystem interop (project scope). */
export function claudeAgentsDir(cwd: string): string {
  return join(findProjectRoot(cwd), ".claude", "agents");
}
/** Claude-Code tool names → hara tool names, for `.claude/agents` interop. Without this, a CC agent
 *  with `tools: Read, Edit, Bash` produced allowTools that matched ZERO hara tools — the role spawned
 *  with an empty toolbox. Unknown names pass through verbatim (they may be hara names already). */
const CLAUDE_TOOL_MAP: Record<string, string> = {
  read: "read_file",
  edit: "edit_file",
  write: "write_file",
  bash: "bash",
  grep: "grep",
  glob: "glob",
  ls: "ls",
  webfetch: "web_fetch",
  websearch: "web_search",
  agent: "agent",
  task: "agent",
  todowrite: "todo_write",
  notebookedit: "edit_file",
};
/** Accept Claude-Code `tools:` (comma string or list) as an alias for hara's allowTools —
 *  translating CC tool names to hara's. "All tools" / "*" means unrestricted → undefined. */
export function claudeTools(v: unknown): string[] | undefined {
  const raw = Array.isArray(v)
    ? (v as string[])
    : typeof v === "string" && v.trim()
      ? v.split(",").map((s) => s.trim()).filter(Boolean)
      : null;
  if (!raw || !raw.length) return undefined;
  if (raw.some((t) => /^(\*|all tools?)$/i.test(t))) return undefined; // unrestricted
  return raw.map((t) => CLAUDE_TOOL_MAP[t.toLowerCase().replace(/[^a-z]/g, "")] ?? t);
}

function parseFrontmatter(text: string): { fm: Record<string, any>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { fm: {}, body: text.trim() };
  const fm: Record<string, any> = {};
  for (const raw of m[1].split(/\r?\n/)) {
    // This is intentionally a small top-level parser, not YAML. Do not trim before matching: nested
    // metadata such as `persona:\n  name: Vera` must never overwrite the role's top-level `name`.
    if (/^\s/.test(raw)) continue;
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const key = kv[1];
    const val = kv[2].trim();
    if (val.startsWith("[") && val.endsWith("]")) {
      try {
        const parsed = JSON.parse(val);
        fm[key] = Array.isArray(parsed) ? parsed : [];
      } catch {
        fm[key] = val
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
      }
    } else if (val.startsWith('"') && val.endsWith('"')) {
      try { fm[key] = JSON.parse(val); } catch { fm[key] = val.slice(1, -1); }
    } else {
      fm[key] = val.replace(/^["']|["']$/g, "");
    }
  }
  return { fm, body: m[2].trim() };
}

const DEFAULT_MAIN_AGENT_IDENTITY: AgentPublicIdentity = {
  version: 1,
  displayName: "Hara",
  title: "Main Agent",
  bio: "Coordinates the team, owns the conversation, and turns requests into verified work.",
  traits: ["direct", "resourceful", "evidence-led"],
  emoji: "✦",
  theme: "warm editorial studio",
  accent: "#ff695f",
  character: "orchestrator",
  source: "hara",
};

const PUBLIC_IDENTITY_KEYS = new Set([
  "displayName", "display-name", "public-name", "chinese-name",
  "title", "role", "bio", "vibe", "traits", "personality-traits",
  "emoji", "avatar", "logo", "identity-theme", "theme", "vibe-theme",
  "accent", "accent-color", "character", "sprite", "creature",
]);

function identityRevision(text: string): string {
  return createHash("sha256").update("hara-agent-public-profile-v1\0").update(text).digest("hex").slice(0, 32);
}

function mainAgentIdentityPath(): string {
  return join(globalRolesDir(), ".main-agent.json");
}

export function loadMainAgentIdentity(): AgentPublicIdentity {
  try {
    const parsed = JSON.parse(readModelContextFileSync(mainAgentIdentityPath(), MAX_ROLE_BYTES));
    return normalizeAgentPublicIdentityInput(parsed, "main", "global");
  } catch {
    return { ...DEFAULT_MAIN_AGENT_IDENTITY, traits: [...(DEFAULT_MAIN_AGENT_IDENTITY.traits ?? [])] };
  }
}

export function mainAgentIdentityRevision(): string {
  try {
    return identityRevision(readModelContextFileSync(mainAgentIdentityPath(), MAX_ROLE_BYTES));
  } catch {
    return identityRevision(JSON.stringify(DEFAULT_MAIN_AGENT_IDENTITY));
  }
}

export function nativeRoleIdentityRevision(role: Role): string | undefined {
  if ((role.source !== "global" && role.source !== "project") || !role.file) return undefined;
  try { return identityRevision(readModelContextFileSync(role.file, MAX_ROLE_BYTES)); } catch { return undefined; }
}

/** Optimistic-concurrency token for every discoverable personal Agent, including read-in-place roles.
 * Only the digest crosses Serve; private prompt text and external filesystem metadata never do. */
export function agentRoleRevision(role: Role): string {
  const native = nativeRoleIdentityRevision(role);
  if (native) return native;
  return identityRevision(JSON.stringify({
    id: role.id,
    source: role.source,
    file: role.file,
    home: role.home,
    description: role.description,
    model: role.model,
    reasoningEffort: role.reasoningEffort,
    owns: role.owns,
    rejects: role.rejects,
    allowTools: role.allowTools,
    denyTools: role.denyTools,
    readOnly: role.readOnly,
    identity: role.identity,
    blueprint: role.blueprint,
    system: role.system,
  }));
}

function identityFrontmatterLines(identity: AgentPublicIdentity): string[] {
  const lines = [`display-name: ${JSON.stringify(identity.displayName)}`];
  if (identity.title) lines.push(`title: ${JSON.stringify(identity.title)}`);
  if (identity.bio) lines.push(`bio: ${JSON.stringify(identity.bio)}`);
  if (identity.traits?.length) lines.push(`traits: ${JSON.stringify(identity.traits)}`);
  if (identity.emoji) lines.push(`emoji: ${JSON.stringify(identity.emoji)}`);
  if (identity.avatar) lines.push(`avatar: ${JSON.stringify(identity.avatar)}`);
  if (identity.theme) lines.push(`identity-theme: ${JSON.stringify(identity.theme)}`);
  if (identity.accent) lines.push(`accent: ${JSON.stringify(identity.accent)}`);
  if (identity.character) lines.push(`character: ${JSON.stringify(identity.character)}`);
  return lines;
}

const BLUEPRINT_ID_RE = /^[a-z0-9][a-z0-9._/-]{0,159}$/;
const BLUEPRINT_VERSION_RE = /^[a-z0-9][a-z0-9._+-]{0,63}$/i;
const BLUEPRINT_REVISION_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const BLUEPRINT_DIGEST_RE = /^[a-f0-9]{64}$/;

function boundedBlueprintText(value: unknown, field: string, cap: number): string {
  if (typeof value !== "string") throw new Error(`Agent blueprint ${field} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > cap || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`Agent blueprint ${field} must be non-empty, bounded, and contain no control characters`);
  }
  return normalized;
}

function normalizeBlueprintInstallInput(input: AgentBlueprintInstallInput): AgentBlueprintInstallInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Agent blueprint provenance must be an object");
  }
  const id = boundedBlueprintText(input.id, "id", 160).toLowerCase();
  const version = boundedBlueprintText(input.version, "version", 64);
  const publisher = boundedBlueprintText(input.publisher, "publisher", 100);
  const source = boundedBlueprintText(input.source, "source", 512);
  const sourceRevision = boundedBlueprintText(input.sourceRevision, "sourceRevision", 128);
  const license = boundedBlueprintText(input.license, "license", 64);
  if (!BLUEPRINT_ID_RE.test(id)) throw new Error("Agent blueprint id is invalid");
  if (!BLUEPRINT_VERSION_RE.test(version)) throw new Error("Agent blueprint version is invalid");
  if (!BLUEPRINT_REVISION_RE.test(sourceRevision)) throw new Error("Agent blueprint sourceRevision is invalid");
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(source);
  } catch {
    throw new Error("Agent blueprint source must be an absolute HTTPS URL");
  }
  if (sourceUrl.protocol !== "https:" || sourceUrl.username || sourceUrl.password || sourceUrl.search || sourceUrl.hash) {
    throw new Error("Agent blueprint source must be a credential-free HTTPS URL");
  }
  return { id, version, publisher, source: sourceUrl.toString(), sourceRevision, license };
}

function blueprintInstallDigest(input: AgentBlueprintInstallInput, instructions: string): string {
  return createHash("sha256")
    .update("hara-agent-blueprint-install-v1\0")
    .update(JSON.stringify(input))
    .update("\0")
    .update(instructions)
    .digest("hex");
}

function blueprintFrontmatterLines(blueprint: AgentBlueprintProvenance): string[] {
  return [
    `blueprint-id: ${JSON.stringify(blueprint.id)}`,
    `blueprint-version: ${JSON.stringify(blueprint.version)}`,
    `blueprint-publisher: ${JSON.stringify(blueprint.publisher)}`,
    `blueprint-source: ${JSON.stringify(blueprint.source)}`,
    `blueprint-source-revision: ${JSON.stringify(blueprint.sourceRevision)}`,
    `blueprint-license: ${JSON.stringify(blueprint.license)}`,
    `blueprint-digest: ${JSON.stringify(blueprint.digest)}`,
  ];
}

function blueprintFromMetadata(
  metadata: Record<string, unknown>,
  instructions: string,
): AgentBlueprintProvenance | undefined {
  try {
    const normalized = normalizeBlueprintInstallInput({
      id: metadata["blueprint-id"] as string,
      version: metadata["blueprint-version"] as string,
      publisher: metadata["blueprint-publisher"] as string,
      source: metadata["blueprint-source"] as string,
      sourceRevision: metadata["blueprint-source-revision"] as string,
      license: metadata["blueprint-license"] as string,
    });
    const digest = String(metadata["blueprint-digest"] ?? "").trim().toLowerCase();
    if (!BLUEPRINT_DIGEST_RE.test(digest) || digest !== blueprintInstallDigest(normalized, instructions)) {
      return undefined;
    }
    return { ...normalized, digest };
  } catch {
    return undefined;
  }
}

function replacePublicIdentityFrontmatter(text: string, identity: AgentPublicIdentity): string {
  const match = /^---(\r?\n)([\s\S]*?)(\r?\n)---(\r?\n?)([\s\S]*)$/.exec(text);
  if (!match) throw new Error("native Agent file has no editable top-level frontmatter");
  const newline = match[1];
  const retained = match[2].split(/\r?\n/).filter((line) => {
    if (/^\s/.test(line)) return true;
    const key = /^([A-Za-z0-9_-]+)\s*:/.exec(line)?.[1];
    return !key || !PUBLIC_IDENTITY_KEYS.has(key);
  });
  return `---${newline}${[...retained, ...identityFrontmatterLines(identity)].join(newline)}${match[3]}---${match[4]}${match[5]}`;
}

function setTopLevelFrontmatterField(text: string, key: string, value: string): string {
  const match = /^---(\r?\n)([\s\S]*?)(\r?\n)---(\r?\n?)([\s\S]*)$/.exec(text);
  if (!match) throw new Error("native Agent file has no editable top-level frontmatter");
  const newline = match[1];
  const retained = match[2].split(/\r?\n/).filter((line) => {
    if (/^\s/.test(line)) return true;
    return /^([A-Za-z0-9_-]+)\s*:/.exec(line)?.[1] !== key;
  });
  return `---${newline}${[...retained, `${key}: ${value}`].join(newline)}${match[3]}---${match[4]}${match[5]}`;
}

function setOptionalTopLevelFrontmatterField(
  text: string,
  key: string,
  value: string | undefined,
): string {
  const match = /^---(\r?\n)([\s\S]*?)(\r?\n)---(\r?\n?)([\s\S]*)$/.exec(text);
  if (!match) throw new Error("native Agent file has no editable top-level frontmatter");
  const newline = match[1];
  const retained = match[2].split(/\r?\n/).filter((line) => {
    if (/^\s/.test(line)) return true;
    return /^([A-Za-z0-9_-]+)\s*:/.exec(line)?.[1] !== key;
  });
  const fields = value === undefined ? retained : [...retained, `${key}: ${value}`];
  return `---${newline}${fields.join(newline)}${match[3]}---${match[4]}${match[5]}`;
}

function normalizeAgentExecutionPreferences(
  input: AgentExecutionPreferencesInput,
): { model?: string; reasoningEffort?: string } {
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (model && (model.length > 512 || /[\u0000-\u001f\u007f]/.test(model))) {
    throw new Error("Agent model must be at most 512 printable characters");
  }
  const reasoningEffort = typeof input.reasoningEffort === "string"
    ? input.reasoningEffort.trim()
    : "";
  if (reasoningEffort && !AGENT_REASONING_EFFORTS.has(reasoningEffort)) {
    throw new Error(`Agent reasoning effort '${reasoningEffort}' is invalid`);
  }
  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

export async function createNativeGlobalAgent(
  input: CreateNativeAgentInput,
): Promise<{ id: string; identity: AgentPublicIdentity; revision: string }> {
  const id = input.id.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(id) || id === "main" || id === "readme") {
    throw new Error("Agent username must use 1-64 lowercase letters, numbers, dots, underscores, or dashes and cannot be reserved");
  }
  const identity = normalizeAgentPublicIdentityInput(input.profile, id, "global");
  const description = String(input.description ?? identity.bio ?? identity.title ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ROLE_DESCRIPTION_CAP);
  const rawInstructions = String(input.instructions ?? "").trim();
  if (rawInstructions.length > 16_000 || rawInstructions.includes("\0")) {
    throw new Error("Agent instructions must be 16,000 characters or fewer and contain no NUL bytes");
  }
  const instructions = rawInstructions || [
    `You are ${identity.displayName}${identity.title ? `, ${identity.title}` : ""}.`,
    identity.bio || description,
    identity.traits?.length ? `Work style: ${identity.traits.join(", ")}.` : "",
    "Take ownership of assigned work, use available tools, and return verified outcomes instead of handing routine execution back to the user.",
  ].filter(Boolean).join("\n\n");
  const blueprintInput = input.blueprint ? normalizeBlueprintInstallInput(input.blueprint) : undefined;
  const blueprint = blueprintInput
    ? { ...blueprintInput, digest: blueprintInstallDigest(blueprintInput, instructions) }
    : undefined;
  const execution = normalizeAgentExecutionPreferences(input.execution ?? {});
  const file = join(globalRolesDir(), `${id}.md`);
  const content = [
    "---",
    `name: ${id}`,
    `description: ${JSON.stringify(description || `${identity.displayName} Agent`)}`,
    ...(execution.model ? [`model: ${JSON.stringify(execution.model)}`] : []),
    ...(execution.reasoningEffort ? [`reasoning-effort: ${JSON.stringify(execution.reasoningEffort)}`] : []),
    ...identityFrontmatterLines(identity),
    ...(blueprint ? blueprintFrontmatterLines(blueprint) : []),
    "---",
    instructions,
    "",
  ].join("\n");
  const boundary = bindAtomicWritePath(file, "hire personal Agent");
  await atomicWriteText(boundary.target, content, {
    expected: null,
    boundary,
    mode: 0o600,
  });
  invalidateRolesCache();
  return { id, identity, revision: identityRevision(content) };
}

/** "Dismiss" is a recoverable archive: the prompt stays on disk with `archived: true`, while all role
 * loaders omit it. This avoids an irreversible delete from a one-click game/social surface. */
export async function archiveNativeRoleAgent(role: Role, expectedRevision: string): Promise<void> {
  if ((role.source !== "global" && role.source !== "project") || !role.file) {
    throw new Error("this Agent is managed by an organization or external tool and cannot be dismissed here");
  }
  const target = realpathSync.native(role.file);
  const snapshot = await readRegularFileSnapshotNoFollow(target, MAX_ROLE_BYTES);
  if (identityRevision(snapshot.text) !== expectedRevision) throw new Error("agent profile changed; refresh and retry");
  const content = setTopLevelFrontmatterField(snapshot.text, "archived", "true");
  await atomicWriteText(target, content, {
    expected: snapshot.text,
    expectedIdentity: snapshot,
    boundary: bindAtomicWritePath(target, "archive personal Agent"),
    mode: snapshot.mode & 0o777,
  });
  invalidateRolesCache();
}

export async function updateMainAgentIdentity(
  input: AgentPublicIdentityInput,
  expectedRevision: string,
): Promise<{ identity: AgentPublicIdentity; revision: string }> {
  const identity = normalizeAgentPublicIdentityInput(input, "main", "global");
  const path = mainAgentIdentityPath();
  const boundary = bindAtomicWritePath(path, "update main Agent profile");
  let snapshot: RegularFileSnapshot | null = null;
  try {
    snapshot = await readRegularFileSnapshotNoFollow(boundary.target, MAX_ROLE_BYTES);
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
  const currentRevision = snapshot
    ? identityRevision(snapshot.text)
    : identityRevision(JSON.stringify(DEFAULT_MAIN_AGENT_IDENTITY));
  if (currentRevision !== expectedRevision) throw new Error("agent profile changed; refresh and retry");
  const content = JSON.stringify(identity, null, 2) + "\n";
  await atomicWriteText(boundary.target, content, {
    expected: snapshot?.text ?? null,
    expectedIdentity: snapshot ?? undefined,
    boundary,
    mode: 0o600,
  });
  return { identity, revision: identityRevision(content) };
}

export async function updateNativeRoleIdentity(
  role: Role,
  input: AgentPublicIdentityInput,
  expectedRevision: string,
  execution?: AgentExecutionPreferencesInput,
): Promise<{ identity: AgentPublicIdentity; revision: string }> {
  if ((role.source !== "global" && role.source !== "project") || !role.file) {
    throw new Error("this Agent is managed by an organization or external tool and is read-only here");
  }
  const target = realpathSync.native(role.file);
  const snapshot = await readRegularFileSnapshotNoFollow(target, MAX_ROLE_BYTES);
  if (identityRevision(snapshot.text) !== expectedRevision) throw new Error("agent profile changed; refresh and retry");
  const identity = normalizeAgentPublicIdentityInput(input, role.id, role.source);
  let content = replacePublicIdentityFrontmatter(snapshot.text, identity);
  if (execution !== undefined) {
    const normalized = normalizeAgentExecutionPreferences(execution);
    if (Object.prototype.hasOwnProperty.call(execution, "model")) {
      content = setOptionalTopLevelFrontmatterField(
        content,
        "model",
        normalized.model ? JSON.stringify(normalized.model) : undefined,
      );
    }
    if (Object.prototype.hasOwnProperty.call(execution, "reasoningEffort")) {
      content = setOptionalTopLevelFrontmatterField(
        content,
        "reasoning-effort",
        normalized.reasoningEffort ? JSON.stringify(normalized.reasoningEffort) : undefined,
      );
    }
  }
  await atomicWriteText(target, content, {
    expected: snapshot.text,
    expectedIdentity: snapshot,
    boundary: bindAtomicWritePath(target, "update Agent public profile"),
    mode: snapshot.mode & 0o777,
  });
  invalidateRolesCache();
  return { identity, revision: identityRevision(content) };
}

/** Tool filter for a fan-out sub-agent: ALWAYS read-only (sub-agents run full-auto + unconfirmed +
 *  parallel), with a role allowed to narrow further but never to grant write/exec. `isReadonly` is the
 *  read-kind predicate. This is the guard that keeps the `agent` tool from bypassing the approval gate. */
export function subagentToolFilter(role: Role | undefined, isReadonly: (n: string) => boolean): (n: string) => boolean {
  // Treat allow + deny as an intersection when both are present. A deny must never disappear merely
  // because an allow-list was also declared (mixed policies are common in generated role bundles).
  const roleFilter = role?.allowTools || role?.denyTools
    ? (n: string) => (!role.allowTools || role.allowTools.includes(n)) && (!role.denyTools || !role.denyTools.includes(n))
    : null;
  return (n) => isReadonly(n) && (roleFilter ? roleFilter(n) : true);
}

/** Apply a role's declared tool policy to a normal (approval-gated) run. Undefined means unrestricted. */
export function roleToolFilter(role: Role | undefined): ((name: string) => boolean) | undefined {
  if (!role) return undefined;
  const declared = (name: string): boolean =>
    (!role.allowTools || role.allowTools.includes(name)) && (!role.denyTools || !role.denyTools.includes(name));
  if (role.readOnly) {
    // Raw bash is intentionally absent: even commands that look read-only can hide redirection, command
    // substitution, hooks, or an executable with side effects. Reviewers get dedicated read/search tools.
    const safe = new Set(["read_file", "grep", "glob", "ls", "web_fetch", "web_search", "codebase_search", "todo_write"]);
    return (name) => safe.has(name) && declared(name);
  }
  return role.allowTools || role.denyTools ? declared : undefined;
}

function externalRoles(): Role[] {
  return loadExternalAgentRoles().map((role): Role => ({
    id: role.id,
    description: role.description,
    owns: [],
    rejects: [],
    source: role.source,
    file: role.home || undefined,
    identity: role.identity,
    home: role.home || undefined,
    system: role.system,
  }));
}

function mergedRoles(...layers: Iterable<Role>[]): Role[] {
  const byId = new Map<string, Role>();
  for (const layer of layers) {
    for (const role of layer) byId.set(role.id, role);
  }
  return [...byId.values()];
}

/** A persisted gateway profile is authoritative. The profile-scoped managed-role directory is also a
 * fail-closed legacy signal: older enrollments and embedders can sync a verified Control bundle before
 * the corresponding profile record is migrated into profiles.json. In that state, exposing personal or
 * imported prompts would widen the company audience, while treating it as managed keeps the safer side. */
function isOrganizationRoleProfile(profileId: string): boolean {
  return getProfile(profileId)?.kind === "gateway"
    || (isValidProfileId(profileId) && existsSync(orgRolesDir(profileId)));
}

export function loadRoles(cwd: string, profileId?: string): Role[] {
  const selectedProfileId = profileId ?? resolveActive(cwd).id;
  const organizationProfile = isOrganizationRoleProfile(selectedProfileId);
  // Company Spaces expose only Control-managed Agents. Personal/global/imported prompts must never
  // silently enter a company audience merely because their local name is available on the device.
  if (organizationProfile) {
    const profile = getProfile(selectedProfileId);
    const spaceId = profile?.kind === "gateway" ? spaceIdForProfile(profile) : selectedProfileId;
    return isValidSpaceId(spaceId) ? (loadOrganizationRoleBundle(spaceId)?.roles ?? []) : [];
  }
  // lowest→highest precedence: plugins < installed interop identities < org(B-end push)
  // < personal Claude < personal Hara < project Claude < project Hara. Native Hara wins collisions.
  return mergedRoles(
    rolesFromDirs(pluginRoleDirs().map((dir): RoleDir => ({ dir, source: "plugin" }))).values(),
    externalRoles(),
    rolesFromDirs([
      { dir: globalClaudeAgentsDir(), source: "claude-global" },
      { dir: globalRolesDir(), source: "global" },
      { dir: claudeAgentsDir(cwd), source: "claude-project" },
      { dir: rolesDir(cwd), source: "project" },
    ]).values(),
  );
}

/** The project-independent layers only — what the global agent index lists as "runs anywhere".
 *  Personal Claude Code agents participate directly; no copy/import step is required. */
export function loadGlobalRoles(profileId?: string): Role[] {
  const selectedProfileId = profileId ?? resolveActive().id;
  const organizationProfile = isOrganizationRoleProfile(selectedProfileId);
  if (organizationProfile) {
    const profile = getProfile(selectedProfileId);
    const spaceId = profile?.kind === "gateway" ? spaceIdForProfile(profile) : selectedProfileId;
    return isValidSpaceId(spaceId) ? (loadOrganizationRoleBundle(spaceId)?.roles ?? []) : [];
  }
  return mergedRoles(
    rolesFromDirs(pluginRoleDirs().map((dir): RoleDir => ({ dir, source: "plugin" }))).values(),
    externalRoles(),
    rolesFromDirs([
      { dir: globalClaudeAgentsDir(), source: "claude-global" },
      { dir: globalRolesDir(), source: "global" },
    ]).values(),
  );
}

interface RoleDir {
  dir: string;
  source: RoleSource;
}

const isTrue = (value: unknown): boolean => value === true || String(value).toLowerCase() === "true";

function claudeCompatibilityWarnings(description: string, body: string): string[] {
  const warnings: string[] = [];
  if (/\bcalled by\b.*\b(?:only|workflows? only)\b/i.test(description)) warnings.push("workflow-only");
  if (/\b(?:must be used|mandatory before|always use)\b/i.test(description)) {
    warnings.push("mandatory auto-invocation directive");
  }
  if (/localhost:\d+\/notify|YOUR_VOICE_ID(?:_HERE)?|voice notification/i.test(body)) {
    warnings.push("local notification dependency");
  }
  if (/(?:~|\/Users\/[^/\s]+)\/\.claude\/skills\//i.test(body)) warnings.push("Claude-only skill dependency");
  return [...new Set(warnings)];
}

function rolesFromDirs(dirs: RoleDir[]): Map<string, Role> {
  const byId = new Map<string, Role>();
  for (const { dir, source } of dirs) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".md") || f === "README.md") continue;
      try {
        const file = join(dir, f);
        const { fm, body } = parseFrontmatter(readModelContextFileSync(file, MAX_ROLE_BYTES));
        const id = (fm.name as string) || f.replace(/\.md$/, "");
        if (isTrue(fm.archived)) continue;
        const explicitReadOnly = /^(true|false)$/i.test(String(fm.readOnly ?? ""))
          ? String(fm.readOnly).toLowerCase() === "true"
          : undefined;
        const claudeSource = source === "claude-global" || source === "claude-project";
        const compatibilityWarnings = claudeSource
          ? claudeCompatibilityWarnings(String(fm.description ?? ""), body)
          : [];
        const rawModel = fm.model ? String(fm.model) : "";
        const rawReasoningEffort = fm["reasoning-effort"] ? String(fm["reasoning-effort"]).trim() : "";
        const foreignClaudeModel = claudeSource && /^claude(?:[-_.]|$)/i.test(rawModel);
        byId.set(id, {
          id,
          description: (fm.description as string) || "",
          owns: Array.isArray(fm.owns) ? fm.owns : [],
          rejects: Array.isArray(fm.rejects) ? fm.rejects : [],
          // Claude aliases and Claude-provider ids cannot safely switch Hara's active provider — inherit
          // the session model instead of passing a foreign id to (for example) a Qwen/OpenAI endpoint.
          model: rawModel && !/^(sonnet|opus|haiku|inherit)$/i.test(rawModel) && !foreignClaudeModel
            ? rawModel
            : undefined,
          reasoningEffort: AGENT_REASONING_EFFORTS.has(rawReasoningEffort)
            ? rawReasoningEffort
            : undefined,
          allowTools: Array.isArray(fm.allowTools) ? fm.allowTools : claudeTools(fm.tools),
          denyTools: Array.isArray(fm.denyTools) ? fm.denyTools : undefined,
          readOnly: explicitReadOnly ?? (id.toLowerCase() === "reviewer" ? true : undefined),
          modelInvocable: !isTrue(fm["disable-model-invocation"]) && compatibilityWarnings.length === 0,
          compatibilityWarnings,
          source,
          file,
          identity: agentIdentityFromMetadata(fm, id, String(fm.description ?? ""), source),
          blueprint: blueprintFromMetadata(fm, body),
          system: body,
        });
      } catch {
        /* skip bad role file */
      }
    }
  }
  return byId;
}

function compactRoleDescription(role: Role): string {
  const description = role.description.replace(/\s+/g, " ").trim();
  if (!description || !scanMemory(description).ok) return "";
  return description.length > ROLE_DESCRIPTION_CAP
    ? description.slice(0, ROLE_DESCRIPTION_CAP - 1).trimEnd() + "…"
    : description;
}

/** Compact metadata catalog for dispatch/planning. Role bodies remain progressive: only the selected role's
 *  persona is injected into its run. Descriptions are bounded and guarded because plugin roles can be
 *  untrusted. */
export function roleCatalog(roles: Role[], cap = ROLE_DIGEST_CAP): string {
  const lines: string[] = [];
  const sourceRank: Record<RoleSource, number> = {
    project: 0,
    "claude-project": 1,
    global: 2,
    "claude-global": 3,
    org: 4,
    openclaw: 5,
    hermes: 6,
    plugin: 7,
  };
  const ordered = [...roles].sort((a, b) => {
    const source = (sourceRank[a.source ?? "plugin"] ?? 9) - (sourceRank[b.source ?? "plugin"] ?? 9);
    if (source) return source;
    const ownership = Number(b.owns.length > 0) - Number(a.owns.length > 0);
    if (ownership) return ownership;
    return a.id.localeCompare(b.id);
  });
  for (const role of ordered) {
    if (role.modelInvocable === false) continue;
    const description = compactRoleDescription(role);
    if (!description) continue;
    const flags = [role.readOnly ? "read-only" : "", role.source?.startsWith("claude-") ? "Claude-compatible" : ""]
      .filter(Boolean)
      .join(", ");
    lines.push(`- ${role.id}${flags ? ` [${flags}]` : ""}: ${description}`);
  }
  let digest = lines.join("\n");
  if (digest.length > cap) digest = digest.slice(0, cap) + "\n…";
  return digest;
}

let roleDigestCache = new Map<string, string>();

/** Frozen-per-session specialist index for the ordinary Hara agent. This is the missing Claude-style
 *  discovery layer: the main agent sees role metadata, then loads only the chosen persona through agent/org. */
export function rolesDigest(cwd: string, profileId?: string): string {
  const selectedProfileId = profileId ?? resolveActive(cwd).id;
  const cacheKey = `${cwd}\0${selectedProfileId}`;
  if (roleDigestCache.has(cacheKey)) return roleDigestCache.get(cacheKey)!;
  const digest = roleCatalog(loadRoles(cwd, selectedProfileId));
  roleDigestCache.set(cacheKey, digest);
  return digest;
}

export function invalidateRolesCache(): void {
  roleDigestCache.clear();
}

export function hasRoles(cwd: string, profileId?: string): boolean {
  return loadRoles(cwd, profileId).length > 0;
}

const SCAFFOLD: Record<string, string> = {
  "implementer.md": `---
name: implementer
description: Implements features, fixes bugs, and refactors code.
owns: [implement, add, feature, fix, bug, refactor, build, create, write, change]
model:
---
You are the **implementer** on an engineering team. You write and change code to satisfy the task.
Make small, verifiable edits (prefer edit_file over rewriting). Run tests/build when relevant.
End with a one-line summary of what changed.
`,
  "reviewer.md": `---
name: reviewer
description: Reviews code for bugs, correctness, security, and style. Does not modify code.
owns: [review, audit, check, correctness, security, vulnerability, lint, quality]
allowTools: [read_file, grep, glob, ls, codebase_search]
readOnly: true
---
You are the **reviewer**. Read the relevant code and report concrete issues (bug / correctness /
security / style) with file:line and a suggested fix. Do NOT edit files — your tool surface is enforced read-only.
Be specific; skip nitpicks unless asked.
`,
  "docs.md": `---
name: docs
description: Writes and updates documentation, READMEs, and code comments.
owns: [doc, docs, document, readme, comment, explain, guide, changelog]
---
You are the **docs** writer. Produce clear, concise documentation grounded in the actual code.
Update or create the relevant files with write_file/edit_file. Match the project's existing tone.
`,
  "README.md": `# Org roles

Each \`*.md\` here is a role-agent. Frontmatter:

- \`name\` — role id
- \`description\` — what it owns (used by the dispatcher)
- \`owns\` — keywords that route a task here (OWN)
- \`rejects\` — keywords that exclude this role (REJECT)
- \`model\` — optional model override
- \`allowTools\` / \`denyTools\` — restrict the role's tools
- \`readOnly\` — enforce read/search-only tools (defaults on for a role named \`reviewer\`)
- \`disable-model-invocation\` — hide the role from automatic routing while keeping explicit \`--role\` use
- public identity — \`display-name\`, \`title\`/\`role\`, \`bio\`/\`vibe\`, \`traits\`, \`emoji\`,
  \`avatar\`/\`logo\`, \`identity-theme\`, \`accent\`, and \`character\`/\`sprite\`

Installed OpenClaw Agent workspaces (\`IDENTITY.md\` + private \`SOUL.md\`/\`AGENTS.md\`) and a personal
Hermes \`SOUL.md\` are discovered read-only. A native Hara role with the same id always wins.

Run \`hara org "<task>"\` to dispatch a task to the owning role, or \`hara org --role <id> "<task>"\`.
`,
};

export function scaffoldRoles(cwd: string): string[] {
  const dir = rolesDir(cwd);
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const [name, content] of Object.entries(SCAFFOLD)) {
    const p = join(dir, name);
    if (!existsSync(p)) {
      writeFileSync(p, content, "utf8");
      written.push(name);
    }
  }
  if (written.length) invalidateRolesCache();
  return written;
}
