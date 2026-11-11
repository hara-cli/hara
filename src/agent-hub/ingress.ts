import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { AgentHubError, exact, hubAssert, plain, type AgentHubErrorCode } from "./errors.js";
import { HUB_BODY_BYTES } from "./attachments.js";
import type { AgentHubStore } from "./store.js";

const HTTP_STATUS: Record<AgentHubErrorCode, number> = { invalid_request: 400, unauthorized: 401,
  conflict: 409, quota_exceeded: 413, unsupported_attachment: 415, registry_unavailable: 503, store_unavailable: 503 };
/** Independent loopback listener. No Workspace transport token, discovery scan or task route exists. */
export async function startAgentHubIngress<S, R>(options: {
  store: AgentHubStore<S, R>;
  /** C0 adapter supplies the public error document; no raw caught exception reaches it. */
  errorBody(code: AgentHubErrorCode): unknown;
}) {
  const sockets = new Set<Socket>(); let closing = false, activeBodies = 0;
  const server = createServer({ maxHeaderSize: 4096, connectionsCheckingInterval: 1000 }, (request, response) => {
    void handle(request, response).catch(() => { if (!response.writableEnded) response.destroy(); });
  });
  server.maxConnections = 8; server.headersTimeout = 5000; server.requestTimeout = 10000; server.keepAliveTimeout = 1000;
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  function send(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Connection": "close",
      "X-Content-Type-Options": "nosniff" }); response.end(JSON.stringify(value));
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let reading = false;
    try {
      hubAssert(!closing, "store_unavailable");
      hubAssert(request.method === "POST" && ["/v1/agent-hub/messages", "/v1/agent-hub/receipts"].includes(request.url ?? ""));
      hubAssert(request.headers.origin === undefined && request.headers["sec-fetch-site"] === undefined, "unauthorized");
      const address = server.address();
      hubAssert(address && typeof address === "object" && request.headers.host === `127.0.0.1:${address.port}`, "unauthorized");
      hubAssert(request.headers["content-type"] === "application/json");
      const authorization = request.headers.authorization;
      hubAssert(typeof authorization === "string" && /^Bearer [a-f0-9]{64}$/.test(authorization), "unauthorized");
      const token = authorization.slice(7); options.store.authorize(token);
      const declared = request.headers["content-length"];
      if (declared !== undefined) hubAssert(/^\d+$/.test(declared) && Number(declared) <= HUB_BODY_BYTES, "quota_exceeded");
      hubAssert(activeBodies < 2, "store_unavailable"); activeBodies++; reading = true;
      request.setTimeout(10000, () => request.destroy());
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += data.length;
        hubAssert(bytes <= HUB_BODY_BYTES, "quota_exceeded"); chunks.push(data);
      }
      const raw = Buffer.concat(chunks), text = raw.toString("utf8");
      hubAssert(Buffer.from(text).equals(raw));
      let input: unknown; try { input = JSON.parse(text); } catch { throw new AgentHubError("invalid_request"); }
      if (request.url === "/v1/agent-hub/receipts") {
        hubAssert(plain(input) && exact(input, ["requestId"]) && typeof input.requestId === "string");
        send(response, 200, options.store.receipt(token, input.requestId));
      } else send(response, 200, options.store.receive(token, input));
    } catch (error) {
      const code = error instanceof AgentHubError ? error.code : "store_unavailable";
      send(response, HTTP_STATUS[code], options.errorBody(code));
    } finally { if (reading) activeBodies--; }
  }
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); }); });
  const address = server.address(); hubAssert(address && typeof address === "object", "store_unavailable");
  return { endpoint: `http://127.0.0.1:${address.port}`, async close() {
    if (closing) return; closing = true;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
