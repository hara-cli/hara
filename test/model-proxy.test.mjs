import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import {
  bypassesModelProxy,
  createModelFetch,
  modelNetworkDiagnostic,
  parseWindowsProxyRegistry,
  safeModelNetworkFailureMessage,
  selectModelProxy,
  windowsProxyUri,
} from "../dist/network/model-fetch.js";
import { createProviderForTarget } from "../dist/providers/factory.js";

const PROXY_ENV_KEYS = [
  "HARA_MODEL_PROXY",
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "no_proxy",
  "NO_PROXY",
];

function clearProxyEnvironment() {
  const previous = new Map(PROXY_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test("Windows static system proxy parsing selects HTTPS and honors bypass rules", () => {
  const settings = parseWindowsProxyRegistry(`
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ    http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:7892
    ProxyOverride    REG_SZ    <local>;*.corp.internal
    AutoConfigURL    REG_SZ    http://wpad.example/proxy.pac
`);
  assert.deepEqual(settings, {
    enabled: true,
    server: "http=127.0.0.1:7890;https=127.0.0.1:7891;socks=127.0.0.1:7892",
    override: "<local>;*.corp.internal",
    autoConfigUrl: "http://wpad.example/proxy.pac",
  });
  assert.equal(
    windowsProxyUri(settings.server, new URL("https://gateway.example/v1")),
    "http://127.0.0.1:7891/",
  );
  assert.deepEqual(
    selectModelProxy(new URL("https://gateway.example/v1"), {
      env: {},
      platform: "win32",
      windowsProxy: settings,
    }),
    { uri: "http://127.0.0.1:7891/", source: "windows-system" },
  );
  assert.equal(
    selectModelProxy(new URL("https://desk.corp.internal/v1"), {
      env: {},
      platform: "win32",
      windowsProxy: settings,
    }),
    undefined,
  );
  assert.equal(
    selectModelProxy(new URL("https://intranet/v1"), {
      env: {},
      platform: "win32",
      windowsProxy: settings,
    }),
    undefined,
  );
});

test("model proxy selection honors explicit/env precedence, NO_PROXY, and unconditional loopback bypass", () => {
  const target = new URL("https://api.example.com/v1");
  assert.deepEqual(
    selectModelProxy(target, {
      configuredProxy: "http://config-user:config-pass@proxy-config.test:8080",
      env: {
        HARA_MODEL_PROXY: "http://hara.test:8081",
        HTTPS_PROXY: "http://environment.test:8082",
      },
      platform: "linux",
    }),
    { uri: "http://hara.test:8081/", source: "hara-env" },
  );
  assert.equal(
    selectModelProxy(target, {
      configuredProxy: "http://proxy.test:8080",
      env: { NO_PROXY: ".example.com" },
      platform: "linux",
    }),
    undefined,
  );
  assert.equal(
    bypassesModelProxy(new URL("http://127.0.0.1:11434/v1"), undefined),
    true,
  );
  assert.equal(
    selectModelProxy(new URL("http://localhost:11434/v1"), {
      configuredProxy: "http://proxy.test:8080",
      env: {},
      platform: "linux",
    }),
    undefined,
  );
});

test("offline model-network diagnostics identify effective proxy sources without disclosing addresses", () => {
  const target = "https://endpoint-user:endpoint-secret@private-model.example/private-path?token=private-query#private-fragment";
  const configuredProxy = "http://config-user:config-secret@private-config.example:8080";
  const windowsProxy = { enabled: true, server: "http=private-windows.example:8083" };
  const cases = [
    [{ configuredProxy, env: { HARA_MODEL_PROXY: "http://hara-user:hara-secret@private-hara.example:8081", HTTPS_PROXY: "http://private-env.example:8082" }, platform: "win32", windowsProxy }, /proxy via HARA_MODEL_PROXY \/ --proxy/],
    [{ configuredProxy, env: { HTTPS_PROXY: "http://env-user:env-secret@private-env.example:8082" }, platform: "win32", windowsProxy }, /proxy via HTTP\(S\)_PROXY environment/],
    [{ configuredProxy, env: {}, platform: "win32", windowsProxy }, /proxy via Hara user config/],
    [{ env: {}, platform: "win32", windowsProxy }, /proxy via Windows static system proxy/],
  ];
  for (const [options, expected] of cases) {
    const diagnosis = modelNetworkDiagnostic(target, options);
    assert.match(diagnosis, expected);
    assert.doesNotMatch(diagnosis, /private-|endpoint-user|endpoint-secret|config-user|config-secret|hara-user|hara-secret|env-user|env-secret|808[0-3]|https?:\/\//);
    assert.match(diagnosis, /addresses hidden/);
  }
});

test("offline model-network diagnostics distinguish NO_PROXY, loopback and Windows bypass decisions", () => {
  const configuredProxy = "http://private-proxy.example:8080";
  const target = "https://private-model.example:443/private-path?secret=private-query";
  const env = { HARA_MODEL_PROXY: configuredProxy, HTTPS_PROXY: configuredProxy, NO_PROXY: ".private-model.example:443" };
  assert.match(modelNetworkDiagnostic(target, { configuredProxy, env, platform: "linux" }), /direct — NO_PROXY matched/);
  assert.equal(selectModelProxy(new URL(target), { configuredProxy, env, platform: "linux" }), undefined);
  assert.match(modelNetworkDiagnostic(target, { configuredProxy, env: { ...env, no_proxy: ".other.example" }, platform: "linux" }), /proxy via HARA_MODEL_PROXY \/ --proxy · NO_PROXY not matched/);
  assert.match(modelNetworkDiagnostic(target, { configuredProxy, env: { NO_PROXY: ".private-model.example:444" }, platform: "linux" }), /proxy via Hara user config · NO_PROXY not matched/);
  for (const local of ["http://localhost:11434/v1", "http://127.0.0.2:11434/v1", "http://[::1]:11434/v1"]) {
    assert.match(modelNetworkDiagnostic(local, { configuredProxy: "invalid://secret", env: {}, platform: "linux" }), /direct — loopback intentionally bypasses proxies/);
  }
  assert.match(modelNetworkDiagnostic(target, { env: {}, platform: "win32", windowsProxy: { enabled: true, server: configuredProxy, override: "*.private-model.example" } }), /direct — Windows proxy bypass matched/);
  assert.match(modelNetworkDiagnostic(target, { env: {}, platform: "win32", windowsProxy: { enabled: true, server: "socks=private-socks.example:1080", autoConfigUrl: "https://private-pac.example/private.pac?secret=x" } }), /direct — no supported HTTP\(S\) proxy selected/);
  assert.doesNotMatch(modelNetworkDiagnostic(target, { configuredProxy, env, platform: "linux" }), /private-|https?:\/\//);
});

test("offline model-network diagnostics hide malformed endpoint/proxy inputs and send no request", () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("unexpected network request"); };
  try {
    assert.match(modelNetworkDiagnostic(undefined, { env: {}, platform: "linux" }), /unknown/);
    assert.equal(modelNetworkDiagnostic("private-endpoint-secret", { env: {}, platform: "linux" }), "invalid endpoint (address hidden)");
    assert.equal(modelNetworkDiagnostic("file:///private-path?secret=private-query", { env: {}, platform: "linux" }), "invalid endpoint — HTTP(S) required (address hidden)");
    assert.equal(modelNetworkDiagnostic("https://private-model.example", { configuredProxy: "http://user:password@private-proxy.example/private-path?token=private-query", env: {}, platform: "linux" }), "invalid proxy configuration — use an HTTP(S) origin (address hidden)");
    assert.match(modelNetworkDiagnostic("https://private-model.example", { env: {}, platform: "linux" }), /direct — no supported HTTP\(S\) proxy selected/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("managed model traffic uses an authenticated CONNECT proxy without exposing the proxy credential", async () => {
  const restoreEnvironment = clearProxyEnvironment();
  const targetSockets = new Set();
  const proxySockets = new Set();
  let authorization;
  let connectAuthority;
  let proxyAuthorization;

  const target = createServer((request, response) => {
    authorization = request.headers.authorization;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end([
      'data: {"id":"proxy-1","object":"chat.completion.chunk","created":1,"model":"managed","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}',
      "",
      'data: {"id":"proxy-1","object":"chat.completion.chunk","created":1,"model":"managed","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n"));
  });
  target.on("connection", (socket) => {
    targetSockets.add(socket);
    socket.once("close", () => targetSockets.delete(socket));
  });
  target.listen(0, "127.0.0.1");
  await once(target, "listening");

  const proxy = createServer();
  proxy.on("connection", (socket) => {
    proxySockets.add(socket);
    socket.once("close", () => proxySockets.delete(socket));
  });
  proxy.on("connect", (request, clientSocket, head) => {
    connectAuthority = request.url;
    proxyAuthorization = request.headers["proxy-authorization"];
    const targetAddress = target.address();
    assert.ok(targetAddress && typeof targetAddress === "object");
    const upstream = connect(targetAddress.port, "127.0.0.1", () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");

  try {
    const proxyAddress = proxy.address();
    assert.ok(proxyAddress && typeof proxyAddress === "object");
    const provider = await createProviderForTarget({
      provider: "hara-gateway",
      apiKey: "scoped-device-token",
      model: "managed",
      baseURL: "http://provider.example/v1",
      proxy: `http://proxy-user:proxy-password@127.0.0.1:${proxyAddress.port}`,
    });
    assert.ok(provider);
    const result = await provider.turn({
      system: "reply ok",
      history: [{ role: "user", content: "ok" }],
      tools: [],
      onText: () => {},
    });
    assert.equal(result.stop, "end");
    assert.equal(result.text, "ok");
    assert.equal(connectAuthority, "provider.example:80");
    assert.equal(proxyAuthorization, `Basic ${Buffer.from("proxy-user:proxy-password").toString("base64")}`);
    assert.equal(authorization, "Bearer scoped-device-token");
  } finally {
    restoreEnvironment();
    for (const socket of proxySockets) socket.destroy();
    for (const socket of targetSockets) socket.destroy();
    await Promise.all([closeServer(proxy), closeServer(target)]);
  }
});

test("model transport errors redact proxy credentials and destination URLs", async () => {
  const modelFetch = createModelFetch(
    "http://private-user:private-password@127.0.0.1:1",
    { env: {}, platform: "linux" },
  );
  await assert.rejects(
    () => modelFetch("https://secret-gateway.example/v1/chat/completions", {
      signal: AbortSignal.timeout(2_000),
    }),
    (error) => {
      assert.match(error.message, /model network request failed through the configured proxy/i);
      assert.doesNotMatch(error.message, /private-user|private-password|secret-gateway/i);
      return true;
    },
  );
});

test("provider SDK wrappers preserve only Hara's redacted model-network diagnosis", () => {
  const safe = "model network request failed through the Windows system proxy (ECONNREFUSED); verify the Windows static HTTP(S) proxy listener, bypass list, and VPN";
  const wrapped = new Error("Connection error.", {
    cause: new Error("SDK transport failed", { cause: new Error(safe) }),
  });
  assert.equal(safeModelNetworkFailureMessage(wrapped), safe);
  assert.equal(
    safeModelNetworkFailureMessage(
      new Error("Connection error.", {
        cause: new Error("request to https://user:password@secret.example failed"),
      }),
    ),
    undefined,
    "arbitrary SDK causes are never exposed",
  );
});

test("provider SDK wrappers reject forged model-network prefixes carrying credentials or endpoints", () => {
  const safePrefix = "model network request failed through the configured proxy";
  const guidance = "; check the endpoint, VPN, and proxy settings";
  for (const forged of [
    `${safePrefix} https://fixture-user:fixture-password@fixture-endpoint.invalid/fixture-path?token=fixture-query${guidance}`,
    `${safePrefix} (ECONNREFUSED); fixture-password`,
    `${safePrefix} (https://fixture-endpoint.invalid)${guidance}`,
    `model network request failed through the Windows system proxy (ECONNREFUSED)${guidance}`,
  ]) {
    assert.equal(safeModelNetworkFailureMessage(new Error("Connection error.", { cause: new Error(forged) })), undefined);
  }
  for (const safe of [
    `${safePrefix}${guidance}`,
    `${safePrefix} (ECONNREFUSED)${guidance}`,
    `model network request failed (ENETUNREACH)${guidance}`,
  ]) {
    assert.equal(safeModelNetworkFailureMessage(new Error("Connection error.", { cause: new Error(safe) })), safe);
  }
});

test("closed loopback endpoints receive a local-service diagnosis instead of proxy guidance", async () => {
  const modelFetch = createModelFetch(undefined, {
    env: {},
    platform: "win32",
    windowsProxy: {
      enabled: false,
      autoConfigUrl: "http://wpad.example/proxy.pac",
    },
  });
  await assert.rejects(
    () => modelFetch("http://127.0.0.1:1/v1/chat/completions", {
      signal: AbortSignal.timeout(2_000),
    }),
    (error) => {
      assert.match(error.message, /selected local endpoint is unavailable/i);
      assert.match(error.message, /loopback endpoints intentionally bypass proxies/i);
      assert.match(error.message, /start the selected local model\/gateway service/i);
      assert.match(error.message, /switch to a working personal direct connection/i);
      assert.match(error.message, /reconnect or re-enroll the selected organization connection/i);
      assert.doesNotMatch(error.message, /PAC-only or SOCKS-only/i);
      assert.doesNotMatch(error.message, /hara config set proxy/i);
      assert.doesNotMatch(error.message, /wpad\\.example/i);
      assert.doesNotMatch(error.message, /127\.0\.0\.1|:1(?:\D|$)/i);
      return true;
    },
  );
});

test("remote Windows failures without an HTTP(S) proxy retain safe PAC/SOCKS guidance", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const socketError = Object.assign(new Error("private transport detail"), {
      code: "ENETUNREACH",
    });
    throw new TypeError("fetch failed", {
      cause: new Error("provider wrapper", {
        cause: new Error("request wrapper", { cause: socketError }),
      }),
    });
  };
  try {
    const modelFetch = createModelFetch(undefined, {
      env: {},
      platform: "win32",
      windowsProxy: {
        enabled: false,
        autoConfigUrl: "http://wpad.example/proxy.pac",
      },
    });
    await assert.rejects(
      () => modelFetch("https://private-gateway.example/v1/chat/completions"),
      (error) => {
        assert.match(error.message, /without a supported HTTP\(S\) proxy/i);
        assert.match(error.message, /PAC-only or SOCKS-only/i);
        assert.match(error.message, /hara config set proxy/i);
        assert.match(error.message, /ENETUNREACH/i);
        assert.doesNotMatch(error.message, /private-gateway|private transport detail|wpad\\.example/i);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
