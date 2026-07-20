// Plugins are untrusted distribution units. Installation validates every executable contribution,
// activates a same-filesystem staging directory atomically, and records the exact directory/bin ownership
// used by uninstall. Runtime loaders re-validate installed manifests instead of trusting installation time.
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { readRawConfig, updateRawConfig } from "../config.js";
import type { McpServerConfig } from "../config.js";
import type { HooksConfig } from "../hooks.js";
import {
  bindPrivateHaraStateFile,
  ensurePrivateStateSubdirectory,
  readPrivateStateFileSnapshotSync,
  removePrivateStateFile,
  writePrivateStateFileSync,
  type PrivateStateFileBinding,
  type PrivateStateFileSnapshot,
} from "../security/private-state.js";
import {
  bindPluginMcpServers,
  readVerifiedPluginManifest,
  safePluginId,
  safePluginRelativePath,
  type PanelSpec,
  type PluginManifest,
  type VerifiedPluginManifest,
} from "./manifest.js";

export type { PanelSpec, PluginManifest } from "./manifest.js";

export interface Plugin {
  name: string;
  version: string;
  root: string;
  manifest: PluginManifest;
}

interface PluginReceipt {
  schemaVersion: 1;
  name: string;
  root: string;
  rootDev: string;
  rootIno: string;
  manifestSha256: string;
  bins: Record<string, string>;
}

interface StoredReceipt {
  binding: PrivateStateFileBinding;
  snapshot: PrivateStateFileSnapshot;
  raw: string;
  receipt: PluginReceipt;
}

export function pluginsDir(): string {
  return join(homedir(), ".hara", "plugins");
}

export function haraBinDir(): string {
  return join(homedir(), ".hara", "bin");
}

function pluginStorage(): string {
  return ensurePrivateStateSubdirectory(homedir(), [".hara", "plugins"]).path;
}

function pluginBinStorage(): string {
  return ensurePrivateStateSubdirectory(homedir(), [".hara", "bin"]).path;
}

function pluginRoot(name: string): string {
  const safe = safePluginId(name);
  const root = join(pluginStorage(), safe);
  if (resolve(root) !== join(pluginStorage(), safe)) throw new Error("plugin root escaped the Hara plugin directory");
  return root;
}

function receiptBinding(name: string): PrivateStateFileBinding {
  return bindPrivateHaraStateFile(homedir(), ["plugin-receipts"], `${safePluginId(name)}.json`);
}

function rootIdentity(path: string): { rootDev: string; rootIno: string } {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`plugin root '${path}' is not an owned real directory`);
  return { rootDev: String(info.dev), rootIno: String(info.ino) };
}

function pluginBins(manifest: PluginManifest): Record<string, string> {
  return { ...(manifest.bin ?? {}) };
}

