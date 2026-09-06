import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

import WebSocket, { type RawData } from "ws";

import { effectiveHomeDir } from "../runtime.js";

const REQUEST_TIMEOUT_MS = 20_000;

type Discovery = Readonly<{
  host: string;
  instanceId: string;
  pid: number;
  port: number;
  token: string;
  version: string;
}>;

type Pending = {
  reject(error: Error): void;
  resolve(value: unknown): void;
  timer: ReturnType<typeof setTimeout>;
};

export class LocalServeRpcError extends Error {
  constructor(readonly code: number, message = "Local Hara Serve request failed") {
    super(message);
    this.name = "LocalServeRpcError";
  }
}

const bounded = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;

function readDiscovery(home: string): Discovery {
  const path = join(home, ".hara", "serve.json");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Hara Serve discovery is unsafe");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
    throw new Error("Hara Serve discovery is not private");
  }
  const text = readFileSync(path, "utf8");
  if (text.length > 16_384) throw new Error("Hara Serve discovery is invalid");
  const value = JSON.parse(text) as Record<string, unknown>;
  const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (
    !loopback.has(String(value.host))
    || !Number.isInteger(value.port)
    || Number(value.port) < 1
    || Number(value.port) > 65_535
    || !Number.isSafeInteger(value.pid)
    || Number(value.pid) < 1
    || !bounded(value.token, 512)
    || !bounded(value.instanceId, 160)
    || !bounded(value.version, 80)
  ) throw new Error("Hara Serve discovery is invalid");
  try {
    process.kill(Number(value.pid), 0);
  } catch (error: any) {
    if (error?.code !== "EPERM") throw new Error("Hara Serve is not running");
  }
  return value as unknown as Discovery;
}

function websocketUrl(discovery: Discovery): string {
  const host = discovery.host.includes(":") && !discovery.host.startsWith("[")
    ? `[${discovery.host}]`
    : discovery.host;
  return `ws://${host}:${discovery.port}`;
}

export interface LocalCompanionRpc {
  call<T = unknown>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  close(): Promise<void>;
  onNotification(listener: (method: string, params: Record<string, unknown>) => void): () => void;
}

export class LocalServeClient implements LocalCompanionRpc {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  private closed = false;

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (raw, isBinary) => this.receive(raw, isBinary));
    socket.once("close", () => this.failAll(new Error("Hara Serve disconnected")));
    socket.once("error", () => this.failAll(new Error("Hara Serve connection failed")));
  }

  static async connect(home = effectiveHomeDir()): Promise<LocalServeClient> {
    const discovery = readDiscovery(home);
    const socket = new WebSocket(websocketUrl(discovery), {
      followRedirects: false,
      handshakeTimeout: 5_000,
      maxPayload: 300_000,
      perMessageDeflate: false,
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error("Hara Serve connection timed out"));
      }, 5_000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", () => {
        clearTimeout(timer);
        reject(new Error("Hara Serve connection failed"));
      });
    });
    const client = new LocalServeClient(socket);
    await client.call("initialize", {
      capabilities: { client: "hara-mobile-bridge", protocolVersion: 1 },
      token: discovery.token,
    }, 5_000);
    return client;
  }

  onNotification(listener: (method: string, params: Record<string, unknown>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) throw new Error("Hara Serve is disconnected");
    if (!bounded(method, 160) || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30 * 60_000) {
      throw new TypeError("Local Hara Serve request is invalid");
    }
    const id = this.nextId++;
    const response = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Local Hara Serve request timed out"));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
    });
    try {
      this.socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    } catch {
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error("Hara Serve request could not be sent"));
      }
    }
    return await response;
  }

  private receive(raw: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.failAll(new Error("Hara Serve returned an invalid frame"));
      return;
    }
    let message: Record<string, unknown>;
    try {
      const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      if (!text || text.length > 300_000) throw new Error("invalid frame");
      message = JSON.parse(text) as Record<string, unknown>;
    } catch {
      this.failAll(new Error("Hara Serve returned an invalid frame"));
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      const error = message.error as Record<string, unknown> | undefined;
      if (error && typeof error.code === "number") {
        pending.reject(new LocalServeRpcError(error.code));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string" || !message.params || typeof message.params !== "object") return;
    for (const listener of this.listeners) {
      try {
        listener(message.method, message.params as Record<string, unknown>);
      } catch {
        // An observer cannot destabilize the authenticated local transport.
      }
    }
  }

  private failAll(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Hara Serve disconnected"));
    }
    this.pending.clear();
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.socket.terminate();
        resolve();
      }, 1_000);
      this.socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.close(1000, "mobile bridge stopped");
    });
  }
}
