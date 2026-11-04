// Host-only launcher projection. Renderer/model IDs never choose a command or filesystem path.
import { accessSync, constants, lstatSync, realpathSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { readPrivateStateFileSnapshotSync } from "../security/private-state.js";
import { readVerifiedPluginManifest } from "../plugins/manifest.js";
import { redactSensitiveText } from "../security/secrets.js";
import { canonical, plain } from "./local-state.js";
import { extensionDigest, projectHostMcpConfig, readHostWorkspaceExtensionCatalog, type ExtensionSourceDescriptor } from "./extension-catalog.js";
import { McpOwnerReviewError } from "./extension-review-store.js";

export interface WorkspaceMcpLaunchDefinition { command: string; args: string[]; packageRoot?: string; requiresCredentials?: boolean }
export type WorkspaceMcpLaunchProvider = (source: ExtensionSourceDescriptor) => WorkspaceMcpLaunchDefinition;
const within = (root: string, path: string) => path === root || path.startsWith(root + sep);
function fixedCommand(command: string): string {
  if (!command || /[\s\x00-\x1f\x7f]/u.test(command)) throw new McpOwnerReviewError("unsupported_command");
  const name = basename(command).replace(/\.exe$/iu, "").toLowerCase();
  if (["env", "npx", "npm", "pnpm", "yarn", "uv", "uvx", "pip", "pipx", "sh", "bash", "zsh", "fish", "osascript", "cmd", "powershell", "pwsh"].includes(name)) throw new McpOwnerReviewError("unsupported_command");
  const candidates = isAbsolute(command) ? [command] : command === "node" && /^node(?:\.exe)?$/u.test(basename(process.execPath))
    ? [process.execPath] : (process.env.PATH ?? "/usr/bin:/bin").split(":").filter(isAbsolute).map(dir => join(dir, command));
  for (const candidate of candidates) {
    try { const physical = realpathSync.native(candidate); accessSync(physical, constants.X_OK); if (["env", "npx", "npm", "pnpm", "yarn", "uv", "uvx", "pip", "pipx", "sh", "bash", "zsh", "fish", "osascript", "cmd", "powershell", "pwsh"].includes(basename(physical).toLowerCase())) continue; if (lstatSync(physical).isFile()) return physical; } catch { /* no shell/login/install fallback */ }
  }
  throw new McpOwnerReviewError("unsupported_command");
}
export function normalizeWorkspaceMcpLaunch(source: ExtensionSourceDescriptor, input: WorkspaceMcpLaunchDefinition, hostHome: string, stateHome: string) {
  if (process.platform !== "darwin") throw new McpOwnerReviewError("unsupported_platform");
  if (source.transport !== "stdio") throw new McpOwnerReviewError("unsupported_transport");
  if (input.requiresCredentials) throw new McpOwnerReviewError("credentials_unsupported");
  if (!Array.isArray(input.args) || input.args.length > 64 || input.args.some(arg => typeof arg !== "string" || arg.length > 4096 || /[\x00-\x1f\x7f]/u.test(arg))
    || Buffer.byteLength(canonical(input.args)) > 16 * 1024) throw new McpOwnerReviewError("unsupported_command");
  if (redactSensitiveText(canonical(input.args)).redactions.length || input.args.some(arg => /(?:^|--)(?:token|password|secret|api[-_]?key|authorization|cookie)(?:=|$)/iu.test(arg))) throw new McpOwnerReviewError("credentials_unsupported");
  let command = fixedCommand(input.command); const args = [...input.args];
  if (/\.(?:mjs|cjs|js)$/iu.test(command)) { args.unshift(command); command = fixedCommand("node"); }
  // Inline code / shell/module discovery cannot masquerade as a fixed package.
  if (args.some(arg => /^(?:-e|-p|-c|-m|-r|--eval|--print|--command|--require|--import|--loader)(?:=|$)/u.test(arg))) throw new McpOwnerReviewError("unsupported_command");
  try {
    const script = args.findIndex(arg => isAbsolute(arg) && /\.(?:mjs|cjs|js|py)$/iu.test(arg));
    if (script >= 0) args[script] = realpathSync.native(args[script]!);
    let packageRoot = input.packageRoot ? realpathSync.native(input.packageRoot) : script >= 0 ? dirname(args[script]!) : dirname(command);
    if (!input.packageRoot && script >= 0) {
      let cursor = packageRoot;
      for (let depth = 0; depth < 6 && cursor !== dirname(cursor); depth++, cursor = dirname(cursor)) {
        if (cursor === hostHome || cursor === stateHome) break;
        try { if (lstatSync(join(cursor, "package.json")).isFile()) { packageRoot = cursor; break; } } catch { /* standalone bundled scripts need no manifest */ }
      }
    }
    const privateRoots = [stateHome, ...[".ssh", ".aws", ".codex", ".claude", ".gemini", ".kimi", ".cursor", ".copilot", ".grok", ".config", "Library/Keychains"].map(name => join(hostHome, name))];
    const hostState = join(hostHome, ".hara"), pluginRoot = join(hostState, "plugins");
    if (privateRoots.some(root => within(root, packageRoot)) || within(hostState, packageRoot) && !(source.kind === "plugin" && within(pluginRoot, packageRoot))) throw new McpOwnerReviewError("package_unavailable");
    if (!lstatSync(packageRoot).isDirectory()) throw new Error();
    return { source, command, args, packageRoot };
  } catch (error) { throw error instanceof McpOwnerReviewError ? error : new McpOwnerReviewError("package_unavailable"); }
}
/** Reads only the MCP domain. Global credential values are skipped by the scanner; verified plugin
 * manifests reuse the existing reader. Credential values are never selected, resolved or forwarded. */
export function readHostWorkspaceMcpLaunch(home: string, hostId: string, source: ExtensionSourceDescriptor): WorkspaceMcpLaunchDefinition {
  const current = readHostWorkspaceExtensionCatalog(home, hostId).find(row => row.sourceId === source.sourceId);
  if (!current || extensionDigest(current) !== extensionDigest(source)) throw new McpOwnerReviewError("review_changed");
  let server: unknown;
  if (source.kind === "global") {
    const snapshot = readPrivateStateFileSnapshotSync(join(home, ".hara/config.json"), 1024 * 1024);
    const projected = snapshot ? projectHostMcpConfig(snapshot.text, true) : undefined;
    if (plain(projected)) server = projected[source.sourceId.split(":").at(-1)!];
  } else if (source.kind === "plugin") {
    const digest = source.sourceId.split(":")[1], key = source.sourceId.split(":")[2]!;
    for (const entry of readdirSync(join(home, ".hara/plugins"), { withFileTypes: true }).slice(0, 128)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      try { const plugin = readVerifiedPluginManifest(join(home, ".hara/plugins", entry.name), { scanTree: false });
        if (plugin.manifest.name === entry.name && plugin.sha256 === digest && plain(plugin.manifest.mcpServers)) {
          server = plugin.manifest.mcpServers[key];
          if (plain(server)) {
            const root = realpathSync.native(join(home, ".hara/plugins", entry.name));
            const original = server, args = Array.isArray(original.args) ? original.args.map(arg => typeof arg === "string" && !isAbsolute(arg) && /\.(?:mjs|cjs|js|py)$/iu.test(arg) ? join(root, arg) : arg) : original.args;
            server = { command: typeof original.command === "string" && original.command.startsWith(".") ? join(root, original.command) : original.command,
              args, packageRoot: root, requiresCredentials: ["env", "headers", "authorization", "oauth", "auth", "credentials"].some(name => Object.hasOwn(original, name)) };
          }
          break;
        }
      } catch { /* unverified plugin contributions cannot become a launcher */ }
    }
  }
  if (!plain(server)) throw new McpOwnerReviewError("package_unavailable");
  // Inspect presence only; never read a configured credential/environment/header value.
  const requiresCredentials = server.requiresCredentials === true || ["env", "headers", "authorization", "oauth", "auth", "credentials"].some(key => Object.hasOwn(server, key));
  return { command: typeof server.command === "string" ? server.command : "", args: server.args === undefined ? [] : server.args as string[],
    ...(typeof server.packageRoot === "string" ? { packageRoot: server.packageRoot } : {}), requiresCredentials };
}
