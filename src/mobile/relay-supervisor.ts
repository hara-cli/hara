import { MobileAccountClient } from "./account-client.js";
import { LocalServeClient } from "./local-serve-client.js";
import { MobilePairingCoordinator } from "./pairing.js";
import { MobileRelayBridge } from "./relay-bridge.js";
import { MobileCompanionRouter } from "./router.js";
import {
  loadMobileState,
  mobilePublicationEntries,
  saveMobileState,
  type MobileCompanionState,
} from "./state.js";

const ACCOUNT_ORIGIN = "https://api.hara.nanhara.tech";
const RELAY_URL = "wss://relay.hara.nanhara.tech/v1/connect";
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([1_000, 2_000, 5_000, 10_000, 30_000]);

export type MobileRelayConnectionState =
  | "waiting"
  | "connecting"
  | "online"
  | "retrying"
  | "unavailable"
  | "stopped";

export type MobileRelayReason =
  | "starting"
  | "not_signed_in"
  | "not_paired"
  | "account_unavailable"
  | "credential_refresh_failed"
  | "relay_disabled"
  | "relay_unavailable"
  | "relay_disconnected"
  | "identity_changed"
  | null;

export type MobileRelayStatus = Readonly<{
  connectionState: MobileRelayConnectionState;
  managedByServe: true;
  reason: MobileRelayReason;
  retryAt: number | null;
  updatedAt: number;
}>;

export interface MobileRelayConnection {
  close(): Promise<void>;
  waitUntilClosed(): Promise<void>;
}

type MobileRelaySupervisorOptions = Readonly<{
  accountCapabilities?: () => Promise<Readonly<{ sessionRelay: boolean }>>;
  capabilityRecheckMs?: number;
  currentState?: () => Promise<MobileCompanionState>;
  loadState?: () => MobileCompanionState | null;
  log?: (message: string) => void;
  now?: () => number;
  openConnection?: (state: MobileCompanionState) => Promise<MobileRelayConnection>;
  pollIntervalMs?: number;
  retryDelaysMs?: readonly number[];
}>;

function sameDesktop(
  left: MobileCompanionState | null,
  right: MobileCompanionState,
): left is MobileCompanionState {
  return !!left
    && left.account.id === right.account.id
    && left.account.region === right.account.region
    && left.desktop.id === right.desktop.id;
}

/** A content-free fingerprint for deciding when Relay must re-authenticate. */
function relayIdentity(state: MobileCompanionState | null): string | null {
  if (!state) return null;
  const peers = state.pairedMobileDevices
    .map((device) => `${device.id}:${device.publicKeyThumbprint}`)
    .sort();
  return JSON.stringify({
    accountId: state.account.id,
    accountRegion: state.account.region,
    credentialExpiresAt: state.desktop.credentialExpiresAt,
    desktopId: state.desktop.id,
    peers,
  });
}

async function openDefaultConnection(
  initialState: MobileCompanionState,
): Promise<MobileRelayConnection> {
  const local = await LocalServeClient.connect();
  let router: MobileCompanionRouter | null = null;
  let bridge: MobileRelayBridge | null = null;
  try {
    router = new MobileCompanionRouter(
      local,
      initialState.desktop.id,
      initialState.desktop.credentialExpiresAt,
      {
        commandReceipts: initialState.commandReceipts,
        persistCommandReceipts: (commandReceipts) => {
          const latest = loadMobileState();
          if (!sameDesktop(latest, initialState)) return;
          saveMobileState({ ...latest, commandReceipts });
        },
        publishedSessions: () => {
          const latest = loadMobileState();
          return sameDesktop(latest, initialState)
            ? mobilePublicationEntries(latest)
            : [];
        },
      },
    );
    bridge = new MobileRelayBridge(
      RELAY_URL,
      initialState,
      router,
      Date.now,
      (relayCursor) => {
        const latest = loadMobileState();
        if (!sameDesktop(latest, initialState)) return;
        saveMobileState({ ...latest, relayCursor });
      },
    );
    await bridge.start();
  } catch (error) {
    await bridge?.close().catch(() => undefined);
    await router?.close().catch(() => undefined);
    await local.close().catch(() => undefined);
    throw error;
  }

  const activeBridge = bridge;
  let closing: Promise<void> | null = null;
  return Object.freeze({
    close: async (): Promise<void> => {
      closing ??= (async () => {
        // Closing the private loopback client first makes Serve release every owned terminal stream and
        // guarantees router cleanup cannot wait on an RPC after server.shutdown has closed admission.
        await local.close().catch(() => undefined);
        await activeBridge.close().catch(() => undefined);
      })();
      await closing;
    },
    waitUntilClosed: () => activeBridge.waitUntilClosed(),
  });
}

