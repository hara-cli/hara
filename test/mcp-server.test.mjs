import { test } from "node:test";
import assert from "node:assert/strict";
// populate the tool registry (side-effect imports, same as the CLI does)
import "../dist/tools/builtin.js"; // read_file, bash
import "../dist/tools/search.js"; // grep, glob, ls
import "../dist/tools/codebase.js"; // codebase_search
import "../dist/tools/edit.js"; // edit_file
import "../dist/tools/web.js"; // web_search, web_fetch
import { mcpServeToolNames, mcpToolList, mcpCallTool } from "../dist/mcp/server.js";

test("exposes safe read/search tools; never edit_file or bash", () => {
  const names = mcpServeToolNames();
  for (const safe of ["read_file", "grep", "glob", "ls", "codebase_search", "web_search", "web_fetch"]) {
    assert.ok(names.includes(safe), `exposes ${safe}`);
  }
  assert.ok(!names.includes("edit_file"), "does NOT expose edit_file");
  assert.ok(!names.includes("bash"), "does NOT expose bash");
});

test("tools/list shape: name + description + inputSchema", () => {
  const list = mcpToolList();
  const ls = list.find((t) => t.name === "ls");
  assert.ok(ls, "ls present");
  assert.equal(typeof ls.description, "string");
  assert.equal(ls.inputSchema.type, "object");
});

test("calling an exposed tool runs it and returns text content", async () => {
  const r = await mcpCallTool("ls", { path: "." }, { cwd: process.cwd() });
  assert.ok(!r.isError, "not an error");
  assert.equal(r.content[0].type, "text");
  assert.match(r.content[0].text, /package\.json/, "listed the repo");
});

test("calling a non-exposed tool is refused (defense in depth), even though it's registered", async () => {
  const r = await mcpCallTool("edit_file", { path: "x", old_string: "a", new_string: "b" }, { cwd: process.cwd() });
  assert.ok(r.isError, "refused");
  assert.match(r.content[0].text, /not exposed/i);
});

test("HARA_MCP_TOOLS overrides the exposed set (intersected with the registry)", () => {
  const prev = process.env.HARA_MCP_TOOLS;
  process.env.HARA_MCP_TOOLS = "read_file, ls , does_not_exist";
  try {
    assert.deepEqual(mcpServeToolNames(), ["read_file", "ls"], "honors the override, drops unknowns");
  } finally {
    if (prev === undefined) delete process.env.HARA_MCP_TOOLS;
    else process.env.HARA_MCP_TOOLS = prev;
  }
});
