// Minimal MCP stdio server exposing one `echo` tool — used by test/mcp.test.mjs.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { writeFileSync } from "node:fs";

if (process.env.MCP_PID_FILE) writeFileSync(process.env.MCP_PID_FILE, `${process.pid}\n`);

// Test-only modes for bounded startup coverage. Closing the client's transport ends stdin, at which point
// this fixture exits immediately; tests therefore exercise a real hung peer without waiting on kill grace periods.
if (process.env.MCP_HANG_CONNECT === "1") {
  process.stdin.resume();
  process.stdin.once("end", () => process.exit(0));
  await new Promise(() => {});
}

const server = new Server({ name: "echo", version: "1.0.0" }, { capabilities: { tools: {} } });

// Exercise the client's stderr boundary. Deliberately split the configured value across writes so a
// per-chunk redactor would leak it; the client must buffer through the newline before logging anything.
if (process.env.MCP_EMIT_STDERR === "1" && process.env.MCP_DIAGNOSTIC_TOKEN) {
  const token = process.env.MCP_DIAGNOSTIC_TOKEN;
  process.stderr.write(`diagnostic=${token.slice(0, 4)}`);
  await new Promise((resolve) => setTimeout(resolve, 5));
  process.stderr.write(`${token.slice(4)}\n`);
}

if (process.env.MCP_EMIT_OVERSIZED_STDERR === "1") {
  process.stderr.write(`oversized=${"x".repeat(20 * 1024)}\n`);
}

if (process.env.MCP_HANG_LIST === "1") {
  process.stdin.once("end", () => process.exit(0));
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  if (process.env.MCP_HANG_LIST === "1") await new Promise(() => {});
  return {
    tools: [
      {
        name: "echo",
        description: "Echo back the provided text.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const text = req.params?.arguments?.text ?? "";
  return { content: [{ type: "text", text: String(text) }] };
});

await server.connect(new StdioServerTransport());
