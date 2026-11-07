// Workspace MCP manager cases: Host review and governed Pi stdio. Shared cases live in helpers/workspace-mcp-manager-cases.mjs.
import { registerMcpManagerCases } from "./helpers/workspace-mcp-manager-cases.mjs";
registerMcpManagerCases(name => /^(Host review binds actual binary|actual governed Pi )/u.test(name));
