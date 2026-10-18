import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { VersionedSettings } from "./versioned-settings.js";
import { plain } from "./local-state.js";

export type ThemePreference = "system" | "light" | "dark";
const theme = (value: unknown): value is ThemePreference => value === "system" || value === "light" || value === "dark";
export const LEGACY_BUNDLE_IDS = ["com.nanhara.hara", "com.nanhara.hara.dev", "com.nanhara.hara.workspace-candidate", "com.nanhara.hara.workspace-lab"];
/** Read exactly the public appearance preference, never enumerate other localStorage values. */
export function readLegacyTheme(home: string): ThemePreference {
  let seen = 0; const deadline = Date.now() + 2500;
  for (const id of LEGACY_BUNDLE_IDS) for (const base of [join(home, "Library/WebKit", id), join(home, "Library/Application Support", id)]) {
    const walk = (dir: string, depth: number): ThemePreference | undefined => {
      if (depth > 8 || seen > 300 || Date.now() >= deadline) return;
      let entries; try { if (lstatSync(dir).isSymbolicLink()) return; entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (Date.now() >= deadline) return;
        if (entry.isSymbolicLink()) continue; const path = join(dir, entry.name);
        if (entry.isDirectory()) { const value = walk(path, depth + 1); if (value) return value; }
        else if (entry.name.endsWith(".localstorage") || entry.name === "localstorage.sqlite3") {
          if (++seen > 300) return;
          const result = spawnSync("/usr/bin/sqlite3", ["-readonly", path, "SELECT hex(value) FROM ItemTable WHERE key='hara.theme' LIMIT 1;"], { encoding: "utf8", timeout: Math.max(1, Math.min(500, deadline - Date.now())), maxBuffer: 1024, env: { PATH: "/usr/bin:/bin" } });
          if (result.status === 0 && /^[a-f0-9]+\s*$/i.test(result.stdout)) { const bytes = Buffer.from(result.stdout.trim(), "hex");
            for (const value of [bytes.toString("utf8"), bytes.toString("utf16le")]) if (theme(value)) return value; }
        }
      }
    };
    const found = walk(base, 0); if (found) return found;
  }
  return "system";
}
interface Preferences { schemaVersion: 2; revision: number; theme: ThemePreference; migratedFrom: string }
export class WorkspacePreferences {
  private readonly state: VersionedSettings<Preferences>;
  constructor(home: string, legacyHome?: string, legacyTheme: () => ThemePreference = () => legacyHome ? readLegacyTheme(legacyHome) : "system") {
    let cachedTheme: ThemePreference | undefined;
    this.state = new VersionedSettings(() => home, "ui-preferences-v1.json", 2,
      () => ({ schemaVersion: 2, revision: 0, theme: cachedTheme ??= legacyTheme(), migratedFrom: legacyHome ? "legacy-preference-or-system" : "system" }),
      raw => {
        if (!plain(raw) || raw.schemaVersion !== 2 || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0 || !theme(raw.theme)) throw new Error("Invalid appearance settings");
        return { schemaVersion: 2, revision: Number(raw.revision), theme: raw.theme, migratedFrom: typeof raw.migratedFrom === "string" ? raw.migratedFrom : "v1" };
      }, { 1: raw => ({ ...raw, schemaVersion: 2, migratedFrom: "v1" }) });
  }
  read() { const { value, readOnly, recovered } = this.state.read(); return { ...value, readOnly, recovered }; }
  save(value: unknown, expected: number) {
    if (!theme(value)) throw new Error("Invalid appearance choice");
    return this.state.update(expected, old => ({ ...old, theme: value }));
  }
}
