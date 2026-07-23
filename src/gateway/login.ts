import {
  acquireGatewayInstance,
  gatewayRuntimeScope,
  GatewayRuntimeReporter,
} from "./runtime-state.js";
import {
  startWeixinLoginSession,
  type WeixinLoginSession,
  type WeixinLoginSnapshot,
} from "./weixin.js";

export type GatewayLoginSnapshot = WeixinLoginSnapshot;

interface ActiveGatewayLogin {
  session: WeixinLoginSession;
  reporter: GatewayLoginReporter;
  release: () => void;
  settled: Promise<void>;
}

interface GatewayLoginReporter {
  error(code: "platform-error"): void;
  stopped(failed?: boolean): void;
  flush(): Promise<void>;
}

interface GatewayLoginManagerDependencies {
  acquire: (runtimeScope: string) => () => void;
  openReporter: (runtimeScope: string) => Promise<GatewayLoginReporter>;
  startWeixin: (signal: AbortSignal) => Promise<WeixinLoginSession>;
}

const TERMINAL_LOGIN_PHASES = new Set<GatewayLoginSnapshot["phase"]>([
  "confirmed",
  "cancelled",
  "timed-out",
  "failed",
]);

function assertLoginPlatform(value: string): "weixin" {
  const platform = value.trim().toLowerCase();
  if (platform !== "weixin") throw new Error(`interactive login is not supported for '${value}'`);
  return platform;
}

/**
 * Own the one interactive gateway login exposed by `hara serve`.
 *
 * The manager deliberately keeps the login in-process: Desktop receives only a short-lived QR payload and
 * redacted phase snapshots over its authenticated loopback connection. The confirmed bot token is written
 * by the WeChat adapter's private-state boundary and never enters the serve protocol.
 */
export class GatewayLoginManager {
  private active: ActiveGatewayLogin | undefined;
  private latest: GatewayLoginSnapshot | undefined;
  private starting: Promise<GatewayLoginSnapshot> | undefined;
  private startingAbort: AbortController | undefined;
  private closed = false;

  constructor(private readonly dependencies: GatewayLoginManagerDependencies = {
    acquire: (runtimeScope) => acquireGatewayInstance(runtimeScope, { displayPlatform: "weixin" }),
    openReporter: (runtimeScope) => GatewayRuntimeReporter.open(runtimeScope, "weixin"),
    startWeixin: (signal) => startWeixinLoginSession({ signal }),
  }) {}

  async start(platformValue: string): Promise<GatewayLoginSnapshot> {
    assertLoginPlatform(platformValue);
    if (this.closed) throw new Error("gateway login manager is shutting down");
    if (this.active) {
      const existing = this.active.session.snapshot();
      if (!TERMINAL_LOGIN_PHASES.has(existing.phase)) return existing;
      await this.active.settled;
      if (this.closed) throw new Error("gateway login manager is shutting down");
    }
    if (this.starting) return this.starting;

    const controller = new AbortController();
    this.startingAbort = controller;
    const starting = this.startWeixin(controller.signal);
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = undefined;
      if (this.startingAbort === controller) this.startingAbort = undefined;
    }
  }

  status(platformValue: string, id?: string): GatewayLoginSnapshot | undefined {
    assertLoginPlatform(platformValue);
    const snapshot = this.active?.session.snapshot() ?? this.latest;
    if (!snapshot || (id && snapshot.id !== id)) return undefined;
    return snapshot;
  }

  cancel(platformValue: string, id: string): GatewayLoginSnapshot | undefined {
    assertLoginPlatform(platformValue);
    const active = this.active;
    if (!active || active.session.snapshot().id !== id) {
      const previous = this.latest;
      return previous?.id === id ? previous : undefined;
    }
    active.session.cancel();
    return active.session.snapshot();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.startingAbort?.abort();
    try {
      await this.starting;
    } catch {
      // startWeixin owns reporter/lease cleanup for failed or aborted initial requests.
    }
    const active = this.active;
    active?.session.cancel();
    await active?.settled;
  }

  private async startWeixin(signal: AbortSignal): Promise<GatewayLoginSnapshot> {
    const runtimeScope = gatewayRuntimeScope("weixin", "desktop-login");
    const release = this.dependencies.acquire(runtimeScope);
    let reporter: GatewayLoginReporter | undefined;
    try {
      reporter = await this.dependencies.openReporter(runtimeScope);
      const session = await this.dependencies.startWeixin(signal);
      const active = {} as ActiveGatewayLogin;
      active.session = session;
      active.reporter = reporter;
      active.release = release;
      active.settled = this.settle(active);
      this.active = active;
      this.latest = session.snapshot();
      return session.snapshot();
    } catch (error) {
      reporter?.error("platform-error");
      reporter?.stopped(true);
      await reporter?.flush();
      release();
      throw error;
    }
  }

  private async settle(active: ActiveGatewayLogin): Promise<void> {
    let finalSnapshot: GatewayLoginSnapshot;
    try {
      finalSnapshot = await active.session.done;
      this.latest = finalSnapshot;
      if (finalSnapshot.phase === "failed") active.reporter.error("platform-error");
      active.reporter.stopped(finalSnapshot.phase === "failed");
      await active.reporter.flush();
    } finally {
      active.release();
      if (this.active === active) this.active = undefined;
    }
  }
}

export function gatewayLoginIsTerminal(snapshot: GatewayLoginSnapshot): boolean {
  return TERMINAL_LOGIN_PHASES.has(snapshot.phase);
}
