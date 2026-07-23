// ────────────────────────────────────────────────────────────────────────────────
// Profile = identity layer for hara (Personal ↔ Org A ↔ Org B). Switching a profile
// connects through to *every* downstream decision: provider (BYOK direct vs gateway),
// API key / device token, base URL, **default model** the gateway / setup chose, and
// the user's model override within that profile. Plus presentation: a `kind` badge
// ("ORG" vs "PERSONAL"), a label, a routing display.
//
// Single source of truth at runtime. `~/.hara/profiles.json` (0600) stores the *list*
// of profiles + which one is `active`. The legacy `~/.hara/config.json` keeps acting
// as the storage for the "personal" profile so existing users with only a config.json
// don't have to migrate anything (their config.json IS their personal profile).
//
// Migration (run lazily on first read):
//   • config.json exists, no profiles.json   → personal profile is config.json itself,
//                                              profiles.json is created with active=personal.
//   • org.json exists (legacy enrolled)      → injected as a `default-org` gateway profile,
//                                              active is set to it (the user IS using a gateway
//                                              right now — preserve that), org.json renamed
//                                              `.legacy` so we never re-migrate.
//   • Both exist → both become profiles; active = default-org (the gateway, since that's the
//                                              live routing today).
//
// Idempotent: re-running the migration after it's done is a no-op.
//
// Provider resolution (in src/index.ts buildProvider):
//   profile.kind === 'gateway' → OpenAI-compatible w/ deviceToken + (baseURL || gatewayUrl+'/v1')
//   profile.kind === 'byok'    → existing anthropic / qwen / openai / qwen-oauth dispatch
//
// The `hara-gateway` ProviderId enum value is retired from new writes — buildProvider still
// tolerates reading it from a legacy config.json (it just maps to the migrated gateway profile).
// ────────────────────────────────────────────────────────────────────────────────
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, dirname, parse as parsePath, relative, resolve as resolvePath } from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { readRawConfig, updateRawConfig, type ProviderId } from "../config.js";
import { readVerifiedRegularFileSnapshotSync, type RegularFileSnapshot } from "../fs-read.js";
import {
  atomicWriteText,
  bindProfilePinWritePath,
  discardClaimedPath,
  verifyAtomicWriteBoundary,
} from "../fs-write.js";
import { projectRepositoryTrustedAtStartup } from "../security/project-trust.js";
import {
  bindPrivateHaraStateFile,
  readPrivateStateFileSnapshotSync,
  removePrivateStateFile,
  writePrivateStateFileSync,
  type PrivateStateFileBinding,
  type PrivateStateFileSnapshot,
} from "../security/private-state.js";

export type ProfileKind = "byok" | "gateway";

export interface Profile {
  id: string;
  kind: ProfileKind;
  label?: string;
  // byok-only
  provider?: ProviderId; // anthropic | qwen | openai | qwen-oauth (NOT hara-gateway)
  apiKey?: string;
  baseURL?: string;
  // gateway-only (mirrors Enrollment)
  gatewayUrl?: string;
  deviceId?: string;
  deviceToken?: string;
  // shared
  /** what the gateway told us to use (gateway) or the user picked at setup time (byok). */
  defaultModel?: string;
  /** the user's per-profile override of `defaultModel`. Cleared by `model reset`. */
  model?: string;
  /** P0: gateway populates with [defaultModel] (or empty if the gateway didn't say);
   *  byok stays empty (no list constraint). P1 may pull this from /v1/models. */
  availableModels?: string[];
  /** Server-advertised thinking dial for the scoped gateway model. */
  thinkingEfforts?: string[];
  enrolledAt?: string;
  /** Control/data-plane shared expiry for the gateway device token. */
  tokenExpiresAt?: string;
}

export interface ProfilesFile {
  active: string;
  profiles: Profile[];
}

const PERSONAL_ID = "personal";
const DEFAULT_ORG_ID = "default-org";
const MAX_PROFILE_STATE_BYTES = 4 * 1024 * 1024;

interface PrivateJsonState<T> {
  binding: PrivateStateFileBinding;
  snapshot: PrivateStateFileSnapshot;
  value: T;
}