function parseReceipt(raw: string, expectedName: string): PluginReceipt {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`plugin '${expectedName}' ownership receipt is invalid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`plugin '${expectedName}' ownership receipt is invalid`);
  }
  const input = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "name", "root", "rootDev", "rootIno", "manifestSha256", "bins"]);
  if (Object.keys(input).some((key) => !allowed.has(key)) || input.schemaVersion !== 1) {
    throw new Error(`plugin '${expectedName}' ownership receipt has an unsupported schema`);
  }
  const name = safePluginId(input.name, "receipt plugin name");
  if (name !== expectedName) throw new Error(`plugin '${expectedName}' ownership receipt belongs to '${name}'`);
  if (
    typeof input.root !== "string"
    || typeof input.rootDev !== "string"
    || typeof input.rootIno !== "string"
    || typeof input.manifestSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(input.manifestSha256)
    || !input.bins
    || typeof input.bins !== "object"
    || Array.isArray(input.bins)
  ) throw new Error(`plugin '${expectedName}' ownership receipt is incomplete`);
  const bins: Record<string, string> = {};
  for (const [rawName, rawPath] of Object.entries(input.bins as Record<string, unknown>)) {
    const binName = safePluginId(rawName, "receipt command name");
    bins[binName] = safePluginRelativePath(rawPath, `receipt command '${binName}'`);
  }
  return {
    schemaVersion: 1,
    name,
    root: resolve(input.root),
    rootDev: input.rootDev,
    rootIno: input.rootIno,
    manifestSha256: input.manifestSha256,
    bins,
  };
}

function readReceipt(name: string): StoredReceipt | null {
  const binding = receiptBinding(name);
  const snapshot = readPrivateStateFileSnapshotSync(binding.path, 256 * 1024);
  if (!snapshot) return null;
  return { binding, snapshot, raw: snapshot.text, receipt: parseReceipt(snapshot.text, name) };
}

function writeReceipt(name: string, root: string, verified: VerifiedPluginManifest): PluginReceipt {
  const identity = rootIdentity(root);
  const receipt: PluginReceipt = {
    schemaVersion: 1,
    name,
    root: resolve(root),
    ...identity,
    manifestSha256: verified.sha256,
    bins: pluginBins(verified.manifest),
  };
  writePrivateStateFileSync(receiptBinding(name), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

function restoreReceipt(name: string, raw: string | null): void {
  const binding = receiptBinding(name);
  if (raw !== null) {
    writePrivateStateFileSync(binding, raw);
    return;
  }
  const current = readPrivateStateFileSnapshotSync(binding.path, 256 * 1024);
  if (current) removePrivateStateFile(binding.path, current, binding.directory);
}

function verifyReceipt(receipt: PluginReceipt, root: string, verified: VerifiedPluginManifest): void {
  const canonicalRoot = resolve(root);
  const identity = rootIdentity(canonicalRoot);
  if (
    receipt.root !== canonicalRoot
    || receipt.rootDev !== identity.rootDev
    || receipt.rootIno !== identity.rootIno
    || receipt.manifestSha256 !== verified.sha256
  ) throw new Error(`plugin '${receipt.name}' changed after installation; refusing an ownership-sensitive operation`);
}

function resolvedLinkTarget(link: string): string {
  const target = readlinkSync(link);
  return resolve(dirname(link), target);
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function expectedBinTarget(root: string, rel: string): string {
  const target = resolve(root, safePluginRelativePath(rel, "plugin command target"));
  const relToRoot = relative(resolve(root), target);
  if (relToRoot.startsWith("..") || isAbsolute(relToRoot)) throw new Error("plugin command target escaped its package root");
  return target;
}

function preflightBinLink(root: string, name: string, rel: string, allowMissing = true): void {
  const link = join(pluginBinStorage(), safePluginId(name, "plugin command name"));
  if (!entryExists(link)) {
    if (allowMissing) return;
    throw new Error(`plugin command link '${name}' is missing`);
  }
  const info = lstatSync(link);
  if (!info.isSymbolicLink() || resolvedLinkTarget(link) !== expectedBinTarget(root, rel)) {
    throw new Error(`refusing to replace or remove foreign command entry '${link}'`);
  }
}

function unlinkBinLink(root: string, name: string, rel: string): void {
  const link = join(pluginBinStorage(), safePluginId(name, "plugin command name"));
  if (!entryExists(link)) return;
  preflightBinLink(root, name, rel, false);
  rmSync(link);
}

function ensureBinLink(root: string, name: string, rel: string): void {
  const dir = pluginBinStorage();
  const link = join(dir, safePluginId(name, "plugin command name"));
  const target = expectedBinTarget(root, rel);
  const targetInfo = lstatSync(target);
  if (!targetInfo.isFile() || targetInfo.isSymbolicLink() || targetInfo.nlink !== 1) {
    throw new Error(`plugin command '${name}' is not a verified regular file`);
  }
  if (entryExists(link)) {
    preflightBinLink(root, name, rel, false);
    return;
  }
  try {
    chmodSync(target, 0o755);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
  symlinkSync(target, link, "file");
}

function restoreBinLinks(root: string, bins: Record<string, string>): void {
  for (const [name, rel] of Object.entries(bins)) ensureBinLink(root, name, rel);
}

function safeTemporaryRemove(path: string): void {
  if (!existsSync(path)) return;
  const info = lstatSync(path);
  if (info.isSymbolicLink()) {
    rmSync(path);
    return;
  }
  if (!info.isDirectory()) throw new Error(`refusing to recursively remove unexpected plugin staging entry '${path}'`);
  rmSync(path, { recursive: true, force: true });
}

function readInstalled(
  root: string,
  expectedName?: string,
  options: { scanTree?: boolean } = {},
): { plugin: Plugin; verified: VerifiedPluginManifest } {
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`installed plugin root '${root}' is not a real directory`);
  const verified = readVerifiedPluginManifest(root, options);
  const name = safePluginId(verified.manifest.name);
  if (expectedName && name !== expectedName) throw new Error(`installed plugin '${expectedName}' claims the different name '${name}'`);
  return {
    plugin: { name, version: verified.manifest.version || "0.0.0", root: realpathSync.native(root), manifest: verified.manifest },
    verified,
  };
}

/** Every installed plugin under ~/.hara/plugins (regardless of enabled state). Invalid roots never execute.
 * A structurally valid legacy root remains usable so an explicit reinstall can replace it and create a receipt;
 * ownership-sensitive removal still refuses it until that migration happens. */
export function listInstalled(): Plugin[] {
  const dir = pluginStorage();
  const out: Plugin[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry.startsWith("_")) continue;
    try {
      const name = safePluginId(entry, "installed plugin directory");
      // Installation and ownership-sensitive operations scan the complete package. Hot-path discovery only
      // revalidates the manifest and every declared skill/agent/bin/MCP entry; unrelated package files cannot
      // become executable contributions and must not add O(package-size) latency to each prompt/turn.
      const { plugin } = readInstalled(join(dir, name), name, { scanTree: false });
      out.push(plugin);
    } catch {
      // Fail closed: a malformed root contributes no code, paths, hooks, MCP servers, or panels.
    }
  }
  return out;
}

export function enabledPlugins(): Plugin[] {
  const enabled = (readRawConfig().plugins?.enabled ?? {}) as Record<string, boolean>;
  return listInstalled().filter((plugin) => enabled[plugin.name] !== false);
}

function resolveDirs(plugin: Plugin, entries: string[] | undefined): string[] {
  return (entries ?? []).map((entry) => {
    const root = realpathSync.native(resolve(plugin.root));
    const requested = resolve(root, safePluginRelativePath(entry, `plugin '${plugin.name}' contribution`));
    const target = realpathSync.native(requested);
    const rel = relative(root, target);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`plugin '${plugin.name}' contribution escaped its root`);
    return target;
  });
}

export function pluginSkillDirs(): string[] {
  return enabledPlugins().flatMap((plugin) => resolveDirs(plugin, plugin.manifest.skills));
}

export function pluginRoleDirs(): string[] {
  return enabledPlugins().flatMap((plugin) => resolveDirs(plugin, plugin.manifest.agents));
}

export function pluginMcpServers(): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const plugin of enabledPlugins()) Object.assign(out, bindPluginMcpServers(plugin.root, plugin.manifest));
  return out;
}

export function pluginHooks(): HooksConfig {
  const out: HooksConfig = { PreToolUse: [], PostToolUse: [] };
  for (const plugin of enabledPlugins()) {
    const hooks = plugin.manifest.hooks;
    if (!hooks) continue;
    if (hooks.PreToolUse) out.PreToolUse!.push(...hooks.PreToolUse);
    if (hooks.PostToolUse) out.PostToolUse!.push(...hooks.PostToolUse);
  }
  return out;
}

function validGitSource(source: string): string {
  const url = source.slice("git:".length);
  if (!/^(?:https:\/\/|ssh:\/\/|git@)[^\s\0]+$/u.test(url)) {
    throw new Error("git source must use an https://, ssh://, or git@ URL");
  }
  if (url.startsWith("https://") || url.startsWith("ssh://")) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("git source contains an invalid URL");
    }
    const secretAuthority = url.startsWith("https://")
      ? Boolean(parsed.username || parsed.password)
      : Boolean(parsed.password);
    if (secretAuthority || parsed.search || parsed.hash) {
      throw new Error(
        "git source must not embed credentials or query/fragment secrets; configure a Git credential helper or SSH key instead",
      );
    }
  }
  return url;
}

type PluginGitSourceKind = "github" | "git";

/** Turn git's often credential-bearing stderr into a bounded, actionable diagnosis. Never echo the URL,
 * stderr, usernames, tokens, credential-helper output, or the original command line. */
export function pluginGitCloneFailure(kind: PluginGitSourceKind, error: unknown): string {
  const value = error as {
    code?: unknown;
    signal?: unknown;
    killed?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  const stderr = Buffer.isBuffer(value?.stderr)
    ? value.stderr.toString("utf8")
    : typeof value?.stderr === "string"
      ? value.stderr
      : "";
  const diagnostic = stderr.toLowerCase();
  const label = kind === "github" ? "GitHub plugin repository" : "plugin Git repository";

  if (value?.code === "ENOENT") {
    return `Could not clone the ${label}: Git is not installed or is not available on PATH. Install Git, then retry.`;
  }
  if (
    value?.code === "ETIMEDOUT"
    || value?.signal === "SIGTERM"
    || value?.killed === true
    || /timed out|connection timed out/u.test(diagnostic)
  ) {
    return `Could not clone the ${label}: the network operation exceeded Hara's 2-minute limit. Check connectivity/proxy settings, then retry.`;
  }
  if (
    /could not resolve host|failed to connect|connection refused|network is unreachable|connection reset/u.test(diagnostic)
  ) {
    return `Could not clone the ${label}: Git could not reach the remote host. Check DNS, network, VPN, and Git proxy settings, then retry.`;
  }
  if (
    /authentication failed|permission denied|access denied|could not read username|terminal prompts disabled|publickey|http basic/u.test(diagnostic)
  ) {
    return (
      `Could not clone the ${label}: authentication or repository access was denied. ` +
      (kind === "github"
        ? "For a private repository, authenticate GitHub (`gh auth login` then `gh auth setup-git`) or use `git:git@github.com:owner/repository.git` with a working SSH key. "
        : "Configure credentials for that Git host or use an SSH URL backed by a working key. ") +
      "Do not put a token in the plugin URL."
    );
  }
  if (/repository not found|not found|could not read from remote repository/u.test(diagnostic)) {
    return (
      `Could not clone the ${label}: it does not exist or the current Git identity cannot access it. ` +
      (kind === "github"
        ? "Check owner/repository spelling; for a private repository run `gh auth login` and `gh auth setup-git`, or use a working SSH URL. "
        : "Check the repository URL and credentials. ") +
      "Do not put a token in the plugin URL."
    );
  }
  return (
    `Could not clone the ${label}. Run an equivalent \`git clone\` yourself to diagnose the remote, ` +
    "then retry Hara after Git credentials/network access work. No remote stderr was shown because it may contain credentials."
  );
}

