// Read-only interoperability for installed OpenClaw and Hermes identities. Only bounded presentation
// fields cross into Agent catalogs; SOUL/AGENTS text remains private execution context on the Role.
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  readModelContextFileSync,
  readVerifiedRegularFileBytesSync,
  readVerifiedRegularFileSnapshotSync,
} from "../fs-read.js";
import {
  agentIdentityFromMetadata,
  parseAgentIdentityMarkdown,
  type AgentPublicIdentity,
} from "./agent-identity.js";

export type ExternalAgentSource = "openclaw" | "hermes";

export interface ExternalAgentRoleDefinition {
  id: string;
  description: string;
  home: string;
  source: ExternalAgentSource;
  identity: AgentPublicIdentity;
  system: string;
}

const OPENCLAW_CONFIG_LIMIT = 1024 * 1024;
const EXTERNAL_CONTEXT_LIMIT = 128 * 1024;
const OPENCLAW_AGENT_LIMIT = 128;
// Base64 expands by 4/3. This stays below AgentPublicIdentity's 128 KiB data-URL boundary.
const AVATAR_BYTES_LIMIT = 90 * 1024;
const SAFE_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const EXTERNAL_ROLE_CACHE_MS = 1000;
let cachedRoles: { key: string; at: number; roles: ExternalAgentRoleDefinition[] } | undefined;

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function canonicalDirectory(value: unknown, fallback?: string): string | undefined {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (!raw) return undefined;
  const expanded = raw === "~"
    ? homedir()
    : raw.startsWith(`~${sep}`)
      ? join(homedir(), raw.slice(2))
      : raw;
  const lexical = isAbsolute(expanded) ? expanded : resolve(homedir(), expanded);
  try {
    const canonical = realpathSync.native(lexical);
    return statSync(canonical).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function boundedContext(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readModelContextFileSync(path, EXTERNAL_CONTEXT_LIMIT).trim();
  } catch {
    return "";
  }
}

function avatarMime(bytes: Buffer): string | undefined {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length >= png.length && bytes.subarray(0, png.length).equals(png)) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  const signature = bytes.length >= 6 ? bytes.toString("ascii", 0, 6) : "";
  if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  return undefined;
}