function positiveInterval(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) >= 1
    ? Math.floor(Number(value))
    : fallback;
}

function retrySchedule(value: readonly number[] | undefined): readonly number[] {
  if (!value?.length || value.some((item) => !Number.isFinite(item) || item < 1)) {
    return DEFAULT_RETRY_DELAYS_MS;
  }
  return Object.freeze(value.map((item) => Math.floor(item)));
}

/**
 * Keeps Desktop's encrypted Mobile Relay connection aligned with private local pairing state.
 * It owns transport lifecycle only: the per-Session publication allowlist remains an independent,
 * dynamic user decision inside MobileCompanionRouter.
 */
export class MobileRelaySupervisor {
  private readonly accountCapabilities: () => Promise<Readonly<{ sessionRelay: boolean }>>;
  private activeConnection: MobileRelayConnection | null = null;
  private readonly capabilityRecheckMs: number;
  private readonly currentState: () => Promise<MobileCompanionState>;
  private readonly loadState: () => MobileCompanionState | null;
  private readonly log: (message: string) => void;
  private loop: Promise<void> | null = null;
  private readonly now: () => number;
  private readonly openConnection: (state: MobileCompanionState) => Promise<MobileRelayConnection>;
  private readonly pollIntervalMs: number;
  private readonly retryDelaysMs: readonly number[];
  private retryIndex = 0;
  private stopping = false;
  private currentStatus: MobileRelayStatus;
  private readonly wakeWaiters = new Set<() => void>();

  constructor(options: MobileRelaySupervisorOptions = {}) {
    const account = new MobileAccountClient(ACCOUNT_ORIGIN);
    const pairing = new MobilePairingCoordinator();
    this.accountCapabilities = options.accountCapabilities ?? (() => account.capabilities());
    this.capabilityRecheckMs = positiveInterval(options.capabilityRecheckMs, 30_000);
    this.currentState = options.currentState ?? (() => pairing.currentState());
    this.loadState = options.loadState ?? (() => loadMobileState());
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.openConnection = options.openConnection ?? openDefaultConnection;
    this.pollIntervalMs = positiveInterval(options.pollIntervalMs, 2_000);
    this.retryDelaysMs = retrySchedule(options.retryDelaysMs);
    this.currentStatus = Object.freeze({
      connectionState: "waiting",
      managedByServe: true,
      reason: "starting",
      retryAt: null,
      updatedAt: this.now(),
    });
  }

  status(): MobileRelayStatus {
    return this.currentStatus;
  }

  start(): void {
    if (this.loop || this.stopping) return;
    this.loop = this.run().catch(() => {
      this.transition("stopped", null, null);
    });
  }

  async close(): Promise<void> {
    if (this.stopping) {
      await this.loop;
      return;
    }
    this.stopping = true;
    this.wake();
    await this.loop;
    if (!this.loop) this.transition("stopped", null, null);
  }

  private transition(
    connectionState: MobileRelayConnectionState,
    reason: MobileRelayReason,
    retryAt: number | null,
  ): void {
    const prior = this.currentStatus;
    if (
      prior.connectionState === connectionState
      && prior.reason === reason
      && prior.retryAt === retryAt
    ) return;
    this.currentStatus = Object.freeze({
      connectionState,
      managedByServe: true,
      reason,
      retryAt,
      updatedAt: this.now(),
    });
    if (
      prior.connectionState !== connectionState
      || prior.reason !== reason
    ) {
      this.log(`hara: mobile relay ${connectionState}${reason ? ` (${reason})` : ""}`);
    }
  }

  private wake(): void {
    for (const resolve of this.wakeWaiters) resolve();
    this.wakeWaiters.clear();
  }

