// Startup update check (npm's update-notifier pattern): NEVER blocks or delays startup. The notice
// shown at launch comes from a CACHE written by a previous session's background probe; if the cache
// is stale (> a day) a fresh probe fires in the background with a hard timeout — its result shows on
// the NEXT launch. Offline / blocked registries fail silently. Interactive TTY sessions only (the
// caller gates); disable with `hara config set updateCheck false` or HARA_UPDATE_CHECK=0.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const cacheFile = (): string => join(homedir(), ".hara", "update-check.json");
/** Probe at most once a day — the check is a courtesy, not a heartbeat. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
/** npmjs first; the npmmirror fallback keeps the check working on CN networks where npmjs stalls. */
const REGISTRIES = ["https://registry.npmjs.org/@nanhara/hara/latest", "https://registry.npmmirror.com/@nanhara/hara/latest"];

/** Strict-ish semver compare on the numeric triple: is `latest` newer than `current`?
 *  Anything unparsable (tags, garbage, empty) → false — never nag on bad data. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string): number[] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(latest);
  const b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

export interface UpdateCache {
  checkedAt: number;
  latest: string;
}

export function readCache(file = cacheFile()): UpdateCache | null {
  try {
    const j = JSON.parse(readFileSync(file, "utf8")) as UpdateCache;
    return typeof j?.checkedAt === "number" && typeof j?.latest === "string" ? j : null;
  } catch {
    return null;
  }
}

export function writeCache(c: UpdateCache, file = cacheFile()): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(c));
  } catch {
    /* a failed cache write must never surface */
  }
}

/** The startup notice, decided purely from cache state (testable without I/O). */
export function updateNotice(current: string, cache: UpdateCache | null): string | null {
  if (!cache || !isNewer(cache.latest, current)) return null;
  return `Update available ${current} → ${cache.latest} · npm i -g @nanhara/hara`;
}

/** Background probe: first registry that answers wins; 3s hard timeout each; silent on total failure
 *  (checkedAt still stamps so an offline machine backs off to daily retries, not every launch). */
export async function refreshLatest(file = cacheFile(), fetchFn: typeof fetch = fetch): Promise<void> {
  for (const url of REGISTRIES) {
    try {
      const r = await fetchFn(url, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) continue;
      const j = (await r.json()) as { version?: string };
      if (j?.version) {
        writeCache({ checkedAt: Date.now(), latest: j.version }, file);
        return;
      }
    } catch {
      /* offline / blocked / slow → try the next registry, then give up quietly */
    }
  }
  const prev = readCache(file);
  writeCache({ checkedAt: Date.now(), latest: prev?.latest ?? "" }, file);
}

/** Startup entry: return the notice to print (or null), and — when the cache is stale — fire the
 *  daily background probe (fire-and-forget; the caller never awaits it). */
export function checkForUpdate(current: string, file = cacheFile(), now = Date.now()): string | null {
  const cache = readCache(file);
  if (!cache || now - cache.checkedAt > CHECK_EVERY_MS) void refreshLatest(file).catch(() => {});
  return updateNotice(current, cache);
}