function readPrivateJSON<T>(filename: string): PrivateJsonState<T> | null {
  try {
    const binding = bindPrivateHaraStateFile(homedir(), [], filename);
    const snapshot = readPrivateStateFileSnapshotSync(binding.path, MAX_PROFILE_STATE_BYTES);
    if (!snapshot) return null;
    return { binding, snapshot, value: JSON.parse(snapshot.text) as T };
  } catch {
    return null;
  }
}

/** Write the profiles file 0600 (it can hold device tokens / api keys). */
function persistProfilesFile(f: ProfilesFile): void {
  const binding = bindPrivateHaraStateFile(homedir(), [], "profiles.json");
  writePrivateStateFileSync(binding, JSON.stringify(f, null, 2) + "\n");
}

/** Synthesize the "personal" profile view from the legacy config.json. The config.json itself
 *  stays the *storage* — this just presents it as a Profile object. */
function readPersonalFromConfig(): Profile {
  const cfg = readRawConfig();
  // A legacy user that ran `hara enroll` had their provider written as "hara-gateway" in config.json.
  // After migration that case is handled separately (default-org profile), so when synthesizing the
  // personal profile we coerce a stray "hara-gateway" provider to anthropic (the BYOK default) — the
  // user can always fix it with `hara setup`.
  const rawProvider: string | undefined = cfg.provider;
  const provider: ProviderId = rawProvider && rawProvider !== "hara-gateway" ? (rawProvider as ProviderId) : "anthropic";
  return {
    id: PERSONAL_ID,
    kind: "byok",
    label: "Personal",
    provider,
    apiKey: cfg.apiKey,
    baseURL: cfg.baseURL,
    defaultModel: cfg.model,
    // No per-profile override yet for the personal slot — `model` (override) and `defaultModel`
    // come from the same field in config.json. `hara model use X` writes `model` to config.json,
    // `hara model reset` clears it. Conceptually one slot, but the rest of the codebase only ever
    // reads "effective model" so this is fine.
  };
}

/** Synthesize a `default-org` profile from the legacy org.json (Enrollment). */
function readDefaultOrgFromOrgJson(e: Record<string, any> | null): Profile | null {
  if (!e || !e.gatewayUrl || !e.deviceToken) return null;
  const defaultModel: string = e.model || "";
  return {
    id: DEFAULT_ORG_ID,
    kind: "gateway",
    label: "Default Org",
    gatewayUrl: e.gatewayUrl,
    deviceId: e.deviceId || "",
    deviceToken: e.deviceToken,
    baseURL: e.baseURL,
    defaultModel,
    availableModels: Array.isArray(e.availableModels)
      ? e.availableModels
      : (defaultModel ? [defaultModel] : []),
    thinkingEfforts: Array.isArray(e.thinkingEfforts) ? e.thinkingEfforts : undefined,
    enrolledAt: e.enrolledAt || new Date().toISOString(),
    tokenExpiresAt: typeof e.expiresAt === "string" ? e.expiresAt : undefined,
  };
}

/** First-time migration. Idempotent — running again is a no-op (profiles.json already present). */
function maybeMigrate(): ProfilesFile {
  const existing = readPrivateJSON<ProfilesFile>("profiles.json")?.value;
  if (existing && Array.isArray(existing.profiles) && existing.profiles.length > 0) return existing;

  const personal = readPersonalFromConfig();
  const legacyOrg = readPrivateJSON<Record<string, any>>("org.json");
  const org = readDefaultOrgFromOrgJson(legacyOrg?.value ?? null);
  const profiles: Profile[] = [personal];
  let active = PERSONAL_ID;
  if (org) {
    profiles.push(org);
    active = DEFAULT_ORG_ID; // legacy enrolled user IS using the gateway right now — preserve
  }
  const f: ProfilesFile = { active, profiles };
  persistProfilesFile(f);

  // Park the exact verified legacy bytes without ever following/replacing an alias. If archival races or
  // fails, leave org.json untouched; profiles.json already makes the migration idempotent.
  if (org && legacyOrg) {
    try {
      const archive = bindPrivateHaraStateFile(homedir(), [], "org.json.legacy");
      writePrivateStateFileSync(archive, legacyOrg.snapshot.text);
      removePrivateStateFile(legacyOrg.binding.path, legacyOrg.snapshot, legacyOrg.binding.directory);
    } catch {
      /* best-effort */
    }
  }
  return f;
}