function clonePluginRepository(url: string, staging: string, kind: PluginGitSourceKind): void {
  try {
    execFileSync("git", ["clone", "--depth", "1", url, staging], {
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 256 * 1024,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 2 * 60_000,
    });
  } catch (error) {
    throw new Error(pluginGitCloneFailure(kind, error));
  }
}

function populateStaging(source: string, staging: string): void {
  if (source.startsWith("file:")) {
    const requested = resolve(source.slice("file:".length));
    const info = lstatSync(requested);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`plugin source '${requested}' must be a real directory`);
    const src = realpathSync.native(requested);
    const store = realpathSync.native(pluginStorage());
    const rel = relative(store, src);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      throw new Error("plugin source must not be inside Hara's installed plugin directory");
    }
    cpSync(src, staging, { recursive: true, dereference: false, errorOnExist: true, force: false });
  } else if (source.startsWith("github:")) {
    const repo = source.slice("github:".length);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repo)) throw new Error("github source must be owner/repository");
    clonePluginRepository(`https://github.com/${repo}.git`, staging, "github");
  } else if (source.startsWith("git:")) {
    clonePluginRepository(validGitSource(source), staging, "git");
  } else {
    throw new Error("source must be file:<path>, github:<owner/repo>, or git:<url>");
  }
  safeTemporaryRemove(join(staging, ".git"));
  safeTemporaryRemove(join(staging, ".learnings"));
}