function embeddedWorkspaceAvatar(workspace: string, value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const raw = value.trim();
  if (!raw || raw.startsWith("http://") || raw.startsWith("https://")) return undefined;
  if (raw.startsWith("data:image/") || raw.startsWith("/avatars/") || raw.startsWith("/pets/")) return raw;
  if (isAbsolute(raw) || raw.includes("\0")) return undefined;
  try {
    const canonicalWorkspace = realpathSync.native(workspace);
    const canonicalFile = realpathSync.native(resolve(canonicalWorkspace, raw));
    const inside = relative(canonicalWorkspace, canonicalFile);
    if (!inside || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return undefined;
    const snapshot = readVerifiedRegularFileBytesSync(canonicalFile, AVATAR_BYTES_LIMIT, {
      action: "load Agent avatar",
      rejectHardLinks: true,
      protectSensitive: true,
    });
    const mime = avatarMime(snapshot.bytes);
    return mime ? `data:${mime};base64,${snapshot.bytes.toString("base64")}` : undefined;
  } catch {
    return undefined;
  }
}

function openClawAgentRecords(config: Record<string, unknown>): Array<Record<string, unknown>> {
  const agents = record(config.agents);
  if (!agents) return [];
  const found: Array<Record<string, unknown>> = [];
  const entries = record(agents.entries);
  if (entries) {
    for (const [id, value] of Object.entries(entries)) {
      const entry = record(value);
      if (entry) found.push({ ...entry, id: typeof entry.id === "string" ? entry.id : id });
    }
  }
  if (Array.isArray(agents.list)) {
    for (const value of agents.list) {
      const entry = record(value);
      if (entry) found.push(entry);
    }
  }
  const defaults = record(agents.defaults);
  return found.slice(0, OPENCLAW_AGENT_LIMIT).map((entry) => ({
    ...entry,
    workspace: entry.workspace ?? defaults?.workspace,
  }));
}

function readOpenClawConfig(path: string): Record<string, unknown> | undefined {
  try {
    const snapshot = readVerifiedRegularFileSnapshotSync(path, OPENCLAW_CONFIG_LIMIT, {
      action: "read installed OpenClaw Agent registry",
      rejectHardLinks: true,
      // The registry can contain credentials. Its raw object never leaves this module and remains subject
      // to the model-facing protected-file policy everywhere else.
      protectSensitive: false,
    });
    return record(JSON.parse(snapshot.text));
  } catch {
    return undefined;
  }
}

function openClawRoles(): ExternalAgentRoleDefinition[] {
  const config = readOpenClawConfig(join(homedir(), ".openclaw", "openclaw.json"));
  if (!config) return [];
  const byId = new Map<string, ExternalAgentRoleDefinition>();
  for (const entry of openClawAgentRecords(config)) {
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!SAFE_AGENT_ID.test(id)) continue;
    const workspace = canonicalDirectory(entry.workspace);
    if (!workspace) continue;
    const identityPath = join(workspace, "IDENTITY.md");
    const fileMetadata = existsSync(identityPath)
      ? parseAgentIdentityMarkdown(boundedContext(identityPath))
      : {};
    const configuredIdentity = record(entry.identity) ?? {};
    const metadata: Record<string, unknown> = {
      ...fileMetadata,
      ...(configuredIdentity.name !== undefined ? { "display-name": configuredIdentity.name } : {}),
      ...(configuredIdentity.theme !== undefined ? { theme: configuredIdentity.theme } : {}),
      ...(configuredIdentity.emoji !== undefined ? { emoji: configuredIdentity.emoji } : {}),
      "identity-source": "openclaw",
    };
    const avatar = embeddedWorkspaceAvatar(workspace, configuredIdentity.avatar ?? fileMetadata.avatar);
    if (avatar) metadata.avatar = avatar;
    const identity = agentIdentityFromMetadata(metadata, id, "", "openclaw");
    const soul = boundedContext(join(workspace, "SOUL.md"));
    const instructions = boundedContext(join(workspace, "AGENTS.md"));
    const privateParts = [
      soul ? `[OpenClaw SOUL.md — private Agent persona]\n${soul}` : "",
      instructions ? `[OpenClaw AGENTS.md — private operating instructions]\n${instructions}` : "",
    ].filter(Boolean);
    const system = privateParts.join("\n\n") || `You are ${identity.displayName}, an imported OpenClaw Agent.`;
    const description = identity.title || identity.bio || `Imported OpenClaw Agent: ${identity.displayName}`;
    byId.set(id, { id, description, home: workspace, source: "openclaw", identity, system });
  }
  return [...byId.values()];
}

function hermesRoles(): ExternalAgentRoleDefinition[] {
  const hermesHome = canonicalDirectory(process.env.HERMES_HOME, join(homedir(), ".hermes"));
  if (!hermesHome) return [];
  const soul = boundedContext(join(hermesHome, "SOUL.md"));
  if (!soul) return [];
  const identity = agentIdentityFromMetadata({
    "display-name": "Hermes",
    title: "Hermes Agent",
    bio: "Imported personal Hermes identity",
    emoji: "☤",
    "identity-source": "hermes",
  }, "hermes", "", "hermes");
  return [{
    id: "hermes",
    description: "Imported Hermes Agent personality",
    home: "",
    source: "hermes",
    identity,
    system: `[Hermes SOUL.md — private Agent persona]\n${soul}`,
  }];
}

export function loadExternalAgentRoles(): ExternalAgentRoleDefinition[] {
  const key = `${homedir()}\0${process.env.HERMES_HOME ?? ""}`;
  const now = Date.now();
  if (cachedRoles?.key === key && now - cachedRoles.at < EXTERNAL_ROLE_CACHE_MS) return cachedRoles.roles;
  const roles = [...openClawRoles(), ...hermesRoles()];
  cachedRoles = { key, at: now, roles };
  return roles;
}
