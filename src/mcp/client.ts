// MCP client — connect to configured MCP servers (stdio) and register their tools into hara.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { registerTool } from "../tools/registry.js";
import type { McpServerConfig } from "../config.js";

const clients: Client[] = [];

/** Connect each server, register its tools as `mcp__<server>__<tool>`. Returns #tools registered. */
export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
  log: (m: string) => void,
): Promise<number> {
  let count = 0;
  for (const [name, cfg] of Object.entries(servers)) {
    try {
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
      });
      const client = new Client({ name: "hara", version: "0.4.0" }, { capabilities: {} });
      await client.connect(transport);
      clients.push(client);

      const { tools } = await client.listTools();
      for (const t of tools) {
        const schema = (t.inputSchema as any) ?? { type: "object", properties: {} };
        registerTool({
          name: `mcp__${name}__${t.name}`,
          description: t.description ?? `${name}/${t.name}`,
          input_schema: schema,
          kind: "exec",
          async run(input) {
            const res: any = await client.callTool({ name: t.name, arguments: input ?? {} });
            const blocks: any[] = Array.isArray(res?.content) ? res.content : [];
            const text = blocks.map((b) => (b?.type === "text" ? b.text : JSON.stringify(b))).join("\n");
            return text || "(no output)";
          },
        });
        count++;
      }
      log(`mcp: ${name} → ${tools.length} tool(s)`);
    } catch (e: any) {
      log(`mcp: ${name} failed (${e?.message ?? e})`);
    }
  }
  return count;
}

export async function closeMcp(): Promise<void> {
  for (const cl of clients) {
    try {
      await cl.close();
    } catch {
      /* ignore */
    }
  }
  clients.length = 0;
}
