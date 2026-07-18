// Provider-neutral deferred tool discovery and continuation reads for oversized tool output.
// These eager tools replace two context-hostile patterns: exposing every long-tail schema up front, and
// rerunning a broad command because the useful middle of its output was discarded.
import { registerTool, searchDeferredToolCatalog } from "./registry.js";
import { MAX_TOOL_RESULT_READ_CHARS, readStoredToolResult } from "./result-limit.js";

registerTool({
  name: "tool_search",
  description:
    "Search Hara's deferred tool catalog when the current task needs a capability that is not already listed. " +
    "Matching tools become available on the NEXT model round without loading every long-tail/MCP schema up front. " +
    "Search by capability or service, for example browser, wechat, spreadsheet, or calendar.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Capability, service, or action to find." },
      max_results: { type: "integer", minimum: 1, maximum: 8, description: "Maximum matches to activate (default 5)." },
    },
    required: ["query"],
  },
  kind: "read",
  classify: () => ({ effect: "state", concurrencySafe: false }),
  async run(input, ctx) {
    const query = typeof input?.query === "string" ? input.query.trim() : "";
    if (!query) return "Error: tool_search needs a non-empty query.";
    const limit = Math.max(1, Math.min(8, Math.floor(Number(input?.max_results) || 5)));
    // Search beyond the display limit because a role filter may reject high-ranked candidates.
    const candidates = searchDeferredToolCatalog(query, 32);
    const selected: typeof candidates = [];
    for (const match of candidates) {
      const accepted = ctx.activateTools ? ctx.activateTools([match.name]) : [match.name];
      if (!accepted.includes(match.name)) continue;
      selected.push(match);
      if (selected.length >= limit) break;
    }
    if (!selected.length) {
      return `No deferred tools matching "${query}" are available to this run. Use an existing tool or refine the query.`;
    }
    return (
      `Activated ${selected.length} tool(s) for the next model round:\n` +
      selected.map((match) => `- ${match.name} — ${match.description.slice(0, 300)}`).join("\n")
    );
  },
});

registerTool({
  name: "tool_result_read",
  description:
    "Read the next bounded character slice of an oversized tool result stored under an opaque tr_* id. " +
    "Use the id and continuation offset from the truncation notice; this tool never accepts filesystem paths.",
  input_schema: {
    type: "object",
    properties: {
      id: { type: "string", pattern: "^tr_[a-f0-9]{32}$", description: "Opaque result id from a tool output." },
      offset: { type: "integer", minimum: 0, description: "0-based character offset (default 0)." },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_TOOL_RESULT_READ_CHARS,
        description: `Characters to return (default/max ${MAX_TOOL_RESULT_READ_CHARS}).`,
      },
    },
    required: ["id"],
  },
  kind: "read",
  concurrencySafe: true,
  async run(input) {
    return readStoredToolResult(String(input?.id ?? ""), input?.offset, input?.limit);
  },
});
