#!/usr/bin/env node
// Exercise the active runtime's real proxy transport. Node uses a lazy Undici dispatcher; Bun
// (including compiled Desktop/CLI sidecars) uses Bun's native fetch proxy option.
import { once } from "node:events";
import { createServer } from "node:http";
import { Buffer } from "node:buffer";
import { connect } from "node:net";
import { createModelFetch } from "../dist/network/model-fetch.js";

const proxyUser = "runtime-user";
const proxyPassword = "runtime-password";
const expectedAuthorization = `Basic ${Buffer.from(`${proxyUser}:${proxyPassword}`).toString("base64")}`;
let proxyRequestCount = 0;

const target = createServer((_request, response) => {
  response.writeHead(200, {
    "content-type": "application/json",
    connection: "close",
  });
  response.end(JSON.stringify({ ok: true, via: "proxy" }));
});
target.listen(0, "127.0.0.1");
await once(target, "listening");

const proxy = createServer((request, response) => {
  proxyRequestCount += 1;
  if (request.headers["proxy-authorization"] !== expectedAuthorization) {
    response.writeHead(407, { "proxy-authenticate": 'Basic realm="Hara proxy smoke"' });
    response.end();
    return;
  }
  response.writeHead(200, {
    "content-type": "application/json",
    connection: "close",
  });
  response.end(JSON.stringify({ ok: true, via: "proxy" }));
});
proxy.on("connect", (request, clientSocket, head) => {
  proxyRequestCount += 1;
  if (request.headers["proxy-authorization"] !== expectedAuthorization) {
    clientSocket.end([
      "HTTP/1.1 407 Proxy Authentication Required",
      'Proxy-Authenticate: Basic realm="Hara proxy smoke"',
      "Connection: close",
      "",
      "",
    ].join("\r\n"));
    return;
  }
  const targetAddress = target.address();
  if (!targetAddress || typeof targetAddress !== "object") {
    clientSocket.destroy();
    return;
  }
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
  const address = proxy.address();
  if (!address || typeof address !== "object") throw new Error("proxy address unavailable");
  const fetchThroughProxy = createModelFetch(
    `http://${proxyUser}:${proxyPassword}@127.0.0.1:${address.port}`,
    { env: {}, platform: process.platform },
  );
  const response = await fetchThroughProxy("http://model-gateway.invalid/v1/runtime-smoke", {
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json();
  if (!response.ok || payload?.ok !== true || payload?.via !== "proxy" || proxyRequestCount !== 1) {
    throw new Error(`unexpected proxy response (${response.status}, requests=${proxyRequestCount})`);
  }
  console.log(`✓ ${typeof globalThis.Bun === "object" ? "Bun" : "Node"} model proxy transport`);
} finally {
  await Promise.all([proxy, target].map((server) =>
    new Promise((resolveClose, rejectClose) => {
      if (!server.listening) {
        resolveClose();
        return;
      }
      server.close((error) => error ? rejectClose(error) : resolveClose());
    })
  ));
}