/** Install through a validated same-filesystem stage. Replacements preserve the previous directory and
 * receipt until the new manifest, bin links, and ownership receipt have all committed successfully. */
export function installPlugin(source: string): Plugin {
  const store = pluginStorage();
  const staging = join(store, `_install-${process.pid}-${randomUUID()}`);
  const backup = join(store, `_backup-${process.pid}-${randomUUID()}`);
  let destination = "";
  let newActivated = false;
  let oldMoved = false;
  let oldManifest: VerifiedPluginManifest | null = null;
  let oldReceipt: StoredReceipt | null = null;
  let oldBins: Record<string, string> = {};
  let oldIdentity: { rootDev: string; rootIno: string } | null = null;
  let newManifest: VerifiedPluginManifest | null = null;
  try {
    populateStaging(source, staging);
    newManifest = readVerifiedPluginManifest(staging);
    const name = newManifest.manifest.name;
    destination = pluginRoot(name);

    if (existsSync(destination)) {
      const installed = readInstalled(destination, name);
      oldManifest = installed.verified;
      oldBins = pluginBins(oldManifest.manifest);
      oldReceipt = readReceipt(name);
      if (oldReceipt) verifyReceipt(oldReceipt.receipt, destination, oldManifest);
      oldIdentity = rootIdentity(destination);
    }

    const newBins = pluginBins(newManifest.manifest);
    for (const [name, rel] of Object.entries(oldBins)) preflightBinLink(destination, name, rel);
    for (const [name, rel] of Object.entries(newBins)) {
      const link = join(pluginBinStorage(), name);
      if (!entryExists(link)) continue;
      if (!oldBins[name]) throw new Error(`refusing to overwrite foreign command entry '${link}'`);
      preflightBinLink(destination, name, oldBins[name], false);
      // The new target itself was verified in staging; changed relative targets are replaced after activation.
      void rel;
    }

    if (existsSync(destination)) {
      renameSync(destination, backup);
      oldMoved = true;
      const moved = rootIdentity(backup);
      if (!oldIdentity || moved.rootDev !== oldIdentity.rootDev || moved.rootIno !== oldIdentity.rootIno) {
        throw new Error(`plugin '${name}' root identity changed during update`);
      }
    }
    renameSync(staging, destination);
    newActivated = true;
    newManifest = readVerifiedPluginManifest(destination);

    for (const [name, rel] of Object.entries(oldBins)) {
      if (newBins[name] !== rel) unlinkBinLink(destination, name, rel);
    }
    for (const [name, rel] of Object.entries(newBins)) ensureBinLink(destination, name, rel);
    writeReceipt(name, destination, newManifest);

    const result = {
      name,
      version: newManifest.manifest.version || "0.0.0",
      root: realpathSync.native(destination),
      manifest: newManifest.manifest,
    };
    // Activation and its receipt are committed. Cleanup is deliberately outside rollback: recursive backup
    // removal can partially succeed, so a cleanup error must leave an inert `_backup-*` entry rather than
    // restore a partially removed old package over the verified new one.
    if (oldMoved) {
      try {
        safeTemporaryRemove(backup);
      } catch {
        // A later bounded maintenance pass may remove the skipped, non-loadable backup after inspection.
      }
    }
    return result;
  } catch (error) {
    const rollbackErrors: string[] = [];
    const failedManifest = newManifest;
    const name = failedManifest?.manifest.name;
    if (failedManifest && name && destination) {
      try {
        if (newActivated) {
          for (const [binName, rel] of Object.entries(pluginBins(failedManifest.manifest))) {
            if (entryExists(join(pluginBinStorage(), binName))) unlinkBinLink(destination, binName, rel);
          }
        }
      } catch (rollbackError: any) {
        rollbackErrors.push(`new command cleanup: ${rollbackError?.message ?? String(rollbackError)}`);
      }
      try {
        if (newActivated && existsSync(destination)) safeTemporaryRemove(destination);
        if (oldMoved && existsSync(backup)) renameSync(backup, destination);
      } catch (rollbackError: any) {
        rollbackErrors.push(`directory restore: ${rollbackError?.message ?? String(rollbackError)}`);
      }
      try {
        if (oldMoved && existsSync(destination)) restoreBinLinks(destination, oldBins);
      } catch (rollbackError: any) {
        rollbackErrors.push(`old command restore: ${rollbackError?.message ?? String(rollbackError)}`);
      }
      try {
        restoreReceipt(name, oldReceipt?.raw ?? null);
      } catch (rollbackError: any) {
        rollbackErrors.push(`receipt restore: ${rollbackError?.message ?? String(rollbackError)}`);
      }
    }
    try {
      safeTemporaryRemove(staging);
      safeTemporaryRemove(backup);
    } catch (rollbackError: any) {
      rollbackErrors.push(`staging cleanup: ${rollbackError?.message ?? String(rollbackError)}`);
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(rollbackErrors.length ? `${detail}; rollback warning: ${rollbackErrors.join("; ")}` : detail);
  }
}

export function uninstallPlugin(rawName: string): boolean {
  const name = safePluginId(rawName);
  const destination = pluginRoot(name);
  if (!existsSync(destination)) return false;
  const installed = readInstalled(destination, name);
  const stored = readReceipt(name);
  if (!stored) {
    throw new Error(
      `refusing to uninstall legacy plugin '${name}' without an ownership receipt; ` +
        "reinstall the same source with this Hara version, then remove it",
    );
  }
  verifyReceipt(stored.receipt, destination, installed.verified);
  for (const [binName, rel] of Object.entries(stored.receipt.bins)) preflightBinLink(destination, binName, rel);

  const quarantine = join(pluginStorage(), `_remove-${process.pid}-${randomUUID()}`);
  renameSync(destination, quarantine);
  const moved = rootIdentity(quarantine);
  if (moved.rootDev !== stored.receipt.rootDev || moved.rootIno !== stored.receipt.rootIno) {
    renameSync(quarantine, destination);
    throw new Error(`plugin '${name}' root identity changed during uninstall`);
  }
  try {
    for (const [binName, rel] of Object.entries(stored.receipt.bins)) unlinkBinLink(destination, binName, rel);
    removePrivateStateFile(stored.binding.path, stored.snapshot, stored.binding.directory);
  } catch (error) {
    const rollbackErrors: string[] = [];
    try {
      if (existsSync(quarantine) && !existsSync(destination)) renameSync(quarantine, destination);
      restoreBinLinks(destination, stored.receipt.bins);
    } catch (rollbackError: any) {
      rollbackErrors.push(rollbackError?.message ?? String(rollbackError));
    }
    try {
      restoreReceipt(name, stored.raw);
    } catch (rollbackError: any) {
      rollbackErrors.push(rollbackError?.message ?? String(rollbackError));
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(rollbackErrors.length ? `${detail}; rollback warning: ${rollbackErrors.join("; ")}` : detail);
  }
  // The namespace, executable links, and receipt are already removed. A cleanup failure leaves only an
  // inert unpredictable quarantine directory and must not reactivate unreceipted code.
  try {
    safeTemporaryRemove(quarantine);
  } catch {
    // A later bounded maintenance pass may remove it after inspecting ownership.
  }
  return true;
}

function safeMarkerExists(cwd: string, marker: string): boolean {
  try {
    const rel = safePluginRelativePath(marker, "plugin panel detect marker");
    const canonicalRoot = realpathSync.native(resolve(cwd));
    let current = canonicalRoot;
    for (const part of rel.split("/")) {
      current = join(current, part);
      const info = lstatSync(current);
      if (info.isSymbolicLink()) return false;
    }
    const relToRoot = relative(canonicalRoot, realpathSync.native(current));
    return !relToRoot.startsWith("..") && !isAbsolute(relToRoot);
  } catch {
    return false;
  }
}

export function matchPanels(plugins: Plugin[], cwd: string): { plugin: string; panel: PanelSpec }[] {
  const out: { plugin: string; panel: PanelSpec }[] = [];
  for (const plugin of plugins) {
    for (const panel of plugin.manifest.panels ?? []) {
      if (!panel.detect?.length) continue;
      if (panel.detect.some((marker) => safeMarkerExists(cwd, marker))) out.push({ plugin: plugin.name, panel });
    }
  }
  return out;
}

export function panelsForProject(cwd: string): { plugin: string; panel: PanelSpec }[] {
  return matchPanels(enabledPlugins(), cwd);
}

export function setPluginEnabled(rawName: string, on: boolean): void {
  const name = safePluginId(rawName);
  updateRawConfig((config) => {
    const plugins = (config.plugins && typeof config.plugins === "object" ? config.plugins : {}) as Record<string, any>;
    plugins.enabled = { ...(plugins.enabled ?? {}), [name]: on };
    config.plugins = plugins;
  });
}
