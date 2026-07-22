// Optional isolated headless rendering for web_fetch. The browser uses a fresh temporary profile and is
// forced through a loopback validating proxy: every top-level/subresource destination is resolved once,
// rejected if any answer is private/internal, and connected by the approved IP. This preserves web_fetch's
// SSRF boundary across JavaScript redirects instead of handing Chrome an unchecked public URL.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
  type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { createConnection, type Socket } from "node:net";
import { tmpdir, platform } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { terminateSubprocessTree, toolSubprocessEnv } from "../security/subprocess-env.js";

const MAX_BROWSER_REQUESTS = 192;
const MAX_BROWSER_BYTES = 64 * 1024 * 1024;
const MAX_BROWSER_HTML_BYTES = 4 * 1024 * 1024;
const BROWSER_TIMEOUT_MS = 25_000;
const BROWSER_SOCKET_TIMEOUT_MS = 12_000;

export interface BrowserRoute {
  address: string;
  family: 4 | 6;
  /** User-selected upstream proxy. It may contain credentials and must never be rendered/logged. */
  proxyUri?: string;
}

export type BrowserRouteResolver = (url: URL) => Promise<BrowserRoute>;

function executableCandidates(env: NodeJS.ProcessEnv, plat: string): string[] {
  const explicit = String(env.HARA_BROWSER_PATH ?? "").trim();
  const fixed = plat === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ]
    : plat === "win32"
      ? [
          env.ProgramFiles && join(env.ProgramFiles, "Google/Chrome/Application/chrome.exe"),
          env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "Google/Chrome/Application/chrome.exe"),
          env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
          env.ProgramFiles && join(env.ProgramFiles, "Microsoft/Edge/Application/msedge.exe"),
        ]
      : [
          "/usr/bin/google-chrome",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/chromium",
          "/usr/bin/chromium-browser",
          "/usr/bin/microsoft-edge",
        ];
  const names = plat === "win32"
    ? ["chrome.exe", "msedge.exe", "chromium.exe"]
    : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];
  const onPath = String(env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .flatMap((dir) => names.map((name) => join(dir, name)));
  return [explicit && isAbsolute(explicit) ? explicit : "", ...fixed, ...onPath]
    .filter((value): value is string => !!value);
}

/** Find an already-installed Chromium-family browser. Hara never downloads or mutates a browser install. */
export function findHeadlessBrowser(
  env: NodeJS.ProcessEnv = process.env,
  plat = platform(),
): string | undefined {
  return executableCandidates(env, plat).find((path) => {
    try { return existsSync(path); } catch { return false; }
  });
}

function safeHeaders(headers: IncomingMessage["headers"]): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  const dropped = new Set([
    "connection", "proxy-authorization", "proxy-authenticate", "proxy-connection", "keep-alive",
    "te", "trailer", "transfer-encoding", "upgrade",
  ]);
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || dropped.has(name.toLowerCase())) continue;
    result[name] = value;
  }
  return result;
}

function proxyAuth(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) return undefined;
  return `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`;
}

function pinnedAuthority(route: BrowserRoute, port: number): string {
  return `${route.family === 6 ? `[${route.address}]` : route.address}:${port}`;
}

function parseConnectTarget(authority: string): URL {
  if (!authority || /[\s/@?#]/u.test(authority)) throw new Error("invalid CONNECT target");
  const target = new URL(`https://${authority}`);
  if (!target.hostname || target.username || target.password || target.pathname !== "/") throw new Error("invalid CONNECT target");
  return target;
}

function requestThroughUpstream(
  proxyUri: string,
  target: URL,
  route: BrowserRoute,
  req: IncomingMessage,
  res: ServerResponse,
  countBytes: (amount: number) => boolean,
): void {
  const proxy = new URL(proxyUri);
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") throw new Error("unsupported upstream proxy");
  const pinned = new URL(target.href);
  pinned.hostname = route.family === 6 ? `[${route.address}]` : route.address;
  pinned.username = "";
  pinned.password = "";
  const headers: Record<string, string | string[]> = { ...safeHeaders(req.headers), host: target.host };
  const auth = proxyAuth(proxy);
  if (auth) headers["proxy-authorization"] = auth;
  const options: RequestOptions = {
    protocol: proxy.protocol,
    hostname: proxy.hostname,
    port: proxy.port || undefined,
    method: req.method,
    path: pinned.href,
    headers,
    ...(proxy.protocol === "https:" ? { servername: proxy.hostname } : {}),
  };
  const upstream = (proxy.protocol === "https:" ? httpsRequest : httpRequest)(options, (remote) => {
    res.writeHead(remote.statusCode ?? 502, remote.headers);
    remote.once("error", () => { if (!res.destroyed) res.end(); });
    remote.on("data", (chunk: Buffer) => {
      if (!countBytes(chunk.length)) remote.destroy();
    });
    remote.pipe(res);
  });
  upstream.setTimeout(BROWSER_SOCKET_TIMEOUT_MS, () => upstream.destroy(new Error("render proxy timeout")));
  res.once("close", () => upstream.destroy());
  upstream.once("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end("render proxy request failed");
  });
  req.pipe(upstream);
}

function requestDirect(
  target: URL,
  route: BrowserRoute,
  req: IncomingMessage,
  res: ServerResponse,
  countBytes: (amount: number) => boolean,
): void {
  const upstream = httpRequest({
    protocol: "http:",
    hostname: route.address,
    family: route.family,
    port: target.port || 80,
    method: req.method,
    path: `${target.pathname}${target.search}`,
    headers: { ...safeHeaders(req.headers), host: target.host },
  }, (remote) => {
    res.writeHead(remote.statusCode ?? 502, remote.headers);
    remote.once("error", () => { if (!res.destroyed) res.end(); });
    remote.on("data", (chunk: Buffer) => {
      if (!countBytes(chunk.length)) remote.destroy();
    });
    remote.pipe(res);
  });
  upstream.setTimeout(BROWSER_SOCKET_TIMEOUT_MS, () => upstream.destroy(new Error("render destination timeout")));
  res.once("close", () => upstream.destroy());
  upstream.once("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end("render proxy request failed");
  });
  req.pipe(upstream);
}

