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
  /**
   * Immutable colour assigned when the colleague was created, so "restore initial colour" has a
   * real target instead of the first value a client happened to observe. Projection only: it is
   * not part of the editable profile and never changes after creation.
   */
  initialAccent?: string;
  /** Avatar silhouette. Persisted separately from the art-direction `theme` and `character`. */
  avatarStyle?: AgentAvatarStyle;
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
  avatarStyle?: AgentAvatarStyle;
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
/**
 * The eight colleague colours the product designs for. Desk's `AGENT_ACCENT_PALETTE`
 * (agent-visual.ts) must list exactly these values; a fourth colour outside this set is
 * rejected on write so a stray hex cannot reach a client as a "theme".
 */
export const AGENT_ACCENT_PALETTE = Object.freeze([
  "#ff695f", "#4f9c8f", "#d99a32", "#6e88c8", "#a67bc2", "#d1667b", "#438db3", "#7f9a45",
] as const);
export type AgentAccent = (typeof AGENT_ACCENT_PALETTE)[number];

/** Avatar silhouettes. `portrait` means the illustrated/uploaded image; the rest are geometric crops. */
export const AGENT_AVATAR_STYLES = Object.freeze(["circle", "squircle", "hex", "portrait"] as const);
export type AgentAvatarStyle = (typeof AGENT_AVATAR_STYLES)[number];

/**
 * FNV-1a over the same inputs Desk uses (`agentId \0 character`), so a colleague created without
 * an explicit colour lands on the same palette slot in Core and in the client. Kept here, next to
 * the palette, because the assignment must be stable before any client can observe it.
 */
export function stableAgentHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Least-used colour at creation time, deterministic per agent so the result is reproducible. */
export function assignAgentAccent(agentId: string, character: string | undefined, inUse: readonly string[] = []): AgentAccent {
  const counts = new Map<string, number>();
  for (const value of inUse) {
    const normalised = value.trim().toLowerCase();
    counts.set(normalised, (counts.get(normalised) ?? 0) + 1);
  }
  const start = stableAgentHash(`${agentId}\0${character ?? ""}`) % AGENT_ACCENT_PALETTE.length;
  let best = AGENT_ACCENT_PALETTE[start];
  let bestCount = counts.get(best) ?? 0;
  // Prefer a colour nobody has yet; on a tie the hash-derived slot wins, so the choice does not
  // depend on creation order beyond the actual usage counts.
  for (let step = 1; step < AGENT_ACCENT_PALETTE.length; step++) {
    const candidate = AGENT_ACCENT_PALETTE[(start + step) % AGENT_ACCENT_PALETTE.length];
    const count = counts.get(candidate) ?? 0;
    if (count < bestCount) { best = candidate; bestCount = count; }
  }
  return best;
}

export function isAgentAccent(value: unknown): value is AgentAccent {
  return typeof value === "string" && (AGENT_ACCENT_PALETTE as readonly string[]).includes(value.trim().toLowerCase());
}
export function isAgentAvatarStyle(value: unknown): value is AgentAvatarStyle {
  return typeof value === "string" && (AGENT_AVATAR_STYLES as readonly string[]).includes(value.trim().toLowerCase());
}

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
  const accentValue = compactText(field(metadata, "accent", "accent-color"), 7)?.toLowerCase();
  const avatarStyleValue = compactText(field(metadata, "avatarStyle", "avatar-style"), 16)?.toLowerCase();
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
    // Imported role files keep their historical six-digit hex so existing catalogs stay readable;
    // the designed palette is enforced where a client *writes* a profile (strict mode below).
    ...(accentValue && SAFE_ACCENT.test(accentValue) ? { accent: accentValue } : {}),
    ...(avatarStyleValue && isAgentAvatarStyle(avatarStyleValue) ? { avatarStyle: avatarStyleValue } : {}),
    ...(characterValue && SAFE_CHARACTER.test(characterValue) ? { character: characterValue } : {}),
    source: identitySource(field(metadata, "identity-source", "identitySource"), roleSource),
  };
}

/** Validate a user-authored public profile before it is persisted. Normalization keeps display data
 * bounded, while unsafe avatar sources and malformed CSS/sprite tokens fail explicitly instead of being
 * silently stored and later interpreted by a client. */
export interface IdentityNormalizeMode {
  /**
   * `strict` is used when a client writes a profile: only the eight designed colours and the
   * four avatar styles are accepted, and anything else is an explicit error.
   *
   * `compat` (the default) is used when reading already-persisted state. Older colleagues may
   * carry an arbitrary six-digit accent or none at all; those reads must keep working, so an
   * out-of-palette accent is preserved verbatim instead of making the catalog invalid.
   */
  presentation?: "strict" | "compat";
}

export function normalizeAgentPublicIdentityInput(
  value: unknown,
  fallbackId: string,
  roleSource: string,
  mode: IdentityNormalizeMode = {},
): AgentPublicIdentity {
  const strict = mode.presentation === "strict";
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("agent profile must be an object");
  }
  const input = value as Record<string, unknown>;
  if (typeof input.displayName !== "string" || !input.displayName.trim()) {
    throw new Error("agent display name is required");
  }
  for (const key of ["title", "bio", "emoji", "avatar", "theme", "accent", "avatarStyle", "character"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "string") {
      throw new Error(`agent profile ${key} must be a string`);
    }
  }
  if (input.traits !== undefined && (!Array.isArray(input.traits) || input.traits.some((trait) => typeof trait !== "string"))) {
    throw new Error("agent profile traits must be a string array");
  }
  // Reject a non-palette colour up front in strict mode: `agentIdentityFromMetadata` accepts any
  // six-digit hex for imported role files, so checking after it would let `#123456` through as if
  // it were a designed colour.
  if (strict && typeof input.accent === "string" && input.accent.trim() && !isAgentAccent(input.accent.trim())) {
    throw new Error(`agent accent must be one of ${AGENT_ACCENT_PALETTE.join(", ")}`);
  }
  if (strict && typeof input.avatarStyle === "string" && input.avatarStyle.trim() && !isAgentAvatarStyle(input.avatarStyle.trim())) {
    throw new Error(`agent avatarStyle must be one of ${AGENT_AVATAR_STYLES.join(", ")}`);
  }
  const identity = agentIdentityFromMetadata(input, fallbackId, "", roleSource);
  if (typeof input.avatar === "string" && input.avatar.trim() && !identity.avatar) {
    throw new Error("agent avatar must be a packaged /avatars or /pets path, or a bounded PNG/JPEG/WebP/GIF data image");
  }
  if (strict && typeof input.accent === "string" && input.accent.trim() && !identity.accent) {
    // A client must send one of the eight designed colours; a stray hex is an error rather than
    // a silently recoloured colleague or a half-applied profile.
    throw new Error(`agent accent must be one of ${AGENT_ACCENT_PALETTE.join(", ")}`);
  }
  if (strict && typeof input.avatarStyle === "string" && input.avatarStyle.trim() && !identity.avatarStyle) {
    throw new Error(`agent avatarStyle must be one of ${AGENT_AVATAR_STYLES.join(", ")}`);
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
