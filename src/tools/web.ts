// web_fetch — fetch an http(s) URL and return readable text (HTML reduced to text). Read-only.
// Uses Node's global fetch (Node >=20). NOT sandboxed (network egress is in-process, not via bash) —
// so it carries an SSRF guard: private/loopback/link-local targets are refused, re-checked on every
// redirect hop, and the body is read under a hard byte ceiling.
import { registerTool } from "./registry.js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { wrapUntrusted } from "../security/external-content.js";

const MAX = 60_000;
const SEARCH_ATTEMPT_MS = 8_000;
const SEARCH_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
type SearchResult = { title: string; url: string; snippet: string };

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

/** Parse Baidu's server-rendered result headings. Baidu result links are redirects, which is fine:
 *  web_fetch follows redirects while re-running its SSRF check on every hop. This gives mainland users a
 *  keyless search path that does not depend on an overseas API being reachable. */
export function parseBaiduSearchResults(html: string, limit: number): { title: string; url: string; snippet: string }[] {
  const strip = (s: string): string =>
    s
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&#x27;/gi, "'")
      .replace(/\s+/g, " ")
      .trim();
  const headings: { at: number; end: number; title: string; url: string }[] = [];
  const re = /<h3\b[^>]*>[\s\S]*?<a\b[^>]*href=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h3>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && headings.length < limit) {
    const title = strip(m[3]);
    const url = (m[1] ?? m[2] ?? "").replace(/&amp;/g, "&");
    if (title && /^https?:\/\//i.test(url)) headings.push({ at: m.index, end: re.lastIndex, title, url });
  }
  return headings.map((h, i) => {
    // The abstract normally sits between this heading and the next result heading. Strip that bounded
    // slice and cap it; if Baidu changes class names the title/link still survive.
    const boundary = headings[i + 1]?.at ?? Math.min(html.length, h.end + 1800);
    const snippet = strip(html.slice(h.end, boundary)).slice(0, 240);
    return { title: h.title, url: h.url, snippet };
  });
}

/** Parse Bing's stable server-rendered result list (`cn.bing.com` is reachable in the mainland network
 *  where overseas agent-search APIs commonly fail). */
export function parseBingSearchResults(html: string, limit: number): SearchResult[] {
  const strip = (s: string): string =>
    s
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&ensp;|&#8194;/gi, " ")
      .replace(/&emsp;|&#8195;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&#x27;/gi, "'")
      .replace(/\s+/g, " ")
      .trim();
  const out: SearchResult[] = [];
  const blockRe = /<li\b[^>]*class=(?:"[^"]*\bb_algo\b[^"]*"|'[^']*\bb_algo\b[^']*')[^>]*>([\s\S]*?)<\/li>/gi;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(html)) && out.length < limit) {
    const link = /<h2\b[^>]*>[\s\S]*?<a\b[^>]*href=(?:"([^"]+)"|'([^']+)')[^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h2>/i.exec(block[1]);
    if (!link) continue;
    const url = (link[1] ?? link[2] ?? "").replace(/&amp;/g, "&");
    const title = strip(link[3]);
    if (!title || !/^https?:\/\//i.test(url)) continue;
    const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block[1]);
    out.push({ title, url, snippet: strip(paragraph?.[1] ?? "").slice(0, 240) });
  }
  return out;
}

/** Best-effort parser for Google's classic HTML result shape. Google often serves a redirect/challenge
 *  shell in mainland environments, so this is a fallback, not the sole search path. */
export function parseGoogleSearchResults(html: string, limit: number): SearchResult[] {
  const strip = (s: string): string =>
    s
      .replace(/<[^>]+>/g, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&#x27;/gi, "'")
      .replace(/\s+/g, " ")
      .trim();
  const out: SearchResult[] = [];
  const linkRe = /<a\b[^>]*href=(?:"([^"]+)"|'([^']+)')[^>]*>[\s\S]{0,1600}?<h3\b[^>]*>([\s\S]*?)<\/h3>[\s\S]*?<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) && out.length < limit) {
    let url = (m[1] ?? m[2] ?? "").replace(/&amp;/g, "&");
    if (url.startsWith("/url?")) {
      try {
        url = new URL(url, "https://www.google.com").searchParams.get("q") ?? "";
      } catch {
        url = "";
      }
    }
    const title = strip(m[3]);
    if (!title || !/^https?:\/\//i.test(url) || /(?:^|\.)google\.[^/]+\//i.test(url)) continue;
    out.push({ title, url, snippet: "" });
  }
  return out;
}

/** Detect the common HTML shell returned by SPAs (root element + scripts/loading text, no readable body).
 *  web_fetch intentionally does not execute arbitrary page JavaScript, so surfacing the limitation is
 *  better than returning a misleading successful "(empty body)". */
export function looksLikeJsRenderedShell(html: string, readable: string): boolean {
  if (readable.trim().length >= 180) return false;
  const hasRoot = /<(?:div|main)\b[^>]*(?:id=["'](?:root|app|__next)["']|data-reactroot)/i.test(html);
  const scripts = (html.match(/<script\b/gi) ?? []).length;
  const shellText = /(?:enable javascript|javascript is required|loading[.…]*|正在加载|请启用\s*javascript)/i.test(readable || html);
  return (hasRoot && scripts > 0) || (scripts >= 2 && readable.trim().length < 40) || shellText;
}

async function searchFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(SEARCH_ATTEMPT_MS) });
}

