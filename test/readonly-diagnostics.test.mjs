import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../dist/tools/builtin.js";
import { getTool } from "../dist/tools/registry.js";

test("the real bash tool classifies and executes the reported literal read-only compound", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "hara-readonly-diagnostic-"));
  try {
    writeFileSync(join(cwd, "package.json"), "{}");
    writeFileSync(join(cwd, "AGENTS.md"), "## Boundary\nread only\n");
    writeFileSync(join(cwd, "CLAUDE.md"), "## Notes\nfixture\n");
    const command = `cd '${cwd}' && wc -l AGENTS.md CLAUDE.md && echo '=== 章节 ===' && grep -n '^#\\{2,3\\} ' AGENTS.md`;
    const bash = getTool("bash");
    assert.deepEqual(bash.classify({ command }), { effect: "read", concurrencySafe: true });
    assert.equal(bash.classify({ command, background: true }).effect, "exec");
    const result = await bash.run({ command }, { cwd, sandbox: "off" });
    assert.match(result, /=== 章节 ===/);
    assert.match(result, /1:## Boundary/);
    assert.doesNotMatch(result, /Blocked:|Error:/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