  private async wait(milliseconds: number): Promise<void> {
    if (this.stopping) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.wakeWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      this.wakeWaiters.add(done);
    });
  }

  private async retry(reason: MobileRelayReason): Promise<void> {
    const index = Math.min(this.retryIndex, this.retryDelaysMs.length - 1);
    const delay = this.retryDelaysMs[index];
    this.retryIndex = Math.min(this.retryIndex + 1, this.retryDelaysMs.length - 1);
    this.transition("retrying", reason, this.now() + delay);
    await this.wait(delay);
  }

  private async run(): Promise<void> {
    try {
      while (!this.stopping) {
        const stored = this.loadState();
        if (!stored) {
          this.retryIndex = 0;
          this.transition("waiting", "not_signed_in", null);
          await this.wait(this.pollIntervalMs);
          continue;
        }
        if (stored.pairedMobileDevices.length === 0) {
          this.retryIndex = 0;
          this.transition("waiting", "not_paired", null);
          await this.wait(this.pollIntervalMs);
          continue;
        }

        let capabilities: Readonly<{ sessionRelay: boolean }>;
        try {
          capabilities = await this.accountCapabilities();
        } catch {
          await this.retry("account_unavailable");
          continue;
        }
        if (!capabilities.sessionRelay) {
          this.retryIndex = 0;
          const retryAt = this.now() + this.capabilityRecheckMs;
          this.transition("unavailable", "relay_disabled", retryAt);
          await this.wait(this.capabilityRecheckMs);
          continue;
        }

        let current: MobileCompanionState;
        try {
          current = await this.currentState();
        } catch {
          await this.retry("credential_refresh_failed");
          continue;
        }
        if (current.pairedMobileDevices.length === 0) continue;
        if (this.stopping) break;

        this.transition("connecting", null, null);
        let connection: MobileRelayConnection;
        try {
          connection = await this.openConnection(current);
        } catch {
          await this.retry("relay_unavailable");
          continue;
        }
        this.activeConnection = connection;
        const connectedAt = this.now();
        let checkedCapabilitiesAt = connectedAt;
        let reconnectReason: MobileRelayReason = "relay_disconnected";
        let reconnectImmediately = false;
        this.transition("online", null, null);
        const closed = connection.waitUntilClosed().then(
          () => "closed" as const,
          () => "failed" as const,
        );

        while (!this.stopping) {
          const renewIn = Math.max(
            1,
            current.desktop.credentialExpiresAt - this.now() - 60_000,
          );
          const outcome = await Promise.race([
            closed,
            this.wait(Math.min(this.pollIntervalMs, renewIn)).then(() => "inspect" as const),
          ]);
          if (this.stopping) break;
          if (outcome !== "inspect") break;

          const latest = this.loadState();
          if (relayIdentity(latest) !== relayIdentity(current)) {
            reconnectReason = "identity_changed";
            reconnectImmediately = true;
            break;
          }
          if (renewIn <= this.pollIntervalMs) {
            reconnectReason = "identity_changed";
            reconnectImmediately = true;
            break;
          }
          if (this.now() - checkedCapabilitiesAt >= this.capabilityRecheckMs) {
            checkedCapabilitiesAt = this.now();
            try {
              const live = await this.accountCapabilities();
              if (!live.sessionRelay) {
                reconnectReason = "relay_disabled";
                reconnectImmediately = true;
                break;
              }
            } catch {
              // An authenticated Relay connection remains useful during a transient Account probe failure.
            }
          }
        }

        await connection.close().catch(() => undefined);
        if (this.activeConnection === connection) this.activeConnection = null;
        if (this.stopping) break;
        if (reconnectImmediately) {
          this.retryIndex = 0;
          if (reconnectReason === "relay_disabled") {
            const retryAt = this.now() + this.capabilityRecheckMs;
            this.transition("unavailable", reconnectReason, retryAt);
            await this.wait(this.capabilityRecheckMs);
          }
          continue;
        }
        if (this.now() - connectedAt >= this.capabilityRecheckMs) this.retryIndex = 0;
        await this.retry(reconnectReason);
      }
    } finally {
      const active = this.activeConnection;
      this.activeConnection = null;
      await active?.close().catch(() => undefined);
      this.transition("stopped", null, null);
    }
  }
}
