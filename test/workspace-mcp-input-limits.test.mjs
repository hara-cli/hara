import test from "node:test";
import assert from "node:assert/strict";
import {
  createWorkspaceMcpEndpoint, WORKSPACE_MCP_MAX_ARGUMENT_ELEMENTS, WORKSPACE_MCP_MAX_REQUEST_BYTES,
  WORKSPACE_MCP_TOKEN_ENV,
} from "../dist/agent-runtime/registered-cli-mcp.js";
import { ResidentWorkspaceMcp, WORKSPACE_ATTEMPT_MARKER } from "../dist/agent-runtime/registered-cli-resident-mcp.js";

for (const mode of ["per-attempt", "resident"]) {
  test(`${mode} Workspace MCP enforces bytes and cumulative argument elements before tool dispatch`, async t => {
    const tool = {
      name: "fixture_observe",
      description: "Synthetic argument acceptance check",
      input_schema: { type: "object" },
    };
    let calls = 0;
    const input = {
      signal: new AbortController().signal,
      assertCurrent() {},
      tools: () => [tool],
      async call(name, args) {
        assert.equal(name, tool.name);
        assert.equal(Object.hasOwn(args, WORKSPACE_ATTEMPT_MARKER), false);
        calls++;
        return { id: "fixture", name, content: "fixture received" };
      },
    };

    const resident = mode === "resident" ? await ResidentWorkspaceMcp.create("a".repeat(64)) : undefined;
    if (resident) t.after(() => resident.close());
    const endpoint = resident ? resident.bind(input) : await createWorkspaceMcpEndpoint(input);
    t.after(() => endpoint.close());
    const marker = resident ? { [WORKSPACE_ATTEMPT_MARKER]: endpoint.attemptMarker } : {};
    let sessionId, requestId = 0;

    async function request(method, params, token = endpoint.env[WORKSPACE_MCP_TOKEN_ENV]) {
      const body = JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params });
      const response = await fetch(endpoint.url, {
        method: "POST",
        signal: AbortSignal.timeout(5000),
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: "Bearer " + token,
          ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
        },
        body,
      });
      sessionId = response.headers.get("mcp-session-id") ?? sessionId;
      return { status: response.status, bytes: Buffer.byteLength(body), reply: await response.json() };
    }

    const initialized = await request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "fixture", version: "1" },
    });
    assert.equal(initialized.status, 200);
    assert.ok(initialized.reply.result);
    const toolCall = (args, token) => request("tools/call", { name: tool.name, arguments: { ...args, ...marker } }, token);
    assert.equal((await toolCall({ text: "hello" }, "invalid")).status, 401);
    const tooManyBytes = await toolCall({ text: "x".repeat(WORKSPACE_MCP_MAX_REQUEST_BYTES) });
    assert(tooManyBytes.bytes > WORKSPACE_MCP_MAX_REQUEST_BYTES);
    assert.equal(tooManyBytes.status, 413);

    // The batch property, both child keys and the field key count alongside array entries.
    const values = Array(WORKSPACE_MCP_MAX_ARGUMENT_ELEMENTS - 4 - Object.keys(marker).length).fill(0);
    const exactLimit = { batch: { values, fields: { present: true } } };
    for (const batch of [
      { values: [...values, 0], fields: { present: true } },
      { values, fields: { present: true, additional: true } },
    ]) {
      const excess = await toolCall({ batch });
      assert(excess.bytes < WORKSPACE_MCP_MAX_REQUEST_BYTES);
      assert.equal(excess.status, 200);
      assert.equal(excess.reply.result.isError, true);
      assert.equal(excess.reply.result.content[0].text, "Workspace MCP tool arguments exceed the element limit");
    }
    assert.equal(calls, 0, "rejected requests must not reach the tool");

    for (const args of [exactLimit, { text: "hello" }]) {
      const accepted = await toolCall(args);
      assert.equal(accepted.status, 200);
      assert.equal(accepted.reply.result.content[0].text, "fixture received");
    }
    assert.equal(calls, 2);
  });
}
