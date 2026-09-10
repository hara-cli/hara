import test from "node:test";
import assert from "node:assert/strict";

import { registerServeMcpCapabilities } from "../dist/serve/mcp-capabilities.js";
import { getTool } from "../dist/tools/registry.js";

test("Serve exposes installed and configured MCP servers lazily without starting them", () => {
  const names = registerServeMcpCapabilities(
    {
      browser: {
        command: "npx",
        args: ["-y", "@playwright/mcp@0.0.80"],
        description: "structured browser",
      },
    },
    {
      custom: { command: "fixture-custom" },
      browser: { command: "fixture-user-browser", description: "user override" },
    },
    () => assert.fail("registration must not start or log an MCP process"),
  );
  assert.deepEqual(names, ["browser", "custom"]);
  const connect = getTool("mcp_connect");
  assert.ok(connect, "Serve registers the lazy MCP connector in the shared tool registry");
  assert.deepEqual(connect.input_schema.properties.server.enum, ["browser", "custom"]);
  assert.match(connect.description, /browser \(user override\)/);
});
