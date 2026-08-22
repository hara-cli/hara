import test from "node:test";
import assert from "node:assert/strict";
import {
  agentIdentityFromMetadata,
  parseAgentIdentityMarkdown,
} from "../dist/org/agent-identity.js";

test("OpenClaw and Hermes-style public identity fields map without exposing persona text", () => {
  const metadata = parseAgentIdentityMarkdown([
    "# IDENTITY.md",
    "",
    "- **Name:** Linus",
    "- **Role:** 首席工程师",
    "- **Vibe:** 技术至上、直言不讳",
    "- **Emoji:** 🐧",
    "- **Avatar:** https://tracker.example/avatar.png",
  ].join("\n"));
  metadata["identity-source"] = "openclaw";
  metadata.traits = ["直率", "工程", "验证优先"];
  metadata.accent = "#3A8FC2";
  metadata.character = "engineer";
  const identity = agentIdentityFromMetadata(metadata, "dev", "private fallback", "global");
  assert.deepEqual(identity, {
    version: 1,
    displayName: "Linus",
    title: "首席工程师",
    bio: "技术至上、直言不讳",
    traits: ["直率", "工程", "验证优先"],
    emoji: "🐧",
    accent: "#3a8fc2",
    character: "engineer",
    source: "openclaw",
  });
  assert.equal("system" in identity, false);
  assert.equal(identity.avatar, undefined, "remote role images never become implicit tracking requests");
});

test("identity fields are bounded and packaged avatars remain renderable", () => {
  const identity = agentIdentityFromMetadata({
    "display-name": "A".repeat(100),
    title: "Designer",
    bio: "Calm and precise",
    traits: "calm, precise, calm, curious",
    emoji: "🎨",
    avatar: "/avatars/designer.webp",
    accent: "#FF695F",
    sprite: "editorial-designer",
  }, "uiux", "", "project");
  assert.equal(identity.displayName.length, 64);
  assert.deepEqual(identity.traits, ["calm", "precise", "curious"]);
  assert.equal(identity.avatar, "/avatars/designer.webp");
  assert.equal(identity.accent, "#ff695f");
  assert.equal(identity.character, "editorial-designer");
  assert.equal(identity.source, "hara");
});
