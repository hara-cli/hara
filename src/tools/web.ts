// web_fetch — fetch an http(s) URL and return readable text (HTML reduced to text). Read-only.
// NOT sandboxed (network egress is in-process, not via bash) — so it carries an SSRF guard: private/
// loopback/link-local targets are refused, the verified DNS address is pinned to the actual socket on
// every redirect hop (DNS-rebinding safe), and the body is read under a hard byte ceiling.
import { registerTool } from "./registry.js";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { wrapUntrusted } from "../security/external-content.js";

const MAX = 60_000;
const SEARCH_ATTEMPT_MS = 8_000;
const SEARCH_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
type SearchResult = { title: string; url: string; snippet: string };

function ipv6Words(input: string): number[] | null {
  let value = input.toLowerCase();
  const dotted = value.lastIndexOf(":") >= 0 ? value.slice(value.lastIndexOf(":") + 1) : "";
  if (dotted.includes(".")) {
    const octets = dotted.split(".").map(Number);
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    value = `${value.slice(0, value.lastIndexOf(":") + 1)}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const pieces = part.split(":");
    if (pieces.some((piece) => !/^[0-9a-f]{1,4}$/.test(piece))) return null;
    return pieces.map((piece) => Number.parseInt(piece, 16));
  };
  const left = parse(halves[0]);
  const right = parse(halves[1] ?? "");
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const zeros = 8 - left.length - right.length;
  return zeros > 0 ? [...left, ...Array<number>(zeros).fill(0), ...right] : null;
}

/** True for loopback / private / link-local / ULA / CGNAT addresses we must not let web_fetch reach. */
export function isPrivateIp(ip: string): boolean {
  const host = ip.replace(/^\[|\]$/g, "");
  if (isIP(host) === 4) {
    const p = host.split(".").map(Number);
    return (
      p[0] === 0 || p[0] === 10 || p[0] === 127 ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 0 && p[2] === 0 && p[3] !== 9 && p[3] !== 10) ||
      (p[0] === 192 && p[1] === 0 && p[2] === 2) ||
      (p[0] === 192 && p[1] === 88 && p[2] === 99) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19)) ||
      (p[0] === 198 && p[1] === 51 && p[2] === 100) ||
      (p[0] === 203 && p[1] === 0 && p[2] === 113) ||
      p[0] >= 224 // multicast + reserved/broadcast space is not a public unicast web destination
    );
  }
  const l = host.toLowerCase();
  const words = ipv6Words(l);
  if (!words) return false;
  if (words.every((word) => word === 0) || words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
  if ((words[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local (fe80..febf)
  if ((words[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((words[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 deprecated site-local, still internal
  // IPv4-mapped/compatible spellings are normalized by URL to hexadecimal (for example
  // ::ffff:127.0.0.1 → ::ffff:7f00:1), so classify the embedded address from parsed words.
  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  const compatible = words.slice(0, 6).every((word) => word === 0);
  if (mapped || compatible) {
    const v4 = `${words[6] >>> 8}.${words[6] & 0xff}.${words[7] >>> 8}.${words[7] & 0xff}`;
    return isPrivateIp(v4);
  }
  // Native public IPv6 is global-unicast 2000::/3. Also reject special-use ranges that sit inside it:
  // Teredo, benchmarking/ORCHID/documentation, and deprecated 6to4 transition addresses.
  if ((words[0] & 0xe000) !== 0x2000) return true;
  if (words[0] === 0x2002) return true; // 6to4 can tunnel an embedded non-public IPv4 target
  if (words[0] === 0x2001) {
    if (words[1] === 0x0000 || words[1] === 0x0002 || words[1] === 0x0db8) return true;
    if ((words[1] & 0xfff0) === 0x0010 || (words[1] & 0xfff0) === 0x0020) return true;
  }
  return words[0] === 0x3fff && (words[1] & 0xf000) === 0x0000; // 3fff::/20 documentation
}

/** Refuse to fetch a host that is (or resolves to) a private/internal address — defeats metadata-endpoint
 *  / localhost SSRF. Throws (caught by the caller) on a blocked or unresolvable host. */
export interface PinnedHost {
  address: string;
  family: 4 | 6;
}

/** Resolve once, reject the hostname if ANY answer is internal, then return the exact public address the
 * socket must use. Rejecting mixed public/private answers prevents round-robin records from becoming a
 * probabilistic bypass. The optional resolver keeps the policy directly testable. */
export async function resolvePublicHost(
  hostname: string,
  resolver: typeof lookup = lookup,
): Promise<PinnedHost> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`refusing to fetch ${host} (private/loopback address)`);
    return { address: host, family: isIP(host) as 4 | 6 };
  }
  const addrs = await resolver(host, { all: true });
  if (!addrs.length) throw new Error(`could not resolve ${host}`);
  for (const a of addrs) {
    const family = isIP(a.address);
    if (!family || family !== a.family) throw new Error(`resolver returned an invalid address for ${host}`);
    if (isPrivateIp(a.address)) throw new Error(`refusing to fetch ${host} — resolves to a private/internal address (${a.address})`);
  }
  const chosen = addrs[0];
  return { address: chosen.address, family: chosen.family as 4 | 6 };
}

interface PinnedResponse {
  status: number;
  headers: Headers;
  body: IncomingMessage;
}

/** One HTTP hop whose TCP socket is pinned to the address approved above. `Host` and TLS SNI retain the
 * original hostname, so virtual hosting/certificate checks work without a second DNS lookup. */
async function requestPinned(url: URL, pinned: PinnedHost, signal: AbortSignal): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(
      {
        protocol: url.protocol,
        hostname: pinned.address,
        family: pinned.family,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        signal,
        servername: url.hostname.replace(/^\[|\]$/g, ""),
        headers: {
          host: url.host,
          "user-agent": "hara-cli",
          accept: "text/html,text/plain,application/json,*/*",
        },
      },
      (body) => {
        const headers = new Headers();
        for (let i = 0; i < body.rawHeaders.length; i += 2) headers.append(body.rawHeaders[i], body.rawHeaders[i + 1]);
        resolve({ status: body.statusCode ?? 0, headers, body });
      },
    );
    request.once("error", reject);
    request.end();
  });
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

async function readPinnedCapped(res: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of res) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const remaining = maxBytes - total;
    if (remaining <= 0) {
      res.destroy();
      break;
    }
    chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk);
    total += Math.min(chunk.length, remaining);
    if (chunk.length >= remaining) {
      res.destroy();
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

function interrupted(label: string): Error {
  const error = new Error(`${label} interrupted by agent run deadline or cancellation`);
  error.name = "AbortError";
  return error;
}

async function searchFetch(url: string, init: RequestInit, parentSignal?: AbortSignal): Promise<Response> {
  if (parentSignal?.aborted) throw interrupted("web search");
  const attemptSignal = AbortSignal.timeout(SEARCH_ATTEMPT_MS);
  const signal = parentSignal ? AbortSignal.any([parentSignal, attemptSignal]) : attemptSignal;
  return fetch(url, { ...init, signal });
}

async function firstSuccessfulSearch(
  attempts: { name: string; run: () => Promise<SearchResult[]> }[],
  failures: string[],
  signal?: AbortSignal,
): Promise<SearchResult[] | null> {
  // Try one provider at a time. Search terms can be sensitive; a successful request must not be mirrored
  // to unrelated providers merely to save a few seconds, and sequential fallback also avoids leaving
  // losing requests running after the tool has already returned.
  for (const attempt of attempts) {
    if (signal?.aborted) throw interrupted("web search");
    try {
      const results = await attempt.run();
      if (signal?.aborted) throw interrupted("web search");
      if (results.length) return results;
      failures.push(`${attempt.name} no results`);
    } catch (e: any) {
      if (signal?.aborted) throw interrupted("web search");
      const reason = e?.name === "TimeoutError" || e?.name === "AbortError" ? "timeout" : (e?.message ?? String(e));
      failures.push(`${attempt.name} ${reason}`);
    }
  }
  return null;
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
  concurrencySafe: true,
  visibility: "deferred",
  async run(input, ctx) {
    if (ctx.signal?.aborted) throw interrupted("web search");
    const q = String(input.query ?? "").trim();
    if (!q) return "(empty query)";
    const limit = Math.min(Math.max(1, Number(input.limit) || 6), 10);
    const fmt = (rs: SearchResult[]): string =>
      rs.map((r, n) => `${n + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n\n");
    const failures: string[] = [];
    // Prefer the explicitly configured agent-search API. Only disclose the query to another provider if
    // that request fails or returns no results; without a key, start with mainland-accessible Bing CN.
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
        }, ctx.signal);
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
        }, ctx.signal);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return parseBingSearchResults(await res.text(), limit);
      },
    });
    const primary = await firstSuccessfulSearch(primaryAttempts, failures, ctx.signal);
    if (primary) return wrapUntrusted(fmt(primary), `web_search: ${q}`);

    // Secondary sources are ordered fallbacks. Google is included where reachable, but is never the sole
    // path because mainland networks commonly receive a challenge or JavaScript shell.
    const secondary = await firstSuccessfulSearch(
      [
        {
          name: "Baidu",
          run: async () => {
            const res = await searchFetch(`https://www.baidu.com/s?wd=${encodeURIComponent(q)}&rn=${limit}`, {
              method: "GET",
              redirect: "follow",
              headers: { "user-agent": SEARCH_UA, accept: "text/html" },
            }, ctx.signal);
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
            }, ctx.signal);
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
            }, ctx.signal);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return parseSearchResults(await res.text(), limit);
          },
        },
      ],
      failures,
      ctx.signal,
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
  concurrencySafe: true,
  visibility: "deferred",
  async run(input, ctx) {
    if (ctx.signal?.aborted) throw interrupted("web fetch");
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
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, ctrl.signal]) : ctrl.signal;
    try {
      // Follow redirects manually so the SSRF guard runs on EVERY hop (a public URL can 30x to 169.254…).
      let current = url;
      let res: PinnedResponse;
      for (let hop = 0; ; hop++) {
        if (ctx.signal?.aborted) throw interrupted("web fetch");
        const pinned = await resolvePublicHost(current.hostname);
        if (ctx.signal?.aborted) throw interrupted("web fetch");
        res = await requestPinned(current, pinned, signal);
        const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
        if (!loc || hop >= 5) break;
        const next = new URL(loc, current);
        if (next.protocol !== "http:" && next.protocol !== "https:") {
          res.body.destroy();
          return "Error: redirect to a non-http(s) URL was blocked.";
        }
        // We never consume redirect bodies. Destroy the socket before following the next pinned hop so a
        // server cannot accumulate idle response streams across a redirect chain.
        res.body.destroy();
        if (ctx.signal?.aborted) throw interrupted("web fetch");
        current = next;
      }
      const ct = res.headers.get("content-type") ?? "";
      const raw = await readPinnedCapped(res.body, cap * 4); // byte ceiling (HTML→text shrinks; cap*4 leaves headroom)
      if (ctx.signal?.aborted) throw interrupted("web fetch");
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
      if (ctx.signal?.aborted) throw interrupted("web fetch");
      return `Error fetching ${url.href}: ${e?.name === "AbortError" ? "timed out (30s)" : (e?.message ?? e)}`;
    } finally {
      clearTimeout(timer);
    }
  },
});
