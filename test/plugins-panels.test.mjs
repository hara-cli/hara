// Project-panel detection (the desktop's chat ↔ live-preview split): a plugin panel surfaces on a
// project iff any of its manifest `detect` markers exists under the project cwd; panels without
// `detect` stay global-only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchPanels } from "../dist/plugins/plugins.js";

test("matchPanels: detect markers gate project panels", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-panels-"));
  try {
    mkdirSync(join(dir, ".hara", "design", "hero"), { recursive: true });
    const plugins = [
      { name: "design", version: "1", root: "/x", manifest: { panels: [{ id: "p", title: "Design", command: "hara-design", detect: [".hara/design"] }] } },
      { name: "video", version: "1", root: "/x", manifest: { panels: [{ id: "v", title: "Video", command: "hara-video", detect: ["remotion.config.ts"] }] } },
      { name: "global", version: "1", root: "/x", manifest: { panels: [{ id: "g", title: "G", command: "g" }] } },
    ];
    assert.deepEqual(matchPanels(plugins, dir).map((h) => h.panel.id), ["p"], "design marker matched, video/global not");
    writeFileSync(join(dir, "remotion.config.ts"), "export default {}");
    assert.deepEqual(
      matchPanels(plugins, dir).map((h) => h.panel.id).sort(),
      ["p", "v"],
      "video joins once its marker appears; detect-less panel never does",
    );
    assert.deepEqual(matchPanels(plugins, join(dir, "nope")), [], "unknown cwd → nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
