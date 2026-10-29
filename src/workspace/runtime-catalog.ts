import type { RuntimeArtifact, OptionalRuntimeId, RuntimeTarget } from "./runtime-install.js";

export const OPTIONAL_RUNTIMES = ["opencode", "codex", "claude", "agy"] as const;
export const RUNTIME_LABELS = { opencode: "OpenCode", codex: "Codex", claude: "Claude Code", agy: "Antigravity" } as const;
const CLAUDE_DIST = "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819";
export const RUNTIME_DOWNLOAD_HOSTS = ["api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "storage.googleapis.com"] as const;
const version = (value: unknown): value is string => typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);

/** Only public vendor metadata is read before the user sees the pinned version/hash approval card.
 * No vendor installer, package script, global tool config, model endpoint or credential is consulted. */
export async function resolveOfficialRuntimeArtifact(id: OptionalRuntimeId, target: RuntimeTarget,
  read: (url: string, maxBytes: number, signal?: AbortSignal) => Promise<Buffer>, signal?: AbortSignal): Promise<RuntimeArtifact> {
  if (id === "agy") throw new Error("Antigravity is available only through local detection and registration; no official download is configured");
  if (!["darwin", "linux", "win32"].includes(target.platform) || !["arm64", "x64"].includes(target.arch)) throw new Error("Unsupported runtime platform");
  if (target.platform === "win32" && target.arch !== "x64") throw new Error("Windows ARM64 runtime acquisition is not supported");
  const parse = async (url: string) => JSON.parse((await read(url, 2 * 1024 * 1024, signal)).toString("utf8"));
  if (id === "claude") {
    const selectedVersion = (await read(`${CLAUDE_DIST}/stable`, 100, signal)).toString("utf8").trim();
    if (!version(selectedVersion)) throw new Error("Vendor runtime version is invalid");
    const manifest = await parse(`${CLAUDE_DIST}/${selectedVersion}/manifest.json`);
    const platform = `${target.platform === "win32" ? "win32" : target.platform}-${target.arch}`;
    const entry = manifest.platforms?.[platform];
    if (!entry || typeof entry.checksum !== "string" || !/^[a-f0-9]{64}$/.test(entry.checksum)) throw new Error("Vendor runtime checksum is unavailable");
    return { runtimeId: id, version: selectedVersion, target, url: `${CLAUDE_DIST}/${selectedVersion}/${platform}/claude${target.platform === "win32" ? ".exe" : ""}`,
      sha256: entry.checksum, format: "raw", member: null, maxBytes: 256 * 1024 * 1024 };
  }
  const repo = id === "codex" ? "openai/codex" : "anomalyco/opencode";
  const release = await parse(`https://api.github.com/repos/${repo}/releases/latest`);
  const selectedVersion = typeof release.tag_name === "string" ? release.tag_name.replace(id === "codex" ? /^rust-v/ : /^v/, "") : "";
  if (!version(selectedVersion) || release.draft || release.prerelease || !Array.isArray(release.assets)) throw new Error("Vendor runtime release is not stable");
  const triple = target.platform === "darwin" ? `${target.arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin`
    : target.platform === "linux" ? `${target.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl` : "x86_64-pc-windows-msvc";
  const os = target.platform === "win32" ? "windows" : target.platform;
  const name = id === "codex" ? `codex-${triple}.${target.platform === "win32" ? "zip" : "tar.gz"}`
    : `opencode-${os}-${target.arch}${target.arch === "x64" ? "-baseline" : ""}.${target.platform === "linux" ? "tar.gz" : "zip"}`;
  const matches = release.assets.filter((row: { name?: unknown } | null) => row?.name === name);
  const entry = matches.length === 1 ? matches[0] : undefined;
  if (!entry || typeof entry.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(entry.digest)
    || !Number.isSafeInteger(entry.size) || entry.size < 64 || entry.size > 256 * 1024 * 1024
    || entry.browser_download_url !== `https://github.com/${repo}/releases/download/${release.tag_name}/${name}`) throw new Error("Vendor runtime asset digest/identity is unavailable");
  return { runtimeId: id, version: selectedVersion, target, url: entry.browser_download_url, sha256: entry.digest.slice(7),
    format: name.endsWith("zip") ? "zip" : "tar.gz", member: id === "codex" ? `codex-${triple}${target.platform === "win32" ? ".exe" : ""}` : `opencode${target.platform === "win32" ? ".exe" : ""}`,
    maxBytes: entry.size };
}
