// Minimal MCP stdio server exposing one `echo` tool — used by test/mcp.test.mjs.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo back the provided text.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const text = req.params?.arguments?.text ?? "";
  return { content: [{ type: "text", text: String(text) }] };
});

await server.connect(new StdioServerTransport());