async function upstreamTunnel(
  proxyUri: string,
  authority: string,
  onSocket: (socket: Socket) => void,
): Promise<{ socket: Socket; leftover: Buffer }> {
  const proxy = new URL(proxyUri);
  if (proxy.protocol !== "http:" && proxy.protocol !== "https:") throw new Error("unsupported upstream proxy");
  const port = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
  const socket: Socket = proxy.protocol === "https:"
    ? tlsConnect({ host: proxy.hostname, port, servername: proxy.hostname })
    : createConnection({ host: proxy.hostname, port });
  onSocket(socket);
  socket.setTimeout(BROWSER_SOCKET_TIMEOUT_MS, () => socket.destroy(new Error("upstream proxy timeout")));
  await once(socket, proxy.protocol === "https:" ? "secureConnect" : "connect");
  const auth = proxyAuth(proxy);
  socket.write(
    `CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n` +
    (auth ? `Proxy-Authorization: ${auth}\r\n` : "") +
    "Connection: keep-alive\r\n\r\n",
  );
  return await new Promise<{ socket: Socket; leftover: Buffer }>((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const fail = (): void => reject(new Error("upstream proxy tunnel failed"));
    const onData = (chunk: Buffer): void => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 16 * 1024) return fail();
      const boundary = buffered.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      socket.off("data", onData);
      socket.off("error", fail);
      const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/iu.exec(buffered.subarray(0, boundary).toString("latin1"))?.[1] ?? 0);
      if (status < 200 || status >= 300) return fail();
      socket.setTimeout(BROWSER_TIMEOUT_MS, () => socket.destroy());
      resolve({ socket, leftover: buffered.subarray(boundary + 4) });
    };
    socket.on("data", onData);
    socket.once("error", fail);
  }).catch((error) => {
    socket.destroy();
    throw error;
  });
}

