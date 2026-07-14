import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { selfArgvFor } from "../dist/cron/runner.js";

const bunProbe = spawnSync("bun", ["--version"], { encoding: "utf8" });

test("selfArgvFor keeps script entries for Node and plain Bun, but not Bun compiled virtual entries", () => {
  assert.deepEqual(
    selfArgvFor("/usr/local/bin/node", "/usr/local/bin/hara", { node: "22.22.3" }),
    ["/usr/local/bin/node", "/usr/local/bin/hara"],
    "an extensionless npm bin entry is still a Node script entry",
  );
  assert.deepEqual(
    selfArgvFor("/usr/local/bin/bun", "/workspace/hara/dist/index.js", { bun: "1.2.20" }),
    ["/usr/local/bin/bun", "/workspace/hara/dist/index.js"],
    "plain `bun dist/index.js` must preserve the script before resume/cron flags",
  );
  assert.deepEqual(
    selfArgvFor("/usr/local/bin/hara", "/$bunfs/root/hara/dist/index.js", { bun: "1.2.20" }),
    ["/usr/local/bin/hara"],
    "a Bun-compiled binary re-enters itself without exposing its virtual bundled entry",
  );
  assert.deepEqual(
    selfArgvFor("C:\\hara.exe", "\\$bunfs\\root\\hara\\dist\\index.js", { bun: "1.2.20" }),
    ["C:\\hara.exe"],
    "the Bun virtual-entry discriminator is separator-neutral",
  );
});

test("selfInvocation under a plain Bun script retains the script entry", { skip: bunProbe.status !== 0 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-self-bun-"));
  const fixture = join(dir, "bun-entry.mjs");
  const runnerUrl = pathToFileURL(join(process.cwd(), "dist", "cron", "runner.js")).href;
  writeFileSync(fixture, `
import { selfInvocation } from ${JSON.stringify(runnerUrl)};
process.stdout.write(JSON.stringify(selfInvocation(["--resume", "bun-smoke"])));
`);
  try {
    const run = spawnSync("bun", [fixture], { cwd: dir, encoding: "utf8", timeout: 5_000 });
    assert.equal(run.status, 0, run.stderr);
    const invocation = JSON.parse(run.stdout);
    assert.equal(realpathSync.native(invocation.args[0]), realpathSync.native(fixture));
    assert.deepEqual(invocation.args.slice(1), ["--resume", "bun-smoke"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runSelfAttached re-enters the Node CLI asynchronously with inherited stdin/stdout", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-self-invoke-"));
  const fixture = join(dir, "self-entry.mjs");
  const runnerUrl = pathToFileURL(join(process.cwd(), "dist", "cron", "runner.js")).href;
  writeFileSync(fixture, `
import { runSelfAttached } from ${JSON.stringify(runnerUrl)};
if (process.argv[2] === "--attached-child") {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write("child:" + process.argv[3] + ":" + input + "\\n");
} else {
  const result = await runSelfAttached(["--attached-child", "resume-smoke"]);
  process.stdout.write("parent:" + String(result.code) + ":" + String(result.signal) + "\\n");
}
`);
  try {
    const run = spawnSync(process.execPath, [fixture], {
      cwd: dir,
      input: "typed-input",
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /child:resume-smoke:typed-input/, "the resumed child can read inherited input");
    assert.match(run.stdout, /parent:0:null/, "the launcher remains responsive until the child exits");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
