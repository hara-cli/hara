import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText } from "../dist/tools/web.js";
import { getTool } from "../dist/tools/registry.js";
import "../dist/tools/web.js";

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
