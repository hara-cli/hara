/** Public, presentation-only Agent identity. This object may cross the Serve/Desktop boundary; role
 * system prompts, memories, model credentials, and tool policy must never be added here. */
export interface AgentPublicIdentity {
  version: 1;
  displayName: string;
  title?: string;
  bio?: string;
  traits?: string[];
  emoji?: string;
  /** Only packaged/app-relative or bounded data-image sources are emitted to clients. */
  avatar?: string;
  /** Human-readable art direction, for example "quiet editorial". */
  theme?: string;
  /** Optional CSS-friendly color token. */
  accent?: string;
  /** Stable character/sprite archetype slug. */
  character?: string;
  source: "hara" | "openclaw" | "hermes" | "claude" | "organization" | "plugin" | "derived";
}

export interface AgentPublicIdentityInput {
  displayName: string;
  title?: string;
  bio?: string;
  traits?: string[];
  emoji?: string;
  avatar?: string;
  theme?: string;
  accent?: string;
  character?: string;
}

const TEXT_CAPS = {
  displayName: 64,
  title: 80,
  bio: 220,
  theme: 72,
  emoji: 24,
  trait: 28,
} as const;
const TRAIT_LIMIT = 6;
const DATA_AVATAR_LIMIT = 128 * 1024;
const DATA_AVATAR_TEXT_LIMIT = Math.ceil(DATA_AVATAR_LIMIT * 4 / 3) + 128;
const SAFE_CHARACTER = /^[a-z0-9](?:[a-z0-9._-]{0,31})?$/;
const SAFE_ACCENT = /^#[0-9a-f]{6}$/i;
const SAFE_DATA_AVATAR = /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i;
const SAFE_PACKAGED_AVATAR = /^\/(?:avatars|pets)\/[a-z0-9_./-]+$/i;

function compactText(value: unknown, cap: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return undefined;
  return compact.length > cap ? `${compact.slice(0, cap - 1).trimEnd()}…` : compact;
}

function field(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
  }
  return undefined;
}

function humanizeAgentId(id: string): string {
  const compact = compactText(id.replace(/[._-]+/g, " "), TEXT_CAPS.displayName) ?? "Agent";
  return compact.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function identitySource(value: unknown, roleSource?: string): AgentPublicIdentity["source"] {
  const explicit = compactText(value, 24)?.toLowerCase();
  if (explicit === "openclaw" || explicit === "hermes") return explicit;
  if (roleSource === "openclaw" || roleSource === "hermes") return roleSource;
  if (roleSource?.startsWith("claude-")) return "claude";
  if (roleSource === "org") return "organization";
  if (roleSource === "plugin") return "plugin";
  if (roleSource === "global" || roleSource === "project") return "hara";
  return "derived";
}

function safeAvatar(value: unknown): string | undefined {
  const avatar = compactText(value, DATA_AVATAR_TEXT_LIMIT);
  if (!avatar) return undefined;
  if (SAFE_PACKAGED_AVATAR.test(avatar)) return avatar;
  if (avatar.length <= DATA_AVATAR_TEXT_LIMIT && SAFE_DATA_AVATAR.test(avatar)) {
    const payload = avatar.slice(avatar.indexOf(",") + 1);
    if (Buffer.from(payload, "base64").byteLength <= DATA_AVATAR_LIMIT) return avatar;
  }
  // Remote and arbitrary local paths intentionally remain private metadata. Automatically loading them
  // would turn an untrusted role catalog into a tracking request or a local-file disclosure channel.
  return undefined;
}

function safeTraits(value: unknown): string[] | undefined {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,，、]/)
      : [];
  const traits = [...new Set(raw
    .map((trait) => compactText(trait, TEXT_CAPS.trait))
    .filter((trait): trait is string => Boolean(trait)))]
    .slice(0, TRAIT_LIMIT);
  return traits.length ? traits : undefined;
}

