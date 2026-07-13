import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText, parseSearchResults, parseBaiduSearchResults, parseBingSearchResults, parseGoogleSearchResults, looksLikeJsRenderedShell, isPrivateIp, resolvePublicHost } from "../dist/tools/web.js";
import { getTool } from "../dist/tools/registry.js";
import "../dist/tools/web.js";

test("parseSearchResults: title/url/snippet + decodes the DuckDuckGo uddg redirect", () => {
  const html = `
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=z">First <b>Result</b></a>
    <a class="result__snippet" href="x">A useful <b>snippet</b>.</a>
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffoo.org%2Fb">Second</a>
    <a class="result__snippet" href="y">Another snippet.</a>`;
  const r = parseSearchResults(html, 10);
  assert.equal(r.length, 2);
  assert.equal(r[0].title, "First Result");
  assert.equal(r[0].url, "https://example.com/a", "uddg redirect decoded to the real URL");
  assert.equal(r[0].snippet, "A useful snippet.");
  assert.equal(r[1].url, "https://foo.org/b");
});

test("parseSearchResults: respects the limit + empty on no matches", () => {
  assert.deepEqual(parseSearchResults("<html>nothing here</html>", 5), []);
  const many = Array.from({ length: 10 }, (_, i) => `<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fx${i}.com">R${i}</a>`).join("");
  assert.equal(parseSearchResults(many, 3).length, 3);
});

test("parseBaiduSearchResults: server-rendered headings + snippets", () => {
  const html = `
    <div class="result c-container"><h3 class="t"><a href="https://www.baidu.com/link?url=abc">Hara <em>CLI</em></a></h3><div class="c-abstract">A coding agent for teams.</div></div>
    <div class="result c-container"><h3 class="t"><a href='https://example.com/two'>Second result</a></h3><div class="c-abstract">More text.</div></div>`;
  const r = parseBaiduSearchResults(html, 5);
  assert.equal(r.length, 2);
  assert.equal(r[0].title, "Hara CLI");
  assert.equal(r[0].url, "https://www.baidu.com/link?url=abc");
  assert.match(r[0].snippet, /coding agent/);
});

test("parseBingSearchResults: server-rendered b_algo blocks", () => {
  const html = `<ol><li class="b_algo"><h2><a href="https://example.com/hara">Hara <strong>CLI</strong></a></h2><div class="b_caption"><p>A mainland-accessible result.</p></div></li></ol>`;
  assert.deepEqual(parseBingSearchResults(html, 3), [
    { title: "Hara CLI", url: "https://example.com/hara", snippet: "A mainland-accessible result." },
  ]);
});

test("parseGoogleSearchResults: classic h3 links and /url redirects", () => {
  const html = `<a href="/url?q=https%3A%2F%2Fexample.com%2Fone&sa=U"><h3>First result</h3></a><a href="https://two.example/page"><span><h3>Second</h3></span></a>`;
  assert.deepEqual(parseGoogleSearchResults(html, 3), [
    { title: "First result", url: "https://example.com/one", snippet: "" },
    { title: "Second", url: "https://two.example/page", snippet: "" },
  ]);
});

test("web_search: Tavily connection failure falls back to Bing CN", async () => {
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.HARA_SEARCH_API_KEY;
  const calls = [];
  try {
    process.env.HARA_SEARCH_API_KEY = "test-key";
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes("tavily")) throw new Error("fetch failed");
      if (String(url).includes("cn.bing.com")) {
        return new Response('<li class="b_algo"><h2><a href="https://example.com/result">Domestic result</a></h2><p>Useful snippet</p></li>', { status: 200, headers: { "content-type": "text/html" } });
      }
      throw new Error("unexpected provider");
    };
    const out = await getTool("web_search").run({ query: "hara", limit: 3 }, { cwd: "." });
    assert.match(out, /Domestic result/);
    assert.deepEqual(new Set(calls.map((u) => new URL(u).host)), new Set(["api.tavily.com", "cn.bing.com"]));
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.HARA_SEARCH_API_KEY;
    else process.env.HARA_SEARCH_API_KEY = savedKey;
  }
});

test("web_search: a successful configured provider does not broadcast the query", async () => {
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.HARA_SEARCH_API_KEY;
  const calls = [];
  try {
    process.env.HARA_SEARCH_API_KEY = "test-key";
    globalThis.fetch = async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ results: [{ title: "Private result", url: "https://example.com", content: "one source" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const out = await getTool("web_search").run({ query: "sensitive internal phrase", limit: 3 }, { cwd: "." });
    assert.match(out, /Private result/);
    assert.deepEqual(calls.map((u) => new URL(u).host), ["api.tavily.com"]);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.HARA_SEARCH_API_KEY;
    else process.env.HARA_SEARCH_API_KEY = savedKey;
  }
});

test("looksLikeJsRenderedShell: catches an empty SPA shell, not real article text", () => {
  assert.equal(looksLikeJsRenderedShell('<div id="root"></div><script src="app.js"></script>', ""), true);
  assert.equal(looksLikeJsRenderedShell('<main id="app"></main><script>boot()</script>', "Loading…"), true);
  assert.equal(looksLikeJsRenderedShell(`<article>${"readable ".repeat(40)}</article>`, "readable ".repeat(40)), false);
});

test("htmlToText: strips tags/scripts, decodes entities, keeps list structure", () => {
  const t = htmlToText(
    "<h1>Title</h1><p>Hello &amp; <b>world</b></p><script>bad()</script><ul><li>a</li><li>b</li></ul>",
  );
  assert.match(t, /Title/);
  assert.match(t, /Hello & world/);
  assert.ok(!t.includes("bad()")); // <script> removed
  assert.match(t, /- a/);
  assert.match(t, /- b/);
});

test("isPrivateIp: blocks loopback/private/link-local/CGNAT, allows public (SSRF guard)", () => {
  for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "255.255.255.255", "::1", "fe80::1", "fe90::1", "febf::1", "fc00::1", "fd12::3456", "ff02::1", "2001:db8::1", "2002:7f00:1::", "3fff::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::a00:1", "::7f00:1"]) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be blocked`);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "100.63.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateIp(ip), false, `${ip} should be allowed`);
  }
});

test("resolvePublicHost rejects mixed DNS answers and returns the exact address to pin", async () => {
  const mixed = async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }];
  await assert.rejects(resolvePublicHost("rebind.example", mixed), /private\/internal/);
  const publicOnly = async () => [{ address: "93.184.216.34", family: 4 }];
  assert.deepEqual(await resolvePublicHost("stable.example", publicOnly), { address: "93.184.216.34", family: 4 });
  assert.equal(isPrivateIp("fec0::1"), true, "deprecated site-local IPv6 remains internal");
});

test("web_fetch: rejects invalid + non-http URLs (no network)", async () => {
  assert.match(await getTool("web_fetch").run({ url: "not a url" }, { cwd: "." }), /invalid URL/);
  assert.match(await getTool("web_fetch").run({ url: "file:///etc/passwd" }, { cwd: "." }), /only http/);
  assert.match(await getTool("web_fetch").run({ url: "ftp://example.com" }, { cwd: "." }), /only http/);
});