async function startValidatingProxy(resolveRoute: BrowserRouteResolver): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const sockets = new Set<Socket>();
  let requestCount = 0;
  let byteCount = 0;
  let closed = false;
  const countRequest = (): boolean => !closed && ++requestCount <= MAX_BROWSER_REQUESTS;
  const countBytes = (amount: number): boolean => !closed && (byteCount += amount) <= MAX_BROWSER_BYTES;
  const server = createServer(async (req, res) => {
    if (!countRequest()) {
      res.writeHead(429);
      return void res.end("render request budget exceeded");
    }
    try {
      const target = new URL(String(req.url));
      if (target.protocol !== "http:" || target.username || target.password) throw new Error("invalid proxied URL");
      const route = await resolveRoute(target);
      if (route.proxyUri) requestThroughUpstream(route.proxyUri, target, route, req, res, countBytes);
      else requestDirect(target, route, req, res, countBytes);
    } catch {
      res.writeHead(502);
      res.end("render destination blocked");
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("connect", async (req, client, head) => {
    client.on("error", () => {});
    if (!countRequest()) {
      client.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      return;
    }
    try {
      const target = parseConnectTarget(String(req.url));
      const port = Number(target.port || 443);
      const route = await resolveRoute(target);
      const authority = pinnedAuthority(route, port);
      let tunnel: { socket: Socket; leftover: Buffer };
      if (route.proxyUri) {
        tunnel = await upstreamTunnel(route.proxyUri, authority, (socket) => {
          sockets.add(socket);
          socket.once("close", () => sockets.delete(socket));
        });
      } else {
        const socket = createConnection({ host: route.address, port, family: route.family });
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.setTimeout(BROWSER_SOCKET_TIMEOUT_MS, () => socket.destroy(new Error("render destination timeout")));
        await once(socket, "connect");
        socket.setTimeout(BROWSER_TIMEOUT_MS, () => socket.destroy());
        tunnel = { socket, leftover: Buffer.alloc(0) };
      }
      const remote = tunnel.socket;
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (tunnel.leftover.length) client.write(tunnel.leftover);
      if (head.length) remote.write(head);
      // Browsers routinely cancel speculative/subresource tunnels. A pipe destination can then raise EPIPE;
      // pair the two endpoints explicitly so cancellation is ordinary cleanup, never a Hara process crash.
      client.on("error", () => remote.destroy());
      remote.on("error", () => client.destroy());
      client.once("close", () => remote.destroy());
      remote.once("close", () => client.destroy());
      remote.on("data", (chunk: Buffer) => {
        if (!countBytes(chunk.length)) {
          remote.destroy();
          client.destroy();
        }
      });
      client.on("data", (chunk: Buffer) => {
        if (!countBytes(chunk.length)) {
          remote.destroy();
          client.destroy();
        }
      });
      client.pipe(remote);
      remote.pipe(client);
    } catch {
      client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not bind render proxy");
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface HeadlessRenderResult {
  html?: string;
  error?: "browser-unavailable" | "timed-out" | "failed" | "output-too-large";
}

/** Render one page in an isolated profile. This is deliberately optional: callers classify it as computer
 * use so ordinary read-only web_fetch never starts a JS engine without a user-approved render:true call. */
export async function renderHeadlessHtml(
  url: URL,
  resolveRoute: BrowserRouteResolver,
  parentSignal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
): Promise<HeadlessRenderResult> {
  const browser = findHeadlessBrowser(env);
  if (!browser) return { error: "browser-unavailable" };
  if (parentSignal?.aborted) return { error: "failed" };
  const profile = mkdtempSync(join(tmpdir(), "hara-headless-web-"));
  let proxy: Awaited<ReturnType<typeof startValidatingProxy>> | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let cancelTree: (() => void) | undefined;
  try {
    // Keep proxy startup inside the cleanup boundary: a bind/listen failure must not strand the fresh
    // browser profile created above.
    proxy = await startValidatingProxy(resolveRoute);
    const args = [
      "--headless=new",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--disable-translate",
      "--disable-quic",
      "--disable-dev-shm-usage",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE ::1",
      "--metrics-recording-only",
      "--mute-audio",
      "--no-default-browser-check",
      "--no-first-run",
      "--password-store=basic",
      "--use-mock-keychain",
      `--user-data-dir=${profile}`,
      `--disk-cache-dir=${join(profile, "cache")}`,
      `--proxy-server=${proxy.url}`,
      "--proxy-bypass-list=<-loopback>",
      "--virtual-time-budget=8000",
      "--dump-dom",
      url.href,
    ];
    const processGroup = platform() !== "win32";
    child = spawn(browser, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: processGroup,
      env: toolSubprocessEnv(env, {
        HARA_BROWSER_PATH: undefined,
        HARA_WEB_PROXY: undefined,
        HTTPS_PROXY: undefined,
        HTTP_PROXY: undefined,
        https_proxy: undefined,
        http_proxy: undefined,
      }),
    });
    const result = await new Promise<HeadlessRenderResult>((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let settled = false;
      const finish = (value: HeadlessRenderResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        parentSignal?.removeEventListener("abort", abort);
        resolve(value);
      };
      const stop = (value: HeadlessRenderResult): void => {
        if (child && !cancelTree) cancelTree = terminateSubprocessTree(child, { processGroup, force: true });
        finish(value);
      };
      const abort = (): void => stop({ error: "failed" });
      parentSignal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => stop({ error: "timed-out" }), BROWSER_TIMEOUT_MS);
      child!.stdout!.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BROWSER_HTML_BYTES) return stop({ error: "output-too-large" });
        chunks.push(chunk);
        // Chrome can keep utility processes/pipes alive briefly after --dump-dom has emitted the complete
        // document (especially with a validating proxy). The serialized closing tag is the result boundary;
        // return it immediately and terminate the isolated process tree instead of false-timing-out.
        const tail = Buffer.concat(chunks.slice(-3)).toString("utf8").slice(-256);
        if (/<\/html>\s*$/iu.test(tail)) {
          if (child && !cancelTree) cancelTree = terminateSubprocessTree(child, { processGroup, force: true });
          finish({ html: Buffer.concat(chunks).toString("utf8") });
        }
      });
      // Browser diagnostics can contain machine-specific paths. Drain but never return them to the model.
      child!.stderr!.resume();
      child!.once("error", () => finish({ error: "failed" }));
      child!.once("close", (code) => {
        if (code !== 0 || !chunks.length) return finish({ error: "failed" });
        finish({ html: Buffer.concat(chunks).toString("utf8") });
      });
    });
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    cancelTree?.();
    await proxy?.close().catch(() => {});
    rmSync(profile, { recursive: true, force: true });
  }
}