/** Convert Hara role frontmatter plus OpenClaw/Hermes-compatible aliases into a bounded public profile. */
export function agentIdentityFromMetadata(
  metadata: Record<string, unknown>,
  fallbackId: string,
  fallbackDescription = "",
  roleSource?: string,
): AgentPublicIdentity {
  const displayName = compactText(
    field(metadata, "displayName", "display-name", "public-name", "chinese-name"),
    TEXT_CAPS.displayName,
  ) ?? humanizeAgentId(fallbackId);
  const title = compactText(field(metadata, "title", "role"), TEXT_CAPS.title);
  const bio = compactText(field(metadata, "bio", "vibe"), TEXT_CAPS.bio)
    ?? compactText(fallbackDescription, TEXT_CAPS.bio);
  const traits = safeTraits(field(metadata, "traits", "personality-traits"));
  const emoji = compactText(field(metadata, "emoji"), TEXT_CAPS.emoji);
  const avatar = safeAvatar(field(metadata, "avatar", "logo"));
  const theme = compactText(field(metadata, "identity-theme", "theme", "vibe-theme"), TEXT_CAPS.theme);
  const accentValue = compactText(field(metadata, "accent", "accent-color"), 7);
  const characterValue = compactText(field(metadata, "character", "sprite", "creature"), 32)?.toLowerCase();
  return {
    version: 1,
    displayName,
    ...(title ? { title } : {}),
    ...(bio ? { bio } : {}),
    ...(traits ? { traits } : {}),
    ...(emoji ? { emoji } : {}),
    ...(avatar ? { avatar } : {}),
    ...(theme ? { theme } : {}),
    ...(accentValue && SAFE_ACCENT.test(accentValue) ? { accent: accentValue.toLowerCase() } : {}),
    ...(characterValue && SAFE_CHARACTER.test(characterValue) ? { character: characterValue } : {}),
    source: identitySource(field(metadata, "identity-source", "identitySource"), roleSource),
  };
}

/** Validate a user-authored public profile before it is persisted. Normalization keeps display data
 * bounded, while unsafe avatar sources and malformed CSS/sprite tokens fail explicitly instead of being
 * silently stored and later interpreted by a client. */
export function normalizeAgentPublicIdentityInput(
  value: unknown,
  fallbackId: string,
  roleSource: string,
): AgentPublicIdentity {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("agent profile must be an object");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.displayName !== "string" || !input.displayName.trim()) {
    throw new Error("agent display name is required");
  }
  for (const key of ["title", "bio", "emoji", "avatar", "theme", "accent", "character"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "string") {
      throw new Error(`agent profile ${key} must be a string`);
    }
  }
  if (input.traits !== undefined && (!Array.isArray(input.traits) || input.traits.some((trait) => typeof trait !== "string"))) {
    throw new Error("agent profile traits must be a string array");
  }
  const identity = agentIdentityFromMetadata(input, fallbackId, "", roleSource);
  if (typeof input.avatar === "string" && input.avatar.trim() && !identity.avatar) {
    throw new Error("agent avatar must be a packaged /avatars or /pets path, or a bounded PNG/JPEG/WebP/GIF data image");
  }
  if (typeof input.accent === "string" && input.accent.trim() && !identity.accent) {
    throw new Error("agent accent must be a six-digit hex color");
  }
  if (typeof input.character === "string" && input.character.trim() && !identity.character) {
    throw new Error("agent character must use 1-32 lowercase letters, numbers, dots, underscores, or dashes");
  }
  return identity;
}

/** Parse the small public subset used by OpenClaw IDENTITY.md and Hermes-style profile documents. */
export function parseAgentIdentityMarkdown(text: string): Record<string, unknown> {
  const metadata: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/).slice(0, 80)) {
    const match = /^\s*[-*]\s+\*\*([^*]+):\*\*\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1].trim().toLowerCase().replace(/\s+/g, "-");
    if (["name", "chinese-name", "role", "vibe", "emoji", "avatar", "theme", "creature", "traits"].includes(key)) {
      metadata[key === "name" ? "display-name" : key] = match[2];
    }
  }
  return metadata;
}