async function firstSuccessfulSearch(
  attempts: { name: string; run: () => Promise<SearchResult[]> }[],
  failures: string[],
): Promise<SearchResult[] | null> {
  if (!attempts.length) return null;
  return new Promise((resolve) => {
    let remaining = attempts.length;
    let settled = false;
    for (const attempt of attempts) {
      void attempt
        .run()
        .then((results) => {
          if (results.length && !settled) {
            settled = true;
            resolve(results);
          } else if (!results.length) {
            failures.push(`${attempt.name} no results`);
          }
        })
        .catch((e: any) => {
          const reason = e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : (e?.message ?? String(e));
          failures.push(`${attempt.name} ${reason}`);
        })
        .finally(() => {
          remaining--;
          if (remaining === 0 && !settled) resolve(null);
        });
    }
  });
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
    const fmt = (rs: SearchResult[]): string =>
      rs.map((r, n) => `${n + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n\n");
    const failures: string[] = [];
    // Race the configured agent-search API against a mainland-accessible HTML source. A blocked Tavily
    // endpoint no longer adds an 8-second penalty before Hara starts the domestic fallback.
    const key = process.env.HARA_SEARCH_API_KEY || process.env.TAVILY_API_KEY;
    const primaryAttempts: { name: string; run: () => Promise<SearchResult[]> }[] = [];
    if (key) {
      primaryAttempts.push({
        name: "Tavily",
        run: async () => {
        const res = await searchFetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ api_key: key, query: q, max_results: limit }),
        });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const j = (await res.json()) as { results?: { title?: string; url?: string; content?: string }[] };
          return (j.results ?? []).map((x) => ({ title: String(x.title ?? x.url ?? ""), url: String(x.url ?? ""), snippet: String(x.content ?? "").slice(0, 200) }));
        },
      });
    }
    primaryAttempts.push({
      name: "Bing CN",
      run: async () => {
        const res = await searchFetch(`https://cn.bing.com/search?q=${encodeURIComponent(q)}&count=${limit}&setlang=zh-Hans`, {
          method: "GET",
          redirect: "follow",
          headers: { "user-agent": SEARCH_UA, accept: "text/html" },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parseBingSearchResults(await res.text(), limit);
      },
    });
    const primary = await firstSuccessfulSearch(primaryAttempts, failures);
    if (primary) return wrapUntrusted(fmt(primary), `web_search: ${q}`);

    // Secondary sources run concurrently, keeping total failure latency bounded. Google is included as a
    // user-friendly fallback where it is reachable, but is never the sole path (mainland often gets a shell).
    const secondary = await firstSuccessfulSearch(
      [
        {
          name: "Baidu",
          run: async () => {
            const res = await searchFetch(`https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=${limit}`, {
              method: "GET",
              redirect: "follow",
              headers: { "user-agent": SEARCH_UA, accept: "text/html" },
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return parseBaiduSearchResults(await res.text(), limit);
          },
        },
        {
          name: "Google",
          run: async () => {
            const res = await searchFetch(`https://www.google.com/search?q=${encodeURIComponent(q)}&num=${limit}&hl=zh-CN`, {
              method: "GET",
              redirect: "follow",
              headers: { "user-agent": SEARCH_UA, accept: "text/html" },
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return parseGoogleSearchResults(await res.text(), limit);
          },
        },
        {
          name: "DuckDuckGo",
          run: async () => {
            const res = await searchFetch("https://html.duckduckgo.com/html/", {
              method: "POST",
              redirect: "follow",
              headers: { "user-agent": SEARCH_UA, "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
              body: `q=${encodeURIComponent(q)}`,
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return parseSearchResults(await res.text(), limit);
          },
        },
      ],
      failures,
    );
    if (secondary) return wrapUntrusted(fmt(secondary), `web_search: ${q}`);
    return `Search failed across available providers (${failures.join("; ")}). Check connectivity/proxy, configure HARA_SEARCH_API_KEY, or web_fetch a known URL.`;
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
      if (/html/i.test(ct) && looksLikeJsRenderedShell(raw, text)) {
        const hint =
          "This page appears to be JavaScript-rendered; web_fetch received only the SPA shell and does not execute page scripts. " +
          "Use an available browser/web skill for the rendered page, or the site's authenticated API/connector (for example the Feishu Docs API).";
        return `# ${current.href} (HTTP ${res.status})\n\n${wrapUntrusted(`${text || "(empty shell)"}\n\n${hint}`, current.href)}`;
      }
      return `# ${current.href} (HTTP ${res.status})\n\n${wrapUntrusted(text || "(empty body)", current.href)}`;
    } catch (e: any) {
      return `Error fetching ${url.href}: ${e?.name === "AbortError" ? "timed out (30s)" : (e?.message ?? e)}`;
    } finally {
      clearTimeout(timer);
    }
  },
});