export function listProfiles(): Profile[] {
  return maybeMigrate().profiles;
}

// ────────────────────────────────────────────────────────────────────────────────
// `.hara-profile` project pin — like .nvmrc, but personal identity rather than
// runtime version, so we keep it out of repos by default (the printed hint nudges
// the user to add it to their *global* gitignore — see `profile pin`). Lookup is
// "walk up from startDir until we hit a `.hara-profile`, fs root, or home". The
// walk stops at $HOME to prevent a stray ~/.hara-profile from silently overriding
// the global default (~/.hara/profiles.json `active`).
// ────────────────────────────────────────────────────────────────────────────────
const PIN_FILE = ".hara-profile";
const MAX_PIN_BYTES = 4096;
const warnedPinFiles = new Set<string>();

function canonicalExistingDirectory(path: string): string {
  try { return realpathSync.native(resolvePath(path)); } catch { return resolvePath(path); }
}

function warnIgnoredPin(file: string, reason: "unsafe" | "invalid" | "unavailable" | "tracked" | "unverified"): void {
  const key = `${file}:${reason}`;
  if (warnedPinFiles.has(key)) return;
  warnedPinFiles.add(key);
  const detail = {
    unavailable: "names a profile that is not available",
    tracked: "is tracked by Git and repository identity pins are untrusted by default",
    unverified: "is inside a Git worktree but its tracked status could not be verified",
    invalid: "has an invalid format",
    unsafe: "failed filesystem identity checks",
  }[reason];
  const trustHint = reason === "tracked" || reason === "unverified"
    ? " Set HARA_TRUST_PROJECT_CONFIG=1 before starting hara only for a repository you trust."
    : "";
  try {
    // The directory path is repository input and may itself contain token-shaped text. The fixed basename
    // is enough to identify the feature without reflecting any attacker-controlled path or file content.
    process.stderr.write(`hara: ignored .hara-profile: it ${detail}.${trustHint} Run \`hara profile pin <id>\` or \`hara profile unpin\` to fix.\n`);
  } catch {
    /* best effort */
  }
}

type PinTracking = "tracked" | "untracked" | "unknown" | "outside-git";

