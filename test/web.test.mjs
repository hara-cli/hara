import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText, parseSearchResults, isPrivateIp } from "../dist/tools/web.js";
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
  for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fc00::1", "fd12::3456", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
    assert.equal(isPrivateIp(ip), true, `${ip} should be blocked`);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "192.169.0.1", "100.63.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateIp(ip), false, `${ip} should be allowed`);
  }
});

test("web_fetch: rejects invalid + non-http URLs (no network)", async () => {
  assert.match(await getTool("web_fetch").run({ url: "not a url" }, { cwd: "." }), /invalid URL/);
  assert.match(await getTool("web_fetch").run({ url: "file:///etc/passwd" }, { cwd: "." }), /only http/);
  assert.match(await getTool("web_fetch").run({ url: "ftp://example.com" }, { cwd: "." }), /only http/);
});
