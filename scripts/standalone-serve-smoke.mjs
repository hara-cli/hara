#!/usr/bin/env node
// Start the real native standalone, require its authenticated discovery record, then stop it through
// server.shutdown. The Windows lane exists specifically to catch unsupported native-handle operations
// (for example POSIX fchmod) that portable unit tests can only simulate.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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

const waitForChildExit = (processHandle, timeoutMs) => {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const onExit = () => {
      clearTimeout(timeout);
      resolveExit(true);
    };
    const timeout = setTimeout(() => {
      processHandle.off("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    processHandle.once("exit", onExit);
  });
};

const removeTreeWithRetry = async (path, attempts = 5) => {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const retryable = ["EBUSY", "ENOTEMPTY", "EPERM"].includes(error?.code);
      if (!retryable || attempt === attempts) throw error;
      await new Promise((resolveWait) => setTimeout(resolveWait, attempt * 200));
    }
  }
};

const call = (ws, id, method, params, timeoutMs = 15_000) => new Promise((resolveCall, reject) => {
  const onTimeout = () => {
    ws.removeEventListener("message", onMessage);
    reject(new Error(`${method} response timed out`));
  };
  const timeout = setTimeout(onTimeout, timeoutMs);
  const onMessage = (event) => {
    let message;
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return;
    }
    if (message.id !== id) return;
    clearTimeout(timeout);
    ws.removeEventListener("message", onMessage);
    resolveCall(message);
  };
  ws.addEventListener("message", onMessage);
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
  }, 30_000, `serve discovery timed out: ${(stderr || stdout).trim().slice(-4_000)}`);

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
    const cleanup = () => {
      clearTimeout(timeout);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolveOpen();
    };
    const onError = (event) => {
      cleanup();
      reject(event.error instanceof Error ? event.error : new Error("serve WebSocket open failed"));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("serve WebSocket open timed out"));
    }, 15_000);
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });
  let initialized;
  try {
    initialized = await call(ws, 1, "initialize", { token: record.token });
  } catch (error) {
    const childOutput = (stderr || stdout).trim().slice(-4_000);
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}${childOutput ? `: ${childOutput}` : ""}`,
    );
  }
  if (initialized.error || initialized.result?.version !== expectedVersion) {
    throw new Error(`serve initialize failed: ${JSON.stringify(initialized.error ?? initialized.result)}`);
  }
  const methods = new Set(initialized.result?.capabilities?.methods ?? []);
  const features = new Set(initialized.result?.capabilities?.features ?? []);
  for (const method of ["desk.connections.list", "desk.snapshot", "desk.task.get"]) {
    if (!methods.has(method)) throw new Error(`serve capability is missing ${method}`);
  }
  for (const method of [
    "presentation.create",
    "presentation.validate",
    "presentation.preview",
    "presentation.export",
  ]) {
    if (!methods.has(method)) throw new Error(`serve capability is missing ${method}`);
  }
  if (!features.has("collaboration.remote.v1")) {
    throw new Error("serve capability is missing collaboration.remote.v1");
  }
  const deskConnections = await call(ws, 2, "desk.connections.list", {});
  if (
    deskConnections.error
    || !Array.isArray(deskConnections.result?.connections)
    || typeof deskConnections.result?.legacyUnbound !== "boolean"
  ) {
    throw new Error(
      `serve Desk connection inventory failed: ${JSON.stringify(
        deskConnections.error ?? deskConnections.result,
      )}`,
    );
  }
  // Exercise the real session-index path used by Desktop immediately after initialize. Simple
  // --version/--help probes cannot catch runtime API differences such as Bun's synchronous Dir.close().
  const listed = await call(ws, 3, "session.list", { limit: 50 });
  if (listed.error || !Array.isArray(listed.result?.sessions)) {
    throw new Error(`serve session list failed: ${JSON.stringify(listed.error ?? listed.result)}`);
  }
  // Exercise the complete native Presentation path. This catches dependencies that compile into the Bun
  // standalone but fail only when the Desktop asks the sidecar to render HTML or an editable PPTX.
  const presentation = await call(ws, 4, "presentation.create", { title: "Standalone proof" });
  if (
    presentation.error
    || presentation.result?.content?.extension !== ".hpres"
    || presentation.result?.project?.slides?.length !== 1
  ) {
    throw new Error(`serve Presentation create failed: ${JSON.stringify(presentation.error ?? presentation.result)}`);
  }
  const artifactId = presentation.result.artifact.artifactId;
  const revisionId = presentation.result.currentRevision.revisionId;
  const validated = await call(ws, 5, "presentation.validate", { artifactId, revisionId });
  if (validated.error || validated.result?.report?.status !== "pass") {
    throw new Error(`serve Presentation validation failed: ${JSON.stringify(validated.error ?? validated.result)}`);
  }
  const preview = await call(ws, 6, "presentation.preview", { artifactId, revisionId });
  if (preview.error || !preview.result?.html?.includes("Standalone proof")) {
    throw new Error(`serve Presentation preview failed: ${JSON.stringify(preview.error ?? preview.result)}`);
  }
  const pptxPath = join(root, "standalone-proof.pptx");
  const exported = await call(ws, 7, "presentation.export", {
    artifactId,
    revisionId,
    validationReportId: validated.result.report.reportId,
    destinationPath: pptxPath,
    format: "pptx",
  });
  const pptxBytes = existsSync(pptxPath) ? readFileSync(pptxPath) : Buffer.alloc(0);
  if (
    exported.error
    || exported.result?.receipt?.fidelity !== "template-editable"
    || !pptxBytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  ) {
    throw new Error(`serve Presentation PPTX export failed: ${JSON.stringify(exported.error ?? exported.result)}`);
  }

  const stopped = await call(ws, 8, "server.shutdown", {});
  if (stopped.error || stopped.result?.accepted !== true) {
    throw new Error(`serve shutdown failed: ${JSON.stringify(stopped.error ?? stopped.result)}`);
  }

  await waitFor(
    () => child.exitCode !== null,
    15_000,
    `serve did not exit after authenticated shutdown: ${(stderr || stdout).trim().slice(-4_000)}`,
  );
  if (child.exitCode !== 0) throw new Error(`serve exited ${child.exitCode}: ${(stderr || stdout).trim().slice(-4_000)}`);
  if (existsSync(discoveryPath)) throw new Error("serve.json remained after authenticated shutdown");
  console.log(`✓ native Serve Desk + Presentation HTML/PPTX + authenticated shutdown (${expectedVersion})`);
} catch (error) {
  console.error(`standalone serve smoke: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  try {
    ws?.close();
  } catch {
    // best effort
  }
  let childStopped = !child || child.exitCode !== null || child.signalCode !== null;
  if (child && !childStopped) {
    child.kill();
    childStopped = await waitForChildExit(child, 10_000);
    if (!childStopped) {
      child.kill("SIGKILL");
      childStopped = await waitForChildExit(child, 5_000);
    }
  }
  if (!childStopped) {
    console.error("standalone serve smoke cleanup: child did not exit; preserving its temporary directory");
    process.exitCode = 1;
  } else {
    try {
      await removeTreeWithRetry(root);
    } catch (error) {
      console.error(`standalone serve smoke cleanup: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
