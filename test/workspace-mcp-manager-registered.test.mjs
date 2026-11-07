// Workspace MCP manager cases: registered Codex and Claude adapters. Shared cases live in helpers/workspace-mcp-manager-cases.mjs.
import { registerMcpManagerCases } from "./helpers/workspace-mcp-manager-cases.mjs";
registerMcpManagerCases(name => /^registered (codex|claude) adapter/u.test(name));
