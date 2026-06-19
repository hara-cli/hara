// web_fetch — fetch an http(s) URL and return readable text (HTML reduced to text). Read-only.
// Uses Node's global fetch (Node >=20). NOT sandboxed (network egress is in-process, not via bash).
import { registerTool } from "./registry.js";

const MAX = 60_000;

/** Strip HTML to a readable-ish plain-text approximation (no dependency). */
export function htmlToText(html: string): string {
  return html
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article|header|footer|ul|ol|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

registerTool({
  name: "web_fetch",
  description:
    "Fetch an http(s) URL and return its text content (HTML is reduced to readable text). Read-only. " +
    "Use for docs, references, or pages the user mentions. Not sandboxed.",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "http:// or https:// URL" },
      max_chars: { type: "number", description: "cap on returned text (default 60000)" },
    },
    required: ["url"],
  },
  kind: "read",
  async run(input) {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return `Error: invalid URL: ${input.url}`;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return "Error: only http/https URLs are supported.";
    const cap = Math.min(Math.max(1000, input.max_chars ?? MAX), 200_000);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30_000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        redirect: "follow",
        headers: { "user-agent": "hara-cli", accept: "text/html,text/plain,application/json,*/*" },
      });
      const ct = res.headers.get("content-type") ?? "";
      const raw = await res.text();
      let text = /html/i.test(ct) ? htmlToText(raw) : raw;
      if (text.length > cap) text = text.slice(0, cap) + `\n…[truncated ${text.length - cap} chars]`;
      return `# ${url.href} (HTTP ${res.status})\n\n${text || "(empty body)"}`;
    } catch (e: any) {
      return `Error fetching ${url.href}: ${e?.name === "AbortError" ? "timed out (30s)" : (e?.message ?? e)}`;
    } finally {
      clearTimeout(timer);
    }
  },
});
