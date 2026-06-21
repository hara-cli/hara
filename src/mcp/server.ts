// MCP server — expose hara's safe read/search tools over stdio so other MCP clients (Claude Desktop,
// Cursor, another hara, …) can use them. The high-value one is `codebase_search` over the current repo
// (semantic if you've built an index, lexical otherwise). `hara mcp` runs this.
//
// Read-only by DEFAULT: no edit/write/bash/computer — an external client must not be able to mutate your
// machine through hara. Override the exposed set with HARA_MCP_TOOLS (comma list) at your own risk.
//
// IMPORTANT: stdio is the JSON-RPC transport — this module must never write to stdout. Diagnostics go to
// stderr (the `hara mcp` command handles that); tool output flows back through the protocol.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { getTool, getTools, type ToolContext } from "../tools/registry.js";

/** Safe default: navigate + search the repo + the web. No state, no mutation, no privacy-sensitive memory. */
const SAFE_TOOLS = ["read_file", "grep", "glob", "ls", "codebase_search", "web_fetch", "web_search"];

/** Names to expose: HARA_MCP_TOOLS (comma list) if set, else the safe default — intersected with what's
 *  actually registered. An unknown name in the override is silently dropped. */
export function mcpServeToolNames(): string[] {
  const env = process.env.HARA_MCP_TOOLS;
  const want = env ? env.split(",").map((s) => s.trim()).filter(Boolean) : SAFE_TOOLS;
  const have = new Set(getTools().map((t) => t.name));
  return want.filter((n) => have.has(n));
}

/** The exposed tools in MCP `tools/list` shape. */
export function mcpToolList(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  return mcpServeToolNames().map((n) => {
    const t = getTool(n)!;
    return { name: t.name, description: t.description, inputSchema: t.input_schema as unknown as Record<string, unknown> };
  });
}

interface CallResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** Run one exposed tool. Refuses anything outside the exposed set (defense in depth, even if a client
 *  asks for a name it shouldn't know). Never throws — errors come back as `isError` results. */
export async function mcpCallTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<CallResult> {
  if (!mcpServeToolNames().includes(name)) {
    return { content: [{ type: "text", text: `Tool not exposed by \`hara mcp\`: ${name}` }], isError: true };
  }
  const tool = getTool(name);
  if (!tool) return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  try {
    const out = await tool.run(args ?? {}, ctx);
    return { content: [{ type: "text", text: String(out) }] };
  } catch (e: unknown) {
    return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
}

/** Start the stdio MCP server and block (the transport keeps the process alive). */
export async function startMcpServer(version: string, ctx: ToolContext): Promise<void> {
  const server = new Server({ name: "hara", version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpToolList() }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK's result union has a task-augmented
  // member TS can't narrow to; our {content,isError} shape is a valid CallToolResult (validated at runtime).
  server.setRequestHandler(CallToolRequestSchema, async (req) => (await mcpCallTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, ctx)) as any);
  await server.connect(new StdioServerTransport());
}
