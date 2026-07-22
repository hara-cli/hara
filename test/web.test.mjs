import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { htmlToText, parseSearchResults, parseBaiduSearchResults, parseBingSearchResults, parseGoogleSearchResults, looksLikeJsRenderedShell, isPrivateIp, resolvePublicHost, bypassesWebProxy, selectWebProxy, requestPinned } from "../dist/tools/web.js";
import { findHeadlessBrowser, renderHeadlessHtml } from "../dist/tools/headless-web.js";
import { getTool } from "../dist/tools/registry.js";
import "../dist/tools/web.js";

// Unit tests must not inherit a developer workstation's persisted/environment proxy. Dedicated cases below
// pass explicit proxy settings and exercise the real CONNECT path.
const inheritedNoProxy = process.env.no_proxy;
const inheritedUpperNoProxy = process.env.NO_PROXY;
process.env.no_proxy = "*";
after(() => {
  if (inheritedNoProxy === undefined) delete process.env.no_proxy;
  else process.env.no_proxy = inheritedNoProxy;
  if (inheritedUpperNoProxy === undefined) delete process.env.NO_PROXY;
  else process.env.NO_PROXY = inheritedUpperNoProxy;
});

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

test("web_search: parent cancellation aborts the active provider and never starts a fallback", async () => {
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.HARA_SEARCH_API_KEY;
  const calls = [];
  const controller = new AbortController();
  try {
    process.env.HARA_SEARCH_API_KEY = "test-key";
    globalThis.fetch = async (url, init) => {
      calls.push(String(url));
      return await new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      });
    };
    const running = getTool("web_search").run({ query: "private query", limit: 3 }, { cwd: ".", signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await assert.rejects(running, /interrupted by agent run deadline or cancellation/);
    assert.equal(calls.length, 1, "Bing/Baidu/Google/DDG are not started after the parent abort");
    assert.match(calls[0], /tavily/);
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

test("web_fetch classifies explicit headless rendering behind computer approval", () => {
  const tool = getTool("web_fetch");
  assert.deepEqual(tool.classify({ url: "https://example.com" }, { cwd: "." }), { effect: "read", concurrencySafe: true });
  assert.deepEqual(tool.classify({ url: "https://example.com", render: true }, { cwd: "." }), { effect: "computer", concurrencySafe: false });
});

test("isolated headless renderer launches the configured browser with a loopback validating proxy", { skip: process.platform === "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-headless-test-"));
  const browser = join(root, "fake-browser.mjs");
  writeFileSync(browser, `#!/usr/bin/env node
const proxyArg = process.argv.find((arg) => arg.startsWith("--proxy-server="));
if (!proxyArg || new URL(proxyArg.slice(15)).hostname !== "127.0.0.1") process.exit(2);
process.stdout.write("<!doctype html><html><body><main>Rendered SPA content</main></body></html>");
`);
  chmodSync(browser, 0o755);
  try {
    assert.equal(findHeadlessBrowser({ HARA_BROWSER_PATH: browser, PATH: process.env.PATH }, process.platform), browser);
    const target = new URL("https://public-render.example/spa");
    const result = await renderHeadlessHtml(
      target,
      async (url) => {
        assert.equal(url.hostname, "public-render.example");
        return { address: "127.0.0.1", family: 4 };
      },
      undefined,
      { ...process.env, HARA_BROWSER_PATH: browser },
    );
    assert.match(result.html ?? "", /Rendered SPA content/, JSON.stringify(result));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

test("web proxy selection supports config, standard env precedence, and NO_PROXY without logging credentials", () => {
  const target = new URL("https://docs.example.com/guide");
  assert.equal(bypassesWebProxy(target, "localhost,.example.com"), true);
  assert.equal(bypassesWebProxy(target, "example.net,docs.example.com:444"), false);
  assert.equal(selectWebProxy(target, "http://config-user:config-pass@127.0.0.1:7890", {
    HTTPS_PROXY: "http://env-user:env-pass@127.0.0.1:8899",
  }).source, "environment");
  assert.equal(selectWebProxy(target, "http://127.0.0.1:7890", { NO_PROXY: "*.example.com" }), undefined);
  assert.throws(
    () => selectWebProxy(target, undefined, { HTTPS_PROXY: "not-a-proxy secret-password" }),
    (error) => {
      assert.match(error.message, /proxy configuration is invalid/);
      assert.doesNotMatch(error.message, /secret-password/);
      return true;
    },
  );
});

test("requestPinned uses an authenticated CONNECT proxy while preserving the approved IP and original Host", async () => {
  let connectLine = "";
  let requestHead = "";
  const proxy = createServer((socket) => {
    let phase = "connect";
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString("latin1");
      const boundary = buffered.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const head = buffered.slice(0, boundary);
      buffered = buffered.slice(boundary + 4);
      if (phase === "connect") {
        connectLine = head.split("\r\n", 1)[0];
        phase = "request";
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        return;
      }
      requestHead = head;
      const body = "proxied-public-body";
      socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
    });
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const address = proxy.address();
  assert.ok(address && typeof address === "object");
  try {
    const response = await requestPinned(
      new URL("http://public.example/through-proxy?ok=1"),
      { address: "93.184.216.34", family: 4 },
      AbortSignal.timeout(5_000),
      { uri: `http://fake-user:fake-password@127.0.0.1:${address.port}`, source: "config" },
    );
    const chunks = [];
    for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
    await response.release();
    assert.equal(Buffer.concat(chunks).toString("utf8"), "proxied-public-body");
    assert.equal(connectLine, "CONNECT 93.184.216.34:80 HTTP/1.1", "the proxy receives the DNS-approved IP, not a hostname it can re-resolve");
    assert.match(requestHead, /^GET \/through-proxy\?ok=1 HTTP\/1\.1/m);
    assert.match(requestHead, /^host: public\.example$/im);
    assert.doesNotMatch(requestHead, /fake-password/);
  } finally {
    proxy.close();
    await once(proxy, "close");
  }
});

test("web_fetch: rejects invalid + non-http URLs (no network)", async () => {
  const invalid = await getTool("web_fetch").run({ url: "not a url secret-must-not-echo" }, { cwd: "." });
  assert.match(invalid, /invalid URL/);
  assert.doesNotMatch(invalid, /secret-must-not-echo/);
  assert.match(await getTool("web_fetch").run({ url: "file:///etc/passwd" }, { cwd: "." }), /only http/);
  assert.match(await getTool("web_fetch").run({ url: "ftp://example.com" }, { cwd: "." }), /only http/);
  assert.match(await getTool("web_fetch").run({ url: "https://user:password@example.com" }, { cwd: "." }), /credentials are not supported/);
});
