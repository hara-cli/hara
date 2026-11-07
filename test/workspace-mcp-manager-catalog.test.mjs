// Workspace MCP manager cases: capabilities, off switches and optional catalog. Shared cases live in helpers/workspace-mcp-manager-cases.mjs.
import { registerMcpManagerCases } from "./helpers/workspace-mcp-manager-cases.mjs";
registerMcpManagerCases(name => /^(per-attempt loopback capabilities|off switches, unreviewed metadata|failed optional catalog removes)/u.test(name));
