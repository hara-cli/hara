#!/usr/bin/env node
// Start the real native standalone, require its authenticated discovery record, then stop it through
// server.shutdown. The Windows lane exists specifically to catch unsupported native-handle operations
// (for example POSIX fchmod) that portable unit tests can only simulate.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import WebSocket from "ws";

const [binaryArg, expectedVersion] = process.argv.slice(2);
if (!binaryArg || !expectedVersion) {
  console.error("usage: node scripts/standalone-serve-smoke.mjs <native-binary> <expected-version>");
  process.exit(2);
}

const binary = isAbsolute(binaryArg) ? binaryArg : resolve(binaryArg);
if (!existsSync(binary)) {
  console.error(`standalone serve smoke: binary not found: ${binary}`);
  process.exit(2);
}

const reservePort = () => new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    server.close((error) => error ? reject(error) : resolvePort(port));
  });
});

const waitFor = async (condition, timeoutMs, message) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(message);
};

const call = (ws, id, method, params) => new Promise((resolveCall, reject) => {
  const timeout = setTimeout(() => reject(new Error(`${method} response timed out`)), 5_000);
  const onMessage = (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.id !== id) return;
    clearTimeout(timeout);
    ws.off("message", onMessage);
    resolveCall(message);
  };
  ws.on("message", onMessage);
  ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
});

const root = mkdtempSync(join(tmpdir(), "hara-standalone-serve-"));
const home = join(root, "home");
const discoveryPath = join(home, ".hara", "serve.json");
mkdirSync(home, { recursive: true });
let child;
let ws;
let stderr = "";
let stdout = "";

try {
  const port = await reservePort();
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    NO_COLOR: "1",
    HARA_UPDATE_CHECK: "0",
  };
  child = spawn(binary, [
    "serve",
    "--host", "127.0.0.1",
    "--port", String(port),
    "--cwd", root,
    "--approval", "suggest",
  ], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => {
    stdout = `${stdout}${String(chunk)}`.slice(-16_000);
  });
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${String(chunk)}`.slice(-16_000);
  });

  const record = await waitFor(() => {
    if (child.exitCode !== null) {
      throw new Error(`serve exited ${child.exitCode}: ${(stderr || stdout).trim().slice(-4_000)}`);
    }
    if (!existsSync(discoveryPath)) return null;
    try {
      return JSON.parse(readFileSync(discoveryPath, "utf8"));
    } catch {
      return null;
    }
  }, 15_000, `serve discovery timed out: ${(stderr || stdout).trim().slice(-4_000)}`);

  if (
    record.version !== expectedVersion
    || record.port !== port
    || record.pid !== child.pid
    || typeof record.token !== "string"
    || record.token.length < 16
  ) {
    throw new Error(`invalid serve discovery record: ${JSON.stringify({
      version: record.version,
      port: record.port,
      pid: record.pid,
      hasToken: typeof record.token === "string" && record.token.length >= 16,
    })}`);
  }

  ws = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((resolveOpen, reject) => {
    const timeout = setTimeout(() => reject(new Error("serve WebSocket open timed out")), 5_000);
    ws.once("open", () => {
      clearTimeout(timeout);
      resolveOpen();
    });
    ws.once("error", reject);
  });
  const initialized = await call(ws, 1, "initialize", { token: record.token });
  if (initialized.error || initialized.result?.version !== expectedVersion) {
    throw new Error(`serve initialize failed: ${JSON.stringify(initialized.error ?? initialized.result)}`);
  }
  const stopped = await call(ws, 2, "server.shutdown", {});
  if (stopped.error || stopped.result?.accepted !== true) {
    throw new Error(`serve shutdown failed: ${JSON.stringify(stopped.error ?? stopped.result)}`);
  }

  await waitFor(
    () => child.exitCode !== null,
    10_000,
    `serve did not exit after authenticated shutdown: ${(stderr || stdout).trim().slice(-4_000)}`,
  );
  if (child.exitCode !== 0) throw new Error(`serve exited ${child.exitCode}: ${(stderr || stdout).trim().slice(-4_000)}`);
  if (existsSync(discoveryPath)) throw new Error("serve.json remained after authenticated shutdown");
  console.log(`✓ native serve discovery + authenticated shutdown (${expectedVersion})`);
} catch (error) {
  console.error(`standalone serve smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  try {
    ws?.close();
  } catch {
    // best effort
  }
  if (child && child.exitCode === null) child.kill();
  rmSync(root, { recursive: true, force: true });
}
