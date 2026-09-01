#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { HaraRuntimeAdapter } from "../dist/external-sessions/runtime.js";
import { runExternalCommandCapture } from "../dist/external-sessions/process.js";

const command = resolve(process.env.HARA_HERDR_PATH || process.argv[2] || "herdr");
const cwd = resolve(process.argv[3] || process.cwd());
const agentKind = process.argv[4] === "claude" ? "claude" : "codex";
const sessionName = `hara-smoke-${process.pid}`;
const scratch = mkdtempSync(`${tmpdir()}/hara-live-smoke-`);
const runtimeConfigRoot = process.platform === "win32" ? scratch : `/tmp/hs-${process.pid}`;
mkdirSync(runtimeConfigRoot, { recursive: true, mode: 0o700 });
const runtimeEnv = { ...process.env, XDG_CONFIG_HOME: runtimeConfigRoot, XDG_STATE_HOME: runtimeConfigRoot };

const stopSession = () => {
  for (const action of ["stop", "delete"]) {
    try {
      execFileSync(command, ["session", action, sessionName], {
        stdio: "ignore",
        timeout: 15_000,
        env: runtimeEnv,
      });
    } catch {
      // Cleanup is best effort; the named QA session remains independently inspectable on failure.
    }
  }
};

try {
  const adapter = new HaraRuntimeAdapter({
    command,
    identityKey: Buffer.alloc(32, 71),
    identityHome: scratch,
    runtimeRoot: tmpdir(),
    sessionName,
    env: runtimeEnv,
  });
  const source = await adapter.inspect();
  if (source.state !== "ready") throw new Error(`Herdr runtime is ${source.state}`);
  let created;
  try {
    created = await adapter.create({ cwd, agentKind, title: "Hara Live QA" });
  } catch (error) {
    const status = await runExternalCommandCapture({
      command,
      argsPrefix: ["--session", sessionName],
      env: runtimeEnv,
    }, ["agent", "list"], { timeoutMs: 5_000 });
    throw new Error(`${error.message} (post-start status: ${status.errorCode || (status.ok ? "ready" : "unknown")})`);
  }
  if (created.readOnly || created.controlMode !== "live") throw new Error("created relay is not writable live mode");
  const marker = `HARA_LIVE_${agentKind.toUpperCase()}_OK`;
  const turn = await adapter.submit(
    created.session.id,
    `Reply with exactly ${marker}. Do not call tools and do not add any other text.`,
    { text() {}, tool() {}, notice() {}, confirm: async () => false },
  );
  if (turn.status !== "completed" || !turn.reply.includes(marker)) {
    const fullDetail = String([turn.error, turn.reply].filter(Boolean).join(" · ") || "no bounded runtime detail")
      .replace(/[\r\n\t]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    const detail = fullDetail.length > 1_300
      ? `${fullDetail.slice(0, 500)} … ${fullDetail.slice(-800)}`
      : fullDetail;
    throw new Error(`live relay did not return the expected marker (status ${turn.status}; ${detail})`);
  }
  console.log(`✓ Hara Live ${agentKind} relay created, messaged, observed, and verified`);
} finally {
  stopSession();
  rmSync(scratch, { recursive: true, force: true });
  if (runtimeConfigRoot !== scratch) rmSync(runtimeConfigRoot, { recursive: true, force: true });
}