function gitMarkerAbove(start: string): boolean {
  let dir = start;
  for (let depth = 0; depth < 128; depth++) {
    try {
      lstatSync(join(dir, ".git"));
      return true;
    } catch (error: any) {
      if (error?.code !== "ENOENT") return true; // unreadable/suspicious marker: require a successful Git check
    }
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
  return true; // fail closed on a pathological path depth
}

/** Check only the index, with no shell and no repository-controlled command string. Unknown/error is distinct
 * from untracked so a missing/failed git binary can never silently bless a committed identity pin. */
function pinTracking(file: string): PinTracking {
  const dir = dirname(file);
  if (!gitMarkerAbove(dir)) return "outside-git";
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  const result = spawnSync("git", [
    "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false",
    "-C", dir,
    "ls-files", "--error-unmatch", "--", PIN_FILE,
  ], {
    env,
    stdio: "ignore",
    timeout: 2000,
    windowsHide: true,
  });
  if (result.error || result.signal) return "unknown";
  if (result.status === 0) return "tracked";
  if (result.status === 1) return "untracked";
  return "unknown";
}

export function pinFilePath(dir: string): string {
  return join(dir, PIN_FILE);
}

/** Walk up from `startDir` looking for `.hara-profile`; return the first hit whose
 *  contents name a real profile. Returns `{ id, file }` (absolute file path) or null.
 *  If a pin file exists but names an unknown profile, we emit a one-line stderr warn
 *  and return null (non-fatal — the active resolution falls through to the next layer). */
export function findPinnedProfile(startDir: string): { id: string; file: string } | null {
  const home = canonicalExistingDirectory(homedir());
  let dir = canonicalExistingDirectory(startDir);
  const { root } = parsePath(dir);
  // Track visited to defend against pathological symlink loops (best-effort).
  const seen = new Set<string>();
  while (!seen.has(dir)) {
    seen.add(dir);
    const file = pinFilePath(dir);
    try {
      const snapshot = readVerifiedRegularFileSnapshotSync(file, MAX_PIN_BYTES, {
        action: "read profile pin",
        protectSensitive: false,
        rejectHardLinks: true,
      });
      if (snapshot.text.includes("\0")) {
        warnIgnoredPin(file, "invalid");
        return null;
      }
      if (!projectRepositoryTrustedAtStartup()) {
        const tracking = pinTracking(file);
        if (tracking === "tracked") {
          warnIgnoredPin(file, "tracked");
          return null;
        }
        if (tracking === "unknown") {
          warnIgnoredPin(file, "unverified");
          return null;
        }
      }
      const id = snapshot.text.split(/\r?\n/)[0].trim();
      if (id && getProfile(id)) return { id, file };
      if (id) warnIgnoredPin(file, "unavailable");
      return null;
    } catch (error: any) {
      if (error?.code !== "ENOENT") {
        warnIgnoredPin(file, error?.code === "HARA_FILE_TOO_LARGE" ? "invalid" : "unsafe");
        return null;
      }
    }
    // Stop walking once we're at $HOME or the fs root (don't escape into shared parent dirs).
    if (dir === home || dir === root) return null;
    const parent = dirname(dir);
    if (!parent || parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Atomically write `.hara-profile` in the given dir with `id` as the only line. */
export async function writePin(dir: string, id: string): Promise<{ file: string }> {
  if (!getProfile(id)) throw new Error(`no profile '${id}' — list with \`hara profile list\``);
  const file = pinFilePath(dir);
  const boundary = bindProfilePinWritePath(file);
  let snapshot: RegularFileSnapshot | null = null;
  try {
    snapshot = readVerifiedRegularFileSnapshotSync(boundary.target, MAX_PIN_BYTES, {
      action: "write profile pin",
      protectSensitive: false,
      rejectHardLinks: true,
    });
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw new Error("refusing to replace an unsafe profile pin");
  }
  await atomicWriteText(boundary.target, id + "\n", {
    expected: snapshot?.text ?? null,
    expectedIdentity: snapshot ?? undefined,
    boundary,
    mode: 0o600,
  });
  return { file: boundary.target };
}

/** Remove `.hara-profile` from the given dir. Returns true if it was there. */
export function removePin(dir: string): boolean {
  const file = pinFilePath(dir);
  let boundary;
  try {
    boundary = bindProfilePinWritePath(file, "remove profile pin");
    const snapshot = readVerifiedRegularFileSnapshotSync(boundary.target, MAX_PIN_BYTES, {
      action: "remove profile pin",
      protectSensitive: false,
      rejectHardLinks: true,
    });
    verifyAtomicWriteBoundary(boundary);
    discardClaimedPath(boundary.target, snapshot);
    return true;
  } catch (error: any) {
    if (error?.code !== "ENOENT") warnIgnoredPin(boundary?.target ?? file, "unsafe");
    return false;
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// Active profile resolution — single chain, transparent provenance.
//
//   1. `--profile <id>` CLI flag    (set via setFlagOverride() from the top-level
//                                    program parse; never written to disk)
//   2. `HARA_PROFILE` env           (also transient; useful in cron / scripts)
//   3. `.hara-profile` project pin  (walked up from cwd)
//   4. profiles.json `active`       (global default — `hara profile use <id>`)
//   5. "personal" fallback          (if even that's gone)
//
// `resolveActive()` returns the chosen id *with* its source so whoami / list can
// show "(active · pinned by ./.hara-profile)" and friends. `activeId()` stays as
// a thin wrapper for callers that just need the string.
// ────────────────────────────────────────────────────────────────────────────────
export type ActiveSource = "flag" | "env" | "pin" | "default" | "fallback";
export interface ActiveResolution {
  id: string;
  source: ActiveSource;
  /** when source === "pin", the absolute pin file path (formatters render relative to cwd). */
  pinFile?: string;
}

let _flagProfile: string | null = null;
/** Set by the top-level `--profile <id>` flag handler. Cleared between processes
 *  (we never persist this — it's a one-shot override). Pass null to clear. */
export function setFlagOverride(id: string | null): void {
  _flagProfile = id && id.trim() ? id.trim() : null;
}
export function getFlagOverride(): string | null {
  return _flagProfile;
}

export function resolveActive(cwd: string = process.cwd()): ActiveResolution {
  // 1. CLI flag (one-shot).
  if (_flagProfile && getProfile(_flagProfile)) return { id: _flagProfile, source: "flag" };
  // 2. env (also one-shot — scripts / cron).
  const env = process.env.HARA_PROFILE;
  if (env && getProfile(env)) return { id: env, source: "env" };
  // 3. project pin — walk up from cwd to home/root.
  const pin = findPinnedProfile(cwd);
  if (pin) return { id: pin.id, source: "pin", pinFile: pin.file };
  // 4. global default.
  const f = maybeMigrate();
  if (f.active && getProfile(f.active)) return { id: f.active, source: "default" };
  // 5. ultimate fallback — personal always exists (migration guarantees it).
  return { id: PERSONAL_ID, source: "fallback" };
}

/** Thin wrapper for the (many) call sites that just need "which profile am I as". */
export function activeId(): string {
  return resolveActive().id;
}

export function getProfile(id: string): Profile | undefined {
  return maybeMigrate().profiles.find((p) => p.id === id);
}

/** The effective, runtime view of the active profile. For id==='personal' we re-read from
 *  config.json on each call so external edits (config set / setup) are picked up live. */
export function loadActiveProfile(): Profile {
  const id = activeId();
  const f = maybeMigrate();
  if (id === PERSONAL_ID) {
    // Always re-sync personal from config.json (the storage of record). Other profile fields in
    // profiles.json for "personal" are presentation only (label).
    const p = readPersonalFromConfig();
    const stored = f.profiles.find((x) => x.id === PERSONAL_ID);
    if (stored?.label) p.label = stored.label;
    return p;
  }
  const p = f.profiles.find((x) => x.id === id);
  if (p) return p;
  // Active points to nothing → degrade to personal silently and persist.
  const personal = readPersonalFromConfig();
  return personal;
}

export function useProfile(id: string): { ok: true; profile: Profile } | { ok: false; reason: string } {
  const f = maybeMigrate();
  const p = f.profiles.find((x) => x.id === id);
  if (!p) return { ok: false, reason: `no profile '${id}' — try \`hara profile list\`` };
  f.active = id;
  persistProfilesFile(f);
  return { ok: true, profile: p };
}

export function addProfile(p: Profile): { ok: true } | { ok: false; reason: string } {
  if (!p.id || /[\s/]/.test(p.id)) return { ok: false, reason: "profile id must be non-empty and contain no whitespace or '/'" };
  const f = maybeMigrate();
  if (f.profiles.some((x) => x.id === p.id)) return { ok: false, reason: `profile '${p.id}' already exists` };
  if (p.kind === "gateway" && (!p.gatewayUrl || !p.deviceToken)) return { ok: false, reason: "gateway profile needs gatewayUrl + deviceToken" };
  if (p.kind === "byok" && !p.provider) return { ok: false, reason: "byok profile needs a provider" };
  f.profiles.push(p);
  persistProfilesFile(f);
  return { ok: true };
}

/** Replace an existing profile (same id) — used by `hara enroll <url> --code` when the
 *  default-org profile already exists (re-enrollment / token rotation). */
export function upsertProfile(p: Profile): void {
  const f = maybeMigrate();
  const i = f.profiles.findIndex((x) => x.id === p.id);
  if (i >= 0) f.profiles[i] = p;
  else f.profiles.push(p);
  persistProfilesFile(f);
}

export function removeProfile(id: string): { ok: true; activeChanged: boolean; removedKind: ProfileKind; removed: Profile } | { ok: false; reason: string } {
  if (id === PERSONAL_ID) return { ok: false, reason: "personal is your base profile — switch away with `hara profile use <other>`; it stays." };
  const f = maybeMigrate();
  const i = f.profiles.findIndex((x) => x.id === id);
  if (i < 0) return { ok: false, reason: `no profile '${id}' — list with \`hara profile list\`` };
  const removed = f.profiles[i];
  f.profiles.splice(i, 1);
  let activeChanged = false;
  if (f.active === id) {
    f.active = PERSONAL_ID;
    activeChanged = true;
  }
  persistProfilesFile(f);
  return { ok: true, activeChanged, removedKind: removed.kind, removed };
}

/** Override the effective model within a profile. For "personal" this writes to config.json
 *  (the storage of record). For others it writes to profiles.json. P0: when availableModels
 *  is non-empty on a gateway profile we validate the choice is in the set. */
export function setModel(id: string, model: string): { ok: true } | { ok: false; reason: string } {
  if (id === PERSONAL_ID) {
    // delegate to config.ts so this stays single-storage for personal
    return setModelOnPersonal(model);
  }
  const f = maybeMigrate();
  const i = f.profiles.findIndex((x) => x.id === id);
  if (i < 0) return { ok: false, reason: `no profile '${id}'` };
  const p = f.profiles[i];
  if (p.kind === "gateway" && p.availableModels && p.availableModels.length > 0 && !p.availableModels.includes(model)) {
    return { ok: false, reason: `'${model}' not in this profile's availableModels (${p.availableModels.join(", ")})` };
  }
  f.profiles[i] = { ...p, model };
  persistProfilesFile(f);
  return { ok: true };
}

/** Clear a per-profile model override (revert to defaultModel). */
export function resetModel(id: string): { ok: true } | { ok: false; reason: string } {
  if (id === PERSONAL_ID) {
    // For personal we don't have a distinct override slot — `model` IS the value. Reset means
    // remove the model line from config.json so the provider default kicks in.
    return clearModelOnPersonal();
  }
  const f = maybeMigrate();
  const i = f.profiles.findIndex((x) => x.id === id);
  if (i < 0) return { ok: false, reason: `no profile '${id}'` };
  const { model: _drop, ...rest } = f.profiles[i];
  f.profiles[i] = rest;
  persistProfilesFile(f);
  return { ok: true };
}

/** The effective model for a profile = override (model) || defaultModel || "" (caller decides default). */
export function effectiveModel(p: Profile): string {
  return process.env.HARA_MODEL || p.model || p.defaultModel || "";
}

/** Routing display string — the user-visible "where this profile sends requests".
 *  Used by `whoami` / `profile list`; the TUI header uses `routeHost` for a tighter,
 *  host-only render. */
export function routingLabel(p: Profile): string {
  if (p.kind === "gateway") {
    try {
      const host = new URL(p.gatewayUrl || "").host;
      return `${host}${p.deviceId ? " · device " + p.deviceId.slice(-8) : ""}`;
    } catch {
      return p.gatewayUrl || "gateway";
    }
  }
  return `${p.provider}${p.baseURL ? " · " + p.baseURL : ""}`;
}

/** Host-only routing for the TUI header. Returns the URL host (no scheme, no path) plus
 *  `isCustom`: true when the profile carries a non-default baseURL (BYOK) or always-true
 *  for gateway profiles. View layer decides whether to show `→ host` (always for org;
 *  only when `isCustom` for personal). Returns `null` if there's nothing to display
 *  (BYOK on the provider's official endpoint). */
export function routeHost(p: Profile): { host: string; isCustom: boolean } | null {
  if (p.kind === "gateway") {
    try {
      return { host: new URL(p.gatewayUrl || "").host, isCustom: true };
    } catch {
      return p.gatewayUrl ? { host: p.gatewayUrl, isCustom: true } : null;
    }
  }
  // BYOK: only surface a host when the user pointed at a non-default endpoint.
  if (!p.baseURL) return null;
  try {
    return { host: new URL(p.baseURL).host, isCustom: true };
  } catch {
    return { host: p.baseURL, isCustom: true };
  }
}

// ────────────────────────────────────────────────────────────────────────────────
// Personal-profile model storage helpers — split out so they can be re-exported via
// config.ts without circular imports. Implemented inline to avoid pulling config.ts.
// ────────────────────────────────────────────────────────────────────────────────
function setModelOnPersonal(model: string): { ok: true } | { ok: false; reason: string } {
  updateRawConfig((config) => {
    config.model = model;
  });
  return { ok: true };
}
function clearModelOnPersonal(): { ok: true } | { ok: false; reason: string } {
  updateRawConfig((config) => {
    delete config.model;
  });
  return { ok: true };
}

export { PERSONAL_ID, DEFAULT_ORG_ID };
