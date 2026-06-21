import { test } from "node:test";
import assert from "node:assert/strict";
import { completionScript } from "../dist/completions.js";

const tree = { top: ["cron", "memory", "doctor"], subs: { cron: ["add", "list", "tick"], memory: ["show", "distill"] } };

test("completionScript: bash completes top-level + group subcommands", () => {
  const s = completionScript("bash", tree);
  assert.match(s, /complete -F _hara hara/);
  assert.match(s, /compgen -W "cron memory doctor"/);
  assert.match(s, /cron\) COMPREPLY=\( \$\(compgen -W "add list tick"/);
});

test("completionScript: zsh completes top-level + group subcommands", () => {
  const s = completionScript("zsh", tree);
  assert.match(s, /compdef _hara hara/);
  assert.match(s, /compadd -- cron memory doctor/);
  assert.match(s, /memory\) compadd -- show distill/);
});

test("completionScript: fish completes top-level + group subcommands", () => {
  const s = completionScript("fish", tree);
  assert.match(s, /__fish_use_subcommand -a "cron memory doctor"/);
  assert.match(s, /__fish_seen_subcommand_from cron" -a "add list tick"/);
});

test("completionScript: unsupported shell → null", () => {
  assert.equal(completionScript("powershell", tree), null);
  assert.equal(completionScript("", tree), null);
});
