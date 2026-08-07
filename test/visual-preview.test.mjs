import test from "node:test";
import assert from "node:assert/strict";
import {
  localPreviewUrl,
} from "../dist/tools/visual-preview.js";
import { getTool } from "../dist/tools/registry.js";

test("visual preview accepts only explicit loopback HTTP ports", () => {
  for (const url of [
    "http://localhost:5173/",
    "http://127.0.0.1:3000/app",
    "http://[::1]:4173/preview",
  ]) {
    assert.equal(localPreviewUrl(url)?.toString(), url);
  }
  for (const url of [
    "https://localhost:5173/",
    "http://localhost/",
    "http://example.com:5173/",
    "http://user:password@127.0.0.1:5173/",
    "file:///tmp/index.html",
    "javascript:alert(1)",
  ]) {
    assert.equal(localPreviewUrl(url), null, `${url} must not become a Desktop WebView`);
  }
});

test("visual preview offers an owner-bound browser surface without echoing URL secrets", async () => {
  const tool = getTool("visual_preview");
  assert.ok(tool);
  assert.equal(tool.requiresProjectWorkspace, true);
  const surfaces = [];
  const output = await tool.run({
    url: "http://127.0.0.1:5173/workbench?ephemeral=do-not-echo#slide",
    title: "  Product\npreview  ",
  }, {
    cwd: process.cwd(),
    sessionId: "preview-session",
    ui: {
      text() {}, reasoning() {}, tool() {}, diff() {}, notice() {},
      surface(value) { surfaces.push(value); },
    },
  });
  const result = JSON.parse(output);
  assert.deepEqual(result, {
    openedInDesktop: true,
    origin: "http://127.0.0.1:5173",
    title: "Product preview",
    next: "Keep the Hara background job running for live reload; stop it with the job tool when the preview is no longer needed. The Visual Dock tab is bound to this project session.",
  });
  assert.equal(output.includes("do-not-echo"), false);
  assert.deepEqual(surfaces, [{
    kind: "browser",
    title: "Product preview",
    resource: {
      type: "url",
      url: "http://127.0.0.1:5173/workbench?ephemeral=do-not-echo#slide",
    },
  }]);
});
