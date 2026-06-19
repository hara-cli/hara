import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { connectMcpServers, closeMcp } from "../dist/mcp/client.js";
import { getTool } from "../dist/tools/registry.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "mcp-echo-server.mjs");

test("mcp: connect → register tool → call it", async () => {
  const n = await connectMcpServers({ echo: { command: process.execPath, args: [fixture] } }, () => {});
  try {
    assert.ok(n >= 1, "registered ≥1 tool");
    const tool = getTool("mcp__echo__echo");
    assert.ok(tool, "mcp__echo__echo present");
    const r = await tool.run({ text: "hi-mcp" }, { cwd: process.cwd() });
    assert.match(r, /hi-mcp/);
  } finally {
    await closeMcp();
  }
});
