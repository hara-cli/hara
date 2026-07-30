import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { connect } from "node:net";
import {
  bypassesModelProxy,
  createModelFetch,
  parseWindowsProxyRegistry,
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
