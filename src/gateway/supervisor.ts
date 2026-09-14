import {
  gatewayStatus,
  runGateway,
  type GatewayPlatform,
  type GatewayStatus,
  type RunGatewayOptions,
} from "./serve.js";
import { homedir } from "node:os";
import {
  bindPrivateHaraStateFile,
  readPrivateStateFileSnapshotSync,
  withPrivateStateLockSync,
  writePrivateStateFileSync,
} from "../security/private-state.js";

const DESKTOP_GATEWAYS = new Set<GatewayPlatform>(["weixin", "feishu"]);
const START_OBSERVATION_MS = 2_000;
const STOP_OBSERVATION_MS = 5_000;
const PREFERENCES_FILE = "gateway-managed-connectors.json";
const PREFERENCES_LOCK = "gateway-managed-connectors";
const PREFERENCES_BYTES = 8 * 1024;

interface ManagedGatewayRun {
  controller: AbortController;
  failure?: unknown;
  settled: boolean;
  task: Promise<void>;
}

interface GatewaySupervisorOptions {
  inspect?: (platform: GatewayPlatform) => Promise<GatewayStatus>;
  log?: (message: string) => void;
  run?: (options: RunGatewayOptions) => Promise<void>;
  loadEnabled?: () => Set<GatewayPlatform>;
  saveEnabled?: (platforms: ReadonlySet<GatewayPlatform>) => void;
  wait?: (milliseconds: number) => Promise<void>;
}

function loadEnabledGateways(home: string = homedir()): Set<GatewayPlatform> {
  const target = bindPrivateHaraStateFile(home, [], PREFERENCES_FILE);
  const snapshot = readPrivateStateFileSnapshotSync(target.path, PREFERENCES_BYTES);
  if (!snapshot) return new Set();
  const value = JSON.parse(snapshot.text) as Record<string, unknown>;
  if (!value || Array.isArray(value) || value.version !== 1 || !Array.isArray(value.enabled)) {
    throw new Error("invalid Desktop-managed connector preferences");
  }
  if (
    value.enabled.length > DESKTOP_GATEWAYS.size
    || value.enabled.some((item) => typeof item !== "string" || !DESKTOP_GATEWAYS.has(item as GatewayPlatform))
    || new Set(value.enabled).size !== value.enabled.length
  ) throw new Error("invalid Desktop-managed connector preferences");
  return new Set(value.enabled as GatewayPlatform[]);
}

function saveEnabledGateways(platforms: ReadonlySet<GatewayPlatform>, home: string = homedir()): void {
  withPrivateStateLockSync(home, [], PREFERENCES_LOCK, () => {
    const target = bindPrivateHaraStateFile(home, [], PREFERENCES_FILE);
    const snapshot = readPrivateStateFileSnapshotSync(target.path, PREFERENCES_BYTES);
    const enabled = [...platforms].filter((platform) => DESKTOP_GATEWAYS.has(platform)).sort();
    const text = `${JSON.stringify({ version: 1, enabled }, null, 2)}\n`;
    writePrivateStateFileSync(target, text, snapshot
      ? { expectedText: snapshot.text }
      : { expectedMissing: true });
  }, { busyMessage: "Desktop-managed connector preferences are busy; retry shortly" });
}

function desktopGateway(value: string): GatewayPlatform {
  const platform = value.trim().toLowerCase() === "lark" ? "feishu" : value.trim().toLowerCase();
  if (!DESKTOP_GATEWAYS.has(platform as GatewayPlatform)) {
    throw new Error("Desktop can manage only WeChat and Feishu connectors");
  }
  return platform as GatewayPlatform;
}

/**
 * Owns connectors started from Hara Settings. A connector already running in another process remains visible
 * but cannot be stopped through this instance, so Desktop never sends signals to an unrelated local process.
 */
