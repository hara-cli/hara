import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { isProviderId, providerDefaultBaseURL, providerDefaultModel } from "../config.js";
import { redactSensitiveText } from "../security/secrets.js";
import { readLegacyBackupBytes } from "./legacy-backup.js";
import { decodeUtf8Strict } from "../fs-read.js";
import { plain } from "./local-state.js";
import type { CredentialVault } from "./credential-vault.js";
import type { ScopedConnectionInput } from "./scoped-connections.js";

interface Source { id: string; label: string; provider: "openai" | "anthropic"; baseURL: string; defaultModel: string; keySaved: boolean; source: string; isDefault: boolean;
  legacyId: string; purpose: "chat" | "decision"; read(): string | undefined }
function read(path: string): { value: any; revision: string } | null {
  try { const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || realpathSync.native(path) !== path || info.size > 4 * 1024 * 1024
      || process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) return null;
    const bytes = readLegacyBackupBytes(path, 4 * 1024 * 1024), text = decodeUtf8Strict(bytes, path);
    // Stats timestamps are represented with different precision by Node and Bun. Source identity
    // must survive a CLI/sidecar handoff, while still rejecting any changed credential or metadata.
    return { value: JSON.parse(text), revision: createHash("sha256").update(bytes).digest("hex") }; } catch { return null; }
}
const clean = (value: unknown, max = 256) => redactSensitiveText(String(value ?? "")).text.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max).trim();
const baseFor = (provider: unknown) => isProviderId(provider) ? providerDefaultBaseURL(provider)
  ?? (provider === "anthropic" ? "https://api.anthropic.com" : provider === "openai" ? "https://api.openai.com/v1" : undefined) : undefined;
