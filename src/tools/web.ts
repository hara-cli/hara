// web_fetch — fetch an http(s) URL and return readable text (HTML reduced to text). Read-only.
// Uses Node's global fetch (Node >=20). NOT sandboxed (network egress is in-process, not via bash) —
// so it carries an SSRF guard: private/loopback/link-local targets are refused, re-checked on every
// redirect hop, and the body is read under a hard byte ceiling.
import { registerTool } from "./registry.js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX = 60_000;

/** True for loopback / private / link-local / ULA / CGNAT addresses we must not let web_fetch reach. */
export function isPrivateIp(ip: string): boolean {
  const host = ip.replace(/^\[|\]$/g, "");
  if (isIP(host) === 4) {
    const p = host.split(".").map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127);
  }
  const l = host.toLowerCase();
  if (l === "::1" || l === "::") return true;
  if (l.startsWith("fe80") || l.startsWith("fc") || l.startsWith("fd")) return true; // link-local + unique-local
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l); // IPv4-mapped IPv6
  return m ? isPrivateIp(m[1]) : false;
}

/** Refuse to fetch a host that is (or resolves to) a private/internal address — defeats metadata-endpoint
 *  / localhost SSRF. Throws (caught by the caller) on a blocked or unresolvable host. */
async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`refusing to fetch ${host} (private/loopback address)`);
    return;
  }
  const addrs = await lookup(host, { all: true });
  for (const a of addrs) if (isPrivateIp(a.address)) throw new Error(`refusing to fetch ${host} — resolves to a private/internal address (${a.address})`);
}

/** Read a fetch Response body up to `maxBytes`, then stop (avoids materializing a huge / bomb body). */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
    if (total >= maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* already closing */
      }
      break;
    }
  }
  return Buffer.concat(chunks).toString("utf8");
}

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

/** Parse DuckDuckGo HTML results → [{title, url, snippet}]. Best-effort HTML scrape (no key, no dependency). */
export function parseSearchResults(html: string, limit: number): { title: string; url: string; snippet: string }[] {
  const strip = (s: string): string =>
    s
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  const snippets: string[] = [];
  const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = snipRe.exec(html))) snippets.push(strip(m[1]));
  const out: { title: string; url: string; snippet: string }[] = [];
  const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let i = 0;
  while ((m = linkRe.exec(html)) && out.length < limit) {
    let href = m[1].replace(/&amp;/g, "&");
    const uddg = /[?&]uddg=([^&]+)/.exec(href); // DuckDuckGo wraps results in a /l/?uddg=<real-url> redirect
    if (uddg) href = decodeURIComponent(uddg[1]);
    else if (href.startsWith("//")) href = "https:" + href;
    out.push({ title: strip(m[2]), url: href, snippet: snippets[i++] ?? "" });
  }
  return out;
}

registerTool({
  name: "web_search",
  description:
    "Search the web and return the top results (title, URL, snippet). Use it to FIND information or pages you " +
    "don't already have a URL for, then `web_fetch` a result to read it. Read-only. Reliable with a Tavily key " +
    "(env HARA_SEARCH_API_KEY); otherwise a best-effort keyless fallback that may be rate-limited.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "number", description: "max results (default 6, max 10)" },
    },
    required: ["query"],
  },
  kind: "read",
  async run(input) {
    const q = String(input.query ?? "").trim();
    if (!q) return "(empty query)";
    const limit = Math.min(Math.max(1, Number(input.limit) || 6), 10);
    const fmt = (rs: { title: string; url: string; snippet: string }[]): string =>
      rs.map((r, n) => `${n + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n\n");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      // Reliable path: Tavily (designed for agents, free tier) when a key is configured.
      const key = process.env.HARA_SEARCH_API_KEY || process.env.TAVILY_API_KEY;
      if (key) {
        const res = await fetch("https://api.tavily.com/search", {
          method: "POST",
          signal: ctrl.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ api_key: key, query: q, max_results: limit }),
        });
        if (res.ok) {
          const j = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
          const rs = (j.results ?? []).map((x) => ({ title: String(x.title ?? x.url ?? ""), url: String(x.url ?? ""), snippet: String(x.content ?? "").slice(0, 200) }));
          if (rs.length) return fmt(rs);
        }
        // Tavily failed → fall through to the keyless best-effort path.
      }
      // Keyless fallback: DuckDuckGo HTML (POST — GET returns a 202 challenge). May be rate-limited.
      const res = await fetch("https://html.duckduckgo.com/html/", {
        method: "POST",
        signal: ctrl.signal,
        redirect: "follow",
        headers: {
          "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          "content-type": "application/x-www-form-urlencoded",
          accept: "text/html",
        },
        body: `q=${encodeURIComponent(q)}`,
      });
      if (!res.ok) return `Search failed: HTTP ${res.status}. Keyless search is rate-limited — set HARA_SEARCH_API_KEY (Tavily) for reliable search, or web_fetch a known URL.`;
      const results = parseSearchResults(await res.text(), limit);
      if (!results.length) return "(no results — the keyless endpoint is rate-limited or changed. Set HARA_SEARCH_API_KEY (Tavily) for reliable search, or web_fetch a known URL.)";
      return fmt(results);
    } catch (e: any) {
      return `Search failed: ${e?.name === "AbortError" ? "timed out (20s)" : (e?.message ?? e)}`;
    } finally {
      clearTimeout(timer);
    }
  },
});

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
      // Follow redirects manually so the SSRF guard runs on EVERY hop (a public URL can 30x to 169.254…).
      let current = url;
      let res: Response;
      for (let hop = 0; ; hop++) {
        await assertPublicHost(current.hostname);
        res = await fetch(current, {
          signal: ctrl.signal,
          redirect: "manual",
          headers: { "user-agent": "hara-cli", accept: "text/html,text/plain,application/json,*/*" },
        });
        const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
        if (!loc || hop >= 5) break;
        const next = new URL(loc, current);
        if (next.protocol !== "http:" && next.protocol !== "https:") return "Error: redirect to a non-http(s) URL was blocked.";
        current = next;
      }
      const ct = res.headers.get("content-type") ?? "";
      const raw = await readCapped(res, cap * 4); // byte ceiling (HTML→text shrinks; cap*4 leaves headroom)
      let text = /html/i.test(ct) ? htmlToText(raw) : raw;
      if (text.length > cap) text = text.slice(0, cap) + `\n…[truncated ${text.length - cap} chars]`;
      return `# ${current.href} (HTTP ${res.status})\n\n${text || "(empty body)"}`;
    } catch (e: any) {
      return `Error fetching ${url.href}: ${e?.name === "AbortError" ? "timed out (30s)" : (e?.message ?? e)}`;
    } finally {
      clearTimeout(timer);
    }
  },
});