export class GatewaySupervisor {
  private readonly inspect: (platform: GatewayPlatform) => Promise<GatewayStatus>;
  private readonly enabled: Set<GatewayPlatform>;
  private readonly saveEnabled: (platforms: ReadonlySet<GatewayPlatform>) => void;
  private readonly log: (message: string) => void;
  private readonly operations = new Map<GatewayPlatform, Promise<unknown>>();
  private readonly run: (options: RunGatewayOptions) => Promise<void>;
  private readonly runs = new Map<GatewayPlatform, ManagedGatewayRun>();
  private stopping = false;
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(options: GatewaySupervisorOptions = {}) {
    this.inspect = options.inspect ?? ((platform) => gatewayStatus(platform));
    this.log = options.log ?? (() => undefined);
    this.run = options.run ?? runGateway;
    try {
      this.enabled = options.loadEnabled?.() ?? loadEnabledGateways();
    } catch {
      this.enabled = new Set();
      this.log("hara: Desktop-managed connector preferences are unreadable; automatic restart is disabled");
    }
    this.saveEnabled = options.saveEnabled ?? saveEnabledGateways;
    this.wait = options.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  /** Restore only connectors the local user explicitly started in a previous Desktop session. */
  async resume(): Promise<void> {
    await Promise.all([...this.enabled].map(async (platform) => {
      try {
        await this.start(platform);
      } catch {
        this.log(`hara: Desktop-managed ${platform} connector could not be restored`);
      }
    }));
  }

  async list(platforms: readonly string[] = ["weixin", "feishu"]): Promise<GatewayStatus[]> {
    return Promise.all(platforms.map((platform) => this.status(platform)));
  }

  async status(platformValue: string): Promise<GatewayStatus> {
    const platform = desktopGateway(platformValue);
    return this.annotate(platform, await this.inspect(platform));
  }

  start(platformValue: string): Promise<GatewayStatus> {
    const platform = desktopGateway(platformValue);
    return this.exclusive(platform, () => this.startUnlocked(platform));
  }

  stop(platformValue: string): Promise<GatewayStatus> {
    const platform = desktopGateway(platformValue);
    return this.exclusive(platform, () => this.stopUnlocked(platform));
  }

  async close(): Promise<void> {
    if (this.stopping) {
      await Promise.allSettled([...this.runs.values()].map((entry) => entry.task));
      return;
    }
    this.stopping = true;
    const entries = [...this.runs.values()];
    for (const entry of entries) entry.controller.abort(new Error("Hara Serve is shutting down"));
    await Promise.allSettled(entries.map((entry) => entry.task));
  }

  private annotate(platform: GatewayPlatform, status: GatewayStatus): GatewayStatus {
    return { ...status, managedByServe: this.runs.has(platform) };
  }

  private remember(platform: GatewayPlatform, enabled: boolean): void {
    if (enabled) this.enabled.add(platform);
    else this.enabled.delete(platform);
    try {
      this.saveEnabled(this.enabled);
    } catch {
      this.log("hara: Desktop-managed connector preference could not be saved");
    }
  }

  private exclusive<T>(platform: GatewayPlatform, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(platform) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.operations.set(platform, current);
    void current.finally(() => {
      if (this.operations.get(platform) === current) this.operations.delete(platform);
    }).catch(() => undefined);
    return current;
  }

  private async startUnlocked(platform: GatewayPlatform): Promise<GatewayStatus> {
    if (this.stopping) throw new Error("Hara Serve is shutting down");
    if (this.runs.has(platform)) return this.status(platform);

    const before = await this.inspect(platform);
    if (this.stopping) throw new Error("Hara Serve is shutting down");
    if (before.running) return { ...before, managedByServe: false };
    if (before.configuration !== "ready") {
      throw new Error(`${before.label} is not configured yet`);
    }

    const controller = new AbortController();
    const entry: ManagedGatewayRun = {
      controller,
      settled: false,
      task: Promise.resolve(),
    };
    this.runs.set(platform, entry);
    entry.task = this.run({
      platform,
      signal: controller.signal,
      manageProcessSignals: false,
    }).catch((error) => {
      entry.failure = error;
      this.log(`hara: Desktop-managed ${platform} connector stopped unexpectedly`);
    }).finally(() => {
      entry.settled = true;
      if (this.runs.get(platform) === entry) this.runs.delete(platform);
    });

    const deadline = Date.now() + START_OBSERVATION_MS;
    while (!entry.settled && Date.now() < deadline) {
      const observed = await this.inspect(platform);
      if (observed.running) {
        this.remember(platform, true);
        return { ...observed, managedByServe: true };
      }
      await this.wait(25);
    }
    if (entry.settled) {
      throw new Error(`${before.label} could not start; check its credentials and network connection`);
    }
    this.remember(platform, true);
    return this.annotate(platform, await this.inspect(platform));
  }

  private async stopUnlocked(platform: GatewayPlatform): Promise<GatewayStatus> {
    const entry = this.runs.get(platform);
    this.remember(platform, false);
    if (!entry) {
      const observed = await this.inspect(platform);
      if (observed.running) {
        throw new Error(`${observed.label} is running outside Hara Desktop and must be stopped by its owner`);
      }
      return { ...observed, managedByServe: false };
    }
    entry.controller.abort(new Error("Stopped from Hara Settings"));
    await Promise.race([
      entry.task,
      this.wait(STOP_OBSERVATION_MS),
    ]);
    return this.status(platform);
  }
}