/** Known private Hara locations only; never uses loadConfig()/env, migrates, or changes old source. */
export class LegacyConnectionCatalog {
  private sources: Source[] = [];
  constructor(private readonly home: string, private readonly vault: CredentialVault, private readonly identityHome = home) {
    if (!isAbsolute(home) || !isAbsolute(identityHome)) throw new Error("Legacy source requires explicit absolute owner roots");
  }
  list(excludeSource?: string, includeWorkspaceSources = true, includeDecision = false) {
    const sources: Source[] = [];
    const add = (row: any, path: string, revision: string, fallbackLabel: string, isDefault = false, purpose: "chat" | "decision" = "chat") => {
      if (path === excludeSource || !plain(row) || row.kind === "gateway" || row.provider === "qwen-oauth") return;
      const providerId = row.provider ?? "anthropic";
      const rawURL = typeof row.baseURL === "string" && row.baseURL.trim() ? row.baseURL : baseFor(providerId);
      const rawModel = row.model ?? row.defaultModel ?? (isProviderId(providerId) ? providerDefaultModel(providerId) : undefined);
      if (!rawURL || typeof rawModel !== "string") return;
      const keySaved = typeof row.apiKey === "string" && row.apiKey.length > 0 || typeof row.keyRef === "string" && row.keyRef.length > 0;
      let url: URL; try { url = new URL(rawURL); } catch { return; }
      if (url.username || url.password || url.hash || url.search || !["https:", "http:"].includes(url.protocol) || url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return;
      const label = clean(row.label ?? row.name, 80) || clean(providerId, 80) || clean(fallbackLabel, 80) || "旧版连接", provider = providerId === "anthropic" || url.pathname.includes("anthropic") ? "anthropic" as const : "openai" as const;
      const defaultModel = clean(rawModel); if (!defaultModel || rawURL.length > 4096) return;
      const rel = relative(this.home, path); if (rel.startsWith("..") || isAbsolute(rel)) return;
      const identityPath = join(this.identityHome, rel);
      const id = createHash("sha256").update(`${identityPath}\0${row.id ?? fallbackLabel}\0${revision}`).digest("hex");
      sources.push({ id, label, provider, baseURL: url.href.replace(/\/$/, ""), defaultModel, keySaved, source: path, isDefault,
        legacyId: clean(row.id ?? fallbackLabel), purpose,
        read: () => typeof row.apiKey === "string" ? row.apiKey : this.vault.get(String(row.keyRef)) });
    };
    const configPath = join(this.home, ".hara/config.json"), config = read(configPath);
    const profilesPath = join(this.home, ".hara/profiles.json"), profiles = read(profilesPath);
    const active = profiles?.value.active ?? profiles?.value.activeProfileId ?? profiles?.value.activeId ?? profiles?.value.defaultProfileId;
    let personal = false;
    if (profiles && Array.isArray(profiles.value.profiles)) for (const row of profiles.value.profiles.slice(0, 256)) {
      if (!plain(row)) continue;
      if (row.id === "personal" && row.kind !== "gateway" && config) {
        // The reserved Personal row is presentation metadata. Its actual provider/key/model live
        // in config.json; a named profile existing alongside it must not hide the Personal route.
        add({ ...config.value, id: "personal", label: row.label || config.value.label }, configPath, `${config.revision}:${profiles.revision}`, "Personal", active === "personal");
        personal = true;
      } else add(row, profilesPath, profiles.revision, String(row.id ?? "舊連接"), row.id === active);
    }
    if (config && !personal) {
      const same = (Array.isArray(profiles?.value.profiles) ? profiles.value.profiles : []).some((row: any) => plain(row) && row.kind !== "gateway"
        && typeof row.apiKey === "string" && row.apiKey.length > 0 && row.apiKey === config.value.apiKey && row.provider === config.value.provider
        && String(row.baseURL ?? "").replace(/\/$/, "") === String(config.value.baseURL ?? "").replace(/\/$/, "")
        && (row.model ?? row.defaultModel) === (config.value.model ?? config.value.defaultModel));
      if (!same) add({ ...config.value, id: "personal" }, configPath, config.revision, "舊個人連接", !active || active === "personal");
    }
    // Old config-level presets were named `profiles`, then `overlays`. Read them without invoking
    // loadConfig (which could migrate data, read env keys, or write the legacy identity registry).
    const overlays = config?.value.overlays ?? config?.value.profiles;
    if (plain(overlays)) for (const [id, row] of Object.entries(overlays).slice(0, 256)) {
      if (plain(row)) {
        const changed = row.provider && row.provider !== config!.value.provider;
        add({ ...config!.value, ...row, ...(changed ? { apiKey: row.apiKey, keyRef: row.keyRef,
          baseURL: row.baseURL ?? baseFor(row.provider),
          model: row.model ?? row.defaultModel ?? (isProviderId(row.provider) ? providerDefaultModel(row.provider) : undefined) } : {}),
          id: `overlay:${id}`, label: row.label ?? id }, configPath, config!.revision, id);
      }
    }
    if (includeDecision && config && typeof config.value.decisionBaseURL === "string" && typeof config.value.decisionModel === "string") {
      add({ id: "__decision__", label: "旧版决策模型", provider: config.value.decisionBaseURL.includes("anthropic") ? "anthropic" : "openai",
        baseURL: config.value.decisionBaseURL, model: config.value.decisionModel, apiKey: config.value.decisionApiKey }, configPath, config.revision, "__decision__", false, "decision");
    }
    const scoped = join(this.home, ".hara/workspaces-v1/home/.hara/workspace-data/v1");
    let entries: string[] = []; try { if (includeWorkspaceSources) entries = readdirSync(scoped).filter(name => /^[a-f0-9]{64}$/.test(name)).slice(0, 128); } catch { /* none */ }
    for (const scope of entries) {
      const path = join(scoped, scope, "state/.hara/workspace-connections-v2.json"), file = read(path);
      if (!file || !Array.isArray(file.value.connections)) continue;
      for (const row of file.value.connections.slice(0, 256)) if (row.status === "active") add(row, path, file.revision, row.label ?? row.id);
    }
    this.sources = sources;
    return sources.map(({ read: _read, legacyId: _legacy, purpose: _purpose, ...safe }) => safe);
  }
  personalSeeds(excludeSource?: string) {
    return this.list(excludeSource, false);
  }
  /** Owner inheritance only, after backup/dry-run. Does not broaden settings previews or workspace
   * discovery; explicit purpose mapping keeps the decision credential out of the active chat route. */
  inheritanceSeeds(excludeSource?: string) { this.list(excludeSource, false, true); return this.sources.map(({ read: _read, ...row }) => row); }
  resolve(id: string, excludeSource?: string, personalOnly = false, includeDecision = false): { input: ScopedConnectionInput; importId: string } {
    // Refresh source revision immediately before a confirmed import; a changed preview is rejected.
    this.list(excludeSource, !personalOnly, includeDecision); const row = this.sources.find(row => row.id === id);
    if (!row) throw new Error("Old connection changed or is unavailable; refresh the preview");
    const apiKey = row.read(); if (!apiKey) throw new Error("Old credential unavailable; original preserved");
    return { input: { label: row.label, provider: row.provider, baseURL: row.baseURL, defaultModel: row.defaultModel, apiKey }, importId: id };
  }
}
