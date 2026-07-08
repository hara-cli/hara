// Dropped/pasted file paths must NOT be mistaken for slash commands. A file dragged into the prompt
// pastes as `/Users/…/doc.md` — it starts with '/' but is a file to read, not a command. Pins the
// command-vs-path disambiguation and the leading-path → @-mention rewrite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isSlashCommand, inlineLeadingPath } from "../dist/context/mentions.js";

test("isSlashCommand: real commands (no embedded slash in the name) are commands", () => {
  assert.equal(isSlashCommand("/help"), true);
  assert.equal(isSlashCommand("/compact"), true);
  assert.equal(isSlashCommand("/design a landing page"), true, "command + args");
  assert.equal(isSlashCommand("/model glm-5"), true);
  assert.equal(isSlashCommand("/"), true, "bare slash → still command-parsed (→ Unknown), unchanged");
});

test("isSlashCommand: a dropped file path is NOT a command (embedded slash in first token)", () => {
  assert.equal(isSlashCommand("/Users/zhaodongqin/Downloads/bugua_yimatrix_codex_design_spec.md"), false);
  assert.equal(isSlashCommand("/Users/x/Downloads/spec.md [Image #1] 给你两张图参考"), false, "path + trailing text/images");
  assert.equal(isSlashCommand("/tmp/a.txt"), false);
  assert.equal(isSlashCommand("/etc/hosts"), false);
});

test("isSlashCommand: non-slash lines are never commands", () => {
  assert.equal(isSlashCommand("hello"), false);
  assert.equal(isSlashCommand("read @src/index.ts"), false);
  assert.equal(isSlashCommand(""), false);
});

test("inlineLeadingPath: an existing leading absolute path becomes an @-mention (rest preserved)", () => {
  const exists = (p) => p === "/Users/x/Downloads/spec.md";
  assert.equal(
    inlineLeadingPath("/Users/x/Downloads/spec.md [Image #1] 看这个", exists),
    "@/Users/x/Downloads/spec.md [Image #1] 看这个",
    "leading path → @path so expandMentions inlines it; trailing text/images untouched",
  );
  assert.equal(inlineLeadingPath("/Users/x/Downloads/spec.md", exists), "@/Users/x/Downloads/spec.md", "bare path");
});

test("inlineLeadingPath: leaves non-existent paths and non-path lines alone", () => {
  const none = () => false;
  assert.equal(inlineLeadingPath("/Users/x/typo.md", none), "/Users/x/typo.md", "non-existent → unchanged (model sees text)");
  assert.equal(inlineLeadingPath("just a message", () => true), "just a message", "no leading slash → unchanged");
  assert.equal(inlineLeadingPath("@already/a/mention.ts", () => true), "@already/a/mention.ts", "already an @-mention → unchanged");
});
