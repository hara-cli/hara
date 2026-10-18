import { createHash } from "node:crypto";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { isProviderId, providerDefaultBaseURL, providerDefaultModel } from "../config.js";
import { redactSensitiveText } from "../security/secrets.js";
import { readPrivateStateFileSnapshotSync } from "../security/private-state.js";
import { plain } from "./local-state.js";
import type { CredentialVault } from "./credential-vault.js";
import type { ScopedConnectionInput } from "./scoped-connections.js";

interface Source { id: string; label: string; provider: "openai" | "anthropic"; baseURL: string; defaultModel: string; keySaved: boolean; source: string; isDefault: boolean; read(): string | undefined }
function read(path: string): { value: any; revision: string } | null {
  try { const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || realpathSync.native(path) !== path || info.size > 4 * 1024 * 1024
      || process.platform !== "win32" && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) return null;
    const snapshot = readPrivateStateFileSnapshotSync(path, 4 * 1024 * 1024); if (!snapshot) return null;
    return { value: JSON.parse(snapshot.text), revision: `${snapshot.ino}:${snapshot.text.length}:${info.mtimeMs}` }; } catch { return null; }
}
const clean = (value: unknown, max = 256) => redactSensitiveText(String(value ?? "")).text.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max).trim();
/** Known private Hara locations only; never uses loadConfig()/env, migrates, or changes old source. */
export class LegacyConnectionCatalog {
  private sources: Source[] = [];
  constructor(private readonly home: string, private readonly vault: CredentialVault) {}
  list(excludeSource?: string, includeWorkspaceSources = true) {
    const sources: Source[] = [];
    const add = (row: any, path: string, revision: string, fallbackLabel: string, isDefault = false) => {
      if (path === excludeSource || !plain(row) || row.kind === "gateway" || row.provider === "qwen-oauth") return;
      const rawURL = typeof row.baseURL === "string" ? row.baseURL : isProviderId(row.provider) ? providerDefaultBaseURL(row.provider) : undefined;
      const rawModel = row.model ?? row.defaultModel ?? (isProviderId(row.provider) ? providerDefaultModel(row.provider) : undefined);
      if (!rawURL || typeof rawModel !== "string" || !(typeof row.apiKey === "string" && row.apiKey.length > 0) && !(typeof row.keyRef === "string" && row.keyRef.length > 0)) return;
      let url: URL; try { url = new URL(rawURL); } catch { return; }
      if (url.username || url.password || url.hash || url.search || !["https:", "http:"].includes(url.protocol) || url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return;
      const label = clean(row.label ?? row.name, 80) || clean(row.provider, 80) || clean(fallbackLabel, 80) || "旧版连接", provider = row.provider === "anthropic" || url.pathname.includes("anthropic") ? "anthropic" as const : "openai" as const;
      const defaultModel = clean(rawModel); if (!defaultModel || rawURL.length > 4096) return;
      const id = createHash("sha256").update(`${path}\0${row.id ?? fallbackLabel}\0${revision}`).digest("hex");
      sources.push({ id, label, provider, baseURL: url.href.replace(/\/$/, ""), defaultModel, keySaved: true, source: path, isDefault,
        read: () => typeof row.apiKey === "string" ? row.apiKey : this.vault.get(String(row.keyRef)) });
    };
    const profilesPath = join(this.home, ".hara/profiles.json"), profiles = read(profilesPath);
    if (profiles && Array.isArray(profiles.value.profiles)) for (const row of profiles.value.profiles.slice(0, 256)) add(row, profilesPath, profiles.revision, String(row.id ?? "舊連接"), row.id === (profiles.value.active ?? profiles.value.activeProfileId ?? profiles.value.activeId ?? profiles.value.defaultProfileId));
    const configPath = join(this.home, ".hara/config.json"), config = read(configPath);
    if (config && !sources.length) add(config.value, configPath, config.revision, "舊個人連接", true);
    const scoped = join(this.home, ".hara/workspaces-v1/home/.hara/workspace-data/v1");
    let entries: string[] = []; try { if (includeWorkspaceSources) entries = readdirSync(scoped).filter(name => /^[a-f0-9]{64}$/.test(name)).slice(0, 128); } catch { /* none */ }
    for (const scope of entries) {
      const path = join(scoped, scope, "state/.hara/workspace-connections-v2.json"), file = read(path);
      if (!file || !Array.isArray(file.value.connections)) continue;
      for (const row of file.value.connections.slice(0, 256)) if (row.status === "active") add(row, path, file.revision, row.label ?? row.id);
    }
    this.sources = sources;
    return sources.map(({ read: _read, ...safe }) => safe);
  }
  personalSeeds(excludeSource?: string) {
    return this.list(excludeSource, false);
  }
  resolve(id: string, excludeSource?: string, personalOnly = false): { input: ScopedConnectionInput; importId: string } {
    // Refresh source revision immediately before a confirmed import; a changed preview is rejected.
    this.list(excludeSource, !personalOnly); const row = this.sources.find(row => row.id === id);
    if (!row) throw new Error("Old connection changed or is unavailable; refresh the preview");
    const apiKey = row.read(); if (!apiKey) throw new Error("Old credential unavailable; original preserved");
    return { input: { label: row.label, provider: row.provider, baseURL: row.baseURL, defaultModel: row.defaultModel, apiKey }, importId: id };
  }
}
