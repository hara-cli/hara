import type { McpServerConfig } from "../config.js";
import { registerLazyMcpServers } from "../mcp/client.js";

/** Register the lazy MCP launcher for Desktop/Serve without starting any extension process. */
export function registerServeMcpCapabilities(
  pluginServers: Record<string, McpServerConfig>,
  configuredServers: Record<string, McpServerConfig>,
  log: (message: string) => void,
): string[] {
  const servers = { ...pluginServers, ...configuredServers };
  const names = Object.keys(servers);
  if (names.length) registerLazyMcpServers(servers, log);
  return names;
}
