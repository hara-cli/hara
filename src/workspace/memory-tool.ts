import { createHash } from "node:crypto";
import { sanitizeMemoryForPrompt } from "../memory/guard.js";
import { redactSensitiveText } from "../security/secrets.js";
import type { Tool } from "../tools/registry.js";
import { exact, plain, text } from "./local-state.js";

/** Same-Workspace remembered TEXT only: no arbitrary path API, memory edits, global home discovery
 * or permission recovery. Historical notes are context, never evidence that a fresh action happened. */
export function workspaceMemorySearchTool(search: (query: string, limit: number) => Promise<{ title: string; snippet: string }[]>, assertCurrent: () => void): Tool {
  return { name: "workspace_memory_search", kind: "read", description: "Search remembered notes of THIS Workspace. Historical context only, not permissions or proof of newly completed work. No host paths or other Workspace data.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    async run(input) {
      if (!plain(input) || !exact(input, ["query"]) || !text(input.query, 200)) throw new Error("Invalid Workspace memory query");
      assertCurrent(); const hits = await search(input.query, 5); assertCurrent();
      const clean = (value: string, cap: number) => redactSensitiveText(sanitizeMemoryForPrompt(value).text).text.slice(0, cap);
      const rows = hits.slice(0, 5).map(row => ({ ref: createHash("sha256").update(row.title + "\0" + row.snippet).digest("hex"),
        title: clean(row.title, 120), snippet: clean(row.snippet, 600) })).filter(row => row.snippet);
      while (JSON.stringify({ historicalContextOnly: true, hits: rows }).length > 7400) rows.pop();
      return JSON.stringify({ historicalContextOnly: true, hits: rows });
    } };
}
