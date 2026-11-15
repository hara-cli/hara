import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  CONNECTION_CATALOG_SCHEMA_VERSION,
  HARA_DOCUMENTED_REFS,
  PI_CATALOG_GENERATED_AT,
  PI_CATALOG_PACKAGE,
  PI_CATALOG_PROVIDER_IDS,
  PI_CATALOG_VERSION,
  loadConnectionCatalog,
  queryConnectionCatalog,
} from "../dist/workspace/connection-catalog.js";
import { LocalWorkspaceCatalog } from "../dist/workspace/local-catalog.js";
import { openLocalWorkspaceDevRoot } from "../dist/workspace/local-dev-root.js";
import { workspaceResourceScopeKey } from "../dist/workspace/resource-context.js";
import { MemoryCredentialVault } from "../dist/workspace/credential-vault.js";
import { startLocalWorkspaceServe } from "../dist/serve/local-workspace.js";

const REPO_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ALLOWED_PI_KEYS = new Set([
  "id",
  "name",
  "api",
  "referenceContextWindow",
  "referenceMaxOutputTokens",
  "inputModalities",
  "reasoning",
]);

function makeTempDir() {
  return fs.realpathSync.native(fs.mkdtempSync(join(tmpdir(), "hara-c1-catalog-")));
}

function snapshotTree(dir) {
  const entries = new Map();
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = full.slice(dir.length + 1);
      if (entry.isDirectory()) {
        entries.set(`${rel}/`, "dir");
        walk(full);
      } else if (entry.isFile()) {
        entries.set(rel, createHash("sha256").update(fs.readFileSync(full)).digest("hex"));
      }
    }
  };
  walk(dir);
  return new Map([...entries.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

test("offline catalog adapter matches Pi 1.5.0 manifest, 42 groups, 1592 chat models, and Hara documented sources", async () => {
  const piRoot = join(REPO_ROOT, "node_modules", "@earendil-works", "pi-ai");
  const piPkg = JSON.parse(fs.readFileSync(join(piRoot, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(join(REPO_ROOT, "package-lock.json"), "utf8"));
  const dataDir = join(piRoot, "dist", "providers", "data");
  const manifest = JSON.parse(fs.readFileSync(join(dataDir, ".manifest.json"), "utf8"));

  assert.equal(PI_CATALOG_PACKAGE, "@earendil-works/pi-ai");
  assert.equal(PI_CATALOG_VERSION, piPkg.version);
  assert.equal(PI_CATALOG_VERSION, lock.packages["node_modules/@earendil-works/pi-ai"].version);
  assert.equal(PI_CATALOG_GENERATED_AT, manifest.generatedAt);

  const manifestProviders = Object.keys(manifest.files).map((file) => file.replace(/\.json$/, "")).sort();
  assert.deepEqual([...PI_CATALOG_PROVIDER_IDS].sort(), manifestProviders);
  assert.equal(PI_CATALOG_PROVIDER_IDS.length, 42);

  for (const [filename, expectedSha] of Object.entries(manifest.files)) {
    const actualSha = createHash("sha256").update(fs.readFileSync(join(dataDir, filename))).digest("hex");
    assert.equal(actualSha, expectedSha, `manifest sha256 mismatch for ${filename}`);
  }

  const snap1 = await loadConnectionCatalog();
  const snap2 = await loadConnectionCatalog();
  assert.equal(snap1.schemaVersion, CONNECTION_CATALOG_SCHEMA_VERSION);
  assert.equal(snap1.droppedInvalidCount, 0);
  assert.equal(snap1.catalog.digest, snap2.catalog.digest);
  assert.match(snap1.catalog.digest, /^sha256:[a-f0-9]{64}$/);

  let totalChat = 0;
  for (const providerId of PI_CATALOG_PROVIDER_IDS) {
    const models = snap1.piGroups[providerId];
    totalChat += models.length;
    for (const model of models) {
      for (const key of Object.keys(model)) {
        assert(ALLOWED_PI_KEYS.has(key), `unexpected projected field ${key} on ${providerId}/${model.id}`);
      }
      assert.equal(typeof model.id, "string");
      assert.equal(typeof model.name, "string");
      assert.equal(typeof model.api, "string");
    }
  }
  assert.equal(totalChat, 1592);
  assert.equal(snap1.piGroups.typesafe.length, 0);
  assert.equal(snap1.groups.length, 42 + HARA_DOCUMENTED_REFS.length);

  for (const ref of HARA_DOCUMENTED_REFS) {
    const models = snap1.documentedGroups[ref];
    assert(models.length > 0, `expected non-empty documented group ${ref}`);
    for (const model of models) {
      assert.deepEqual(Object.keys(model), ["id"]);
    }
  }

  // Deterministic ordering, search, and pagination
  const page1 = await queryConnectionCatalog({ providerId: "openrouter", query: "Claude", limit: 3 });
  const page2 = await queryConnectionCatalog({ providerId: "openrouter", query: "claude", cursor: page1.nextCursor, limit: 3 });
  assert.equal(page1.source, "pi-catalog");
  assert(page1.total > 3);
  assert.equal(page1.models.length, 3);
  assert.equal(page1.nextCursor, "3");
  assert.notEqual(page2.models[0].id, page1.models[0].id);

  const docPage = await queryConnectionCatalog({ documentedRef: "volcengine-agent-plan", query: "ark-code", limit: 10 });
  assert.equal(docPage.source, "hara-documented");
  assert.deepEqual(docPage.models, [{ id: "ark-code-latest" }]);
  assert.equal(docPage.nextCursor, null);
});

test("offline catalog loads with Node --permission (no write, no child_process, no Home, no network)", () => {
  const distDir = join(REPO_ROOT, "dist");
  const nodeModulesDir = join(REPO_ROOT, "node_modules");
  const script = `
    import net from "node:net";
    import tls from "node:tls";
    import dns from "node:dns";
    import assert from "node:assert/strict";

    const failNet = (name) => () => { throw new Error("Forbidden network call: " + name); };
    globalThis.fetch = failNet("fetch");
    net.connect = failNet("net.connect");
    net.createConnection = failNet("net.createConnection");
    tls.connect = failNet("tls.connect");
    dns.lookup = failNet("dns.lookup");
    dns.resolve = failNet("dns.resolve");

    assert.equal(process.permission.has("fs.write"), false);
    assert.equal(process.permission.has("child"), false);

    const mod = await import(${JSON.stringify(join(distDir, "workspace", "connection-catalog.js"))});
    const summary = await mod.queryConnectionCatalog({});
    assert.equal(summary.groups.length, 47);

    let totalPi = 0;
    for (const providerId of mod.PI_CATALOG_PROVIDER_IDS) {
      let cursor;
      do {
        const page = await mod.queryConnectionCatalog({ providerId, limit: 200, ...(cursor ? { cursor } : {}) });
        totalPi += page.models.length;
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    }
    assert.equal(totalPi, 1592);
    for (const documentedRef of mod.HARA_DOCUMENTED_REFS) {
      const page = await mod.queryConnectionCatalog({ documentedRef, limit: 200 });
      assert(page.models.length > 0);
    }
  `;

  const nonexistent = join(REPO_ROOT, ".nonexistent-isolated-home-for-c1");
  const result = spawnSync(
    process.execPath,
    [
      "--permission",
      `--allow-fs-read=${distDir}`,
      `--allow-fs-read=${nodeModulesDir}`,
      "--input-type=module",
      "-e",
      script,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: nonexistent,
        USERPROFILE: nonexistent,
        HARA_HOME: nonexistent,
        XDG_CONFIG_HOME: nonexistent,
        XDG_DATA_HOME: nonexistent,
        XDG_CACHE_HOME: nonexistent,
      },
    },
  );

  assert.equal(result.status, 0, `isolated subprocess failed: ${result.stderr}`);
});

test("RPC enforces workspace mode, unopened-space boundary, strict validation, zero vault calls, zero disk writes, and zero secret leaks", async (t) => {
  const root = makeTempDir();
  const hostHome = makeTempDir();
  const legacyHome = makeTempDir();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(hostHome, { recursive: true, force: true });
    fs.rmSync(legacyHome, { recursive: true, force: true });
  });

  // Seed a legacy file that must never be imported when reading catalog on an unopened workspace
  fs.mkdirSync(join(legacyHome, ".hara"), { recursive: true });
  fs.writeFileSync(
    join(legacyHome, ".hara", "workspace-connections-v2.json"),
    JSON.stringify({
      schemaVersion: 2,
      activeConnectionId: "legacy-conn-1",
      connections: [{
        id: "legacy-conn-1",
        label: "Legacy Seed",
        provider: "openai",
        baseURL: "https://legacy-seed.example/v1",
        apiKey: "sk-legacy-seed-secret",
        defaultModel: "gpt-5.6-sol",
      }],
    }),
  );

  const memory = new MemoryCredentialVault();
  const vaultStats = { get: 0, set: 0, remove: 0 };
  const vault = {
    get(ref) { vaultStats.get++; return memory.get(ref); },
    set(ref, value) { vaultStats.set++; memory.set(ref, value); },
    remove(ref) { vaultStats.remove++; memory.remove(ref); },
  };

  // Pre-create a personal workspace plus an unopened secondary workspace directly in the catalog (no workspace-data/project directory on disk)
  const openedRoot = openLocalWorkspaceDevRoot(root, "workspace");
  const preCatalog = new LocalWorkspaceCatalog(openedRoot.home);
  const personalRow = preCatalog.create("Personal Space", preCatalog.read().revision);
  const unopenedRow = preCatalog.create("Unopened Space", preCatalog.read().revision);
  const unopenedScopeKey = workspaceResourceScopeKey(unopenedRow.scope);
  assert.notEqual(personalRow.scope.workspaceId, unopenedRow.scope.workspaceId);

  const openRpcClient = async (port) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(socket, "open");
    let nextId = 0;
    const request = (method, params = {}) => new Promise((resolveReq, rejectReq) => {
      const id = ++nextId;
      const timer = setTimeout(() => rejectReq(new Error("RPC timeout")), 8000);
      const listener = (raw) => {
        const packet = JSON.parse(String(raw));
        if (packet.id !== id) return;
        clearTimeout(timer);
        socket.off("message", listener);
        packet.error ? rejectReq(new Error(packet.error.message)) : resolveReq(packet.result);
      };
      socket.on("message", listener);
      socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
    return { socket, request };
  };

  // Non-workspace mode must NOT advertise capability and must reject catalog calls
  const nonWorkspaceRoot = makeTempDir();
  t.after(() => fs.rmSync(nonWorkspaceRoot, { recursive: true, force: true }));
  const nonWsHandle = await startLocalWorkspaceServe(
    { host: "127.0.0.1", port: 0, cwd: nonWorkspaceRoot },
    { root: nonWorkspaceRoot, version: "fixture" },
  );
  const { socket: nonWsSocket, request: nonWsRequest } = await openRpcClient(nonWsHandle.port);
  try {
    const nonWsInit = await nonWsRequest("initialize", { token: nonWsHandle.token });
    assert.equal(nonWsInit.capabilities.includes("workspace.connection-catalog.v1"), false);
    const nonWsCreated = await nonWsRequest("workspace.create", { label: "NonWs", expectedRevision: nonWsInit.workspace.revision });
    await assert.rejects(
      nonWsRequest("workspace.connection.catalog", {
        workspaceId: nonWsCreated.workspaceId,
        expectedGeneration: nonWsCreated.resourceGeneration,
      }),
      /Workspace mode/,
    );
  } finally {
    nonWsSocket.close();
    await nonWsHandle.close();
  }

  // Workspace mode tests
  const handle = await startLocalWorkspaceServe(
    { host: "127.0.0.1", port: 0 },
    { root, mode: "workspace", version: "fixture", hostHome, legacySourceHome: legacyHome, credentialVault: vault },
  );
  const { socket, request } = await openRpcClient(handle.port);

  try {
    const init = await request("initialize", { token: handle.token });
    assert(init.capabilities.includes("workspace.connection-catalog.v1"));

    // Unopened workspace must fail without creating scope/project dirs or touching legacy/vault
    await assert.rejects(
      request("workspace.connection.catalog", {
        workspaceId: unopenedRow.scope.workspaceId,
        expectedGeneration: "00000000-0000-4000-8000-000000000000",
      }),
      /must be opened/,
    );
    assert.equal(fs.existsSync(join(root, ".hara", "workspace-data", "v1", unopenedScopeKey)), false);
    assert.equal(fs.existsSync(join(root, ".hara", "project", unopenedRow.scope.workspaceId)), false);
    assert.deepEqual(vaultStats, { get: 0, set: 0, remove: 0 });

    // Create & open a workspace, save a connection with sensitive details
    const created = await request("workspace.create", { label: "Catalog Fixture", expectedRevision: init.workspace.revision });
    const scope = { workspaceId: created.workspaceId, expectedGeneration: created.resourceGeneration };
    const secretKey = "sk-fixture-secret-value-never-leak";
    const secretLabel = "Private-Fixture-Connection-Label";
    const secretBaseUrl = "https://private-fixture-host.example/v1";

    await request("workspace.connection.add", {
      ...scope,
      expectedRevision: 0,
      input: {
        label: secretLabel,
        provider: "openai",
        baseURL: secretBaseUrl,
        apiKey: secretKey,
        defaultModel: "gpt-5.6-sol",
      },
    });

    const snapshotBefore = await request("workspace.snapshot", { workspaceId: scope.workspaceId, agentId: null });
    const treeBefore = snapshotTree(root);
    const vaultBefore = { ...vaultStats };

    // Rejection cases
    for (const [badParams, expectedErr] of [
      [{ ...scope, extraField: true }, /unsupported Workspace RPC fields/],
      [{ ...scope, apiKey: "sk-123" }, /unsupported Workspace RPC fields/],
      [{ ...scope, credentialRef: "ref-1" }, /unsupported Workspace RPC fields/],
      [{ ...scope, path: "/etc/passwd" }, /unsupported Workspace RPC fields/],
      [{ ...scope, module: "fs" }, /unsupported Workspace RPC fields/],
      [{ ...scope, providerId: "unknown-provider" }, /Unsupported connection catalog provider/],
      [{ ...scope, providerId: "../deepseek" }, /Unsupported connection catalog provider/],
      [{ ...scope, documentedRef: "unknown-doc" }, /Unsupported documented connection catalog group/],
      [{ ...scope, providerId: "deepseek", documentedRef: "deepseek-responses" }, /at most one/],
      [{ ...scope, providerId: "deepseek", query: "x".repeat(201) }, /search query/],
      [{ ...scope, providerId: "deepseek", query: "bad\nquery" }, /search query/],
      [{ ...scope, providerId: "deepseek", limit: 0 }, /page limit/],
      [{ ...scope, providerId: "deepseek", limit: 201 }, /page limit/],
      [{ ...scope, providerId: "deepseek", limit: 1.5 }, /page limit/],
      [{ ...scope, providerId: "deepseek", cursor: "-1" }, /cursor/],
      [{ ...scope, providerId: "deepseek", cursor: "01" }, /cursor/],
      [{ ...scope, cursor: "0" }, /requires providerId or documentedRef/],
      [{ workspaceId: scope.workspaceId, expectedGeneration: "00000000-0000-4000-8000-000000000000" }, /generation changed/],
    ]) {
      await assert.rejects(request("workspace.connection.catalog", badParams), expectedErr);
    }

    // Valid catalog calls (group summary, pi-catalog, hara-documented)
    const summary = await request("workspace.connection.catalog", scope);
    assert.equal(summary.schemaVersion, 1);
    assert.equal(summary.groups.length, 47);

    const deepseek = await request("workspace.connection.catalog", { ...scope, providerId: "deepseek" });
    assert.equal(deepseek.source, "pi-catalog");
    assert.equal(deepseek.providerId, "deepseek");
    assert.equal(deepseek.models.length, 2);

    const documented = await request("workspace.connection.catalog", { ...scope, documentedRef: "alibaba-coding-plan" });
    assert.equal(documented.source, "hara-documented");
    assert(documented.models.some((row) => row.id === "qwen3.7-plus"));

    // Verify 0 vault calls, 0 disk changes, identical workspace snapshot/revision, and no connection secrets leaked
    assert.deepEqual(vaultStats, vaultBefore);
    const snapshotAfter = await request("workspace.snapshot", { workspaceId: scope.workspaceId, agentId: null });
    assert.equal(snapshotAfter.connections.revision, snapshotBefore.connections.revision);
    assert.deepEqual(snapshotAfter.connections, snapshotBefore.connections);
    assert.deepEqual(snapshotTree(root), treeBefore);

    for (const payload of [summary, deepseek, documented]) {
      const serialized = JSON.stringify(payload);
      assert(!serialized.includes(secretKey));
      assert(!serialized.includes("never-leak"));
      assert(!serialized.includes(secretLabel));
      assert(!serialized.includes(secretBaseUrl));
      assert(!serialized.includes("private-fixture-host"));
    }
  } finally {
    socket.close();
    await handle.close();
  }
});
