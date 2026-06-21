import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText, parseSearchResults } from "../dist/tools/web.js";
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

test("web_fetch: rejects invalid + non-http URLs (no network)", async () => {
  assert.match(await getTool("web_fetch").run({ url: "not a url" }, { cwd: "." }), /invalid URL/);
  assert.match(await getTool("web_fetch").run({ url: "file:///etc/passwd" }, { cwd: "." }), /only http/);
  assert.match(await getTool("web_fetch").run({ url: "ftp://example.com" }, { cwd: "." }), /only http/);
});
