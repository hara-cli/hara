import { randomUUID } from "node:crypto";

import WebSocket, { type RawData } from "ws";

import type { MobileCompanionState } from "./state.js";
import {
  decryptFromPeer,
  encryptionContext,
  encryptForPeer,
  relayConnectionProofPayload,
  relayEnvelopePayload,
  publicKeyThumbprint,
  signPayload,
  verifyPayload,
  type RelayEnvelopeFields,
} from "./security.js";
import {
  MobileCompanionRouter,
  parseCompanionRequest,
} from "./router.js";

type RelayDevice = Readonly<{
  credentialExpiresAt: number;
  credentialVersion: number;
  id: string;
  kind: "desktop" | "mobile";
  platform: "macos" | "windows" | "linux" | "ios" | "android";
  publicKeySpki: string;
  publicKeyThumbprint: string;
}>;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const bounded = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const identifier = (value: unknown): value is string => bounded(value, 160) && value.trim() === value && !/\s/u.test(value);
const base64url = (value: unknown, max = 350_000): value is string =>
  bounded(value, max) && /^[A-Za-z0-9_-]+$/u.test(value);
const timestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

function relayOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "wss:"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) throw new TypeError("Relay URL must use credential-free WSS");
  return url.toString();
}

function parseDevice(value: unknown): RelayDevice | null {
  const device = record(value);
  if (
    !device
    || Object.keys(device).some((key) => ![
      "credentialExpiresAt", "credentialVersion", "id", "kind", "platform", "publicKeySpki", "publicKeyThumbprint",
    ].includes(key))
    || !identifier(device.id)
    || (device.kind !== "desktop" && device.kind !== "mobile")
    || !["macos", "windows", "linux", "ios", "android"].includes(String(device.platform))
    || !Number.isInteger(device.credentialVersion)
    || Number(device.credentialVersion) < 1
    || !timestamp(device.credentialExpiresAt)
    || !base64url(device.publicKeySpki, 2_048)
    || typeof device.publicKeyThumbprint !== "string"
    || !/^[a-f0-9]{64}$/u.test(device.publicKeyThumbprint)
  ) return null;
  return device as unknown as RelayDevice;
}

export class MobileRelayBridge {
  private readonly url: string;
  private socket: WebSocket | null = null;
  private ready = false;
  private stopped = false;
  private processing: Promise<void> = Promise.resolve();
  private closeResolve: (() => void) | null = null;
  private closeReject: ((error: Error) => void) | null = null;
  private readonly closed: Promise<void>;

  constructor(
    relayUrl: string,
    private readonly state: MobileCompanionState,
    private readonly router: MobileCompanionRouter,
    private readonly clock: () => number = Date.now,
  ) {
    this.url = relayOrigin(relayUrl);
    if (state.desktop.credentialExpiresAt <= clock() + 5_000) {
      throw new Error("Hara Desktop device credential has expired");
    }
    this.closed = new Promise<void>((resolve, reject) => {
      this.closeResolve = resolve;
      this.closeReject = reject;
    });
  }

  async start(): Promise<void> {
    if (this.socket) throw new Error("Hara mobile relay is already started");
    const socket = new WebSocket(this.url, {
      followRedirects: false,
      handshakeTimeout: 8_000,
      maxPayload: 400_000,
      perMessageDeflate: false,
    });
    this.socket = socket;
    const authenticated = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Hara Relay authentication timed out")), 10_000);
      const markReady = () => {
        clearTimeout(timer);
        resolve();
      };
      const fail = () => {
        clearTimeout(timer);
        reject(new Error("Hara Relay connection failed"));
      };
      socket.once("error", fail);
      socket.once("close", fail);
      this.markReady = markReady;
    });
    socket.on("message", (raw, isBinary) => {
      this.processing = this.processing
        .then(() => this.receive(raw, isBinary))
        .catch(() => this.stopWithError(new Error("Hara Relay protocol failed safely")));
    });
    socket.once("close", () => {
      this.socket = null;
      if (!this.stopped && this.ready) this.closeReject?.(new Error("Hara Relay disconnected"));
      else this.closeResolve?.();
    });
    socket.once("error", () => {
      if (this.ready && !this.stopped) this.closeReject?.(new Error("Hara Relay connection failed"));
    });
    await authenticated;
  }

  private markReady: () => void = () => {};

  private pairedMobile(deviceId: string) {
    return this.state.pairedMobileDevices.find((device) => device.id === deviceId);
  }

  async waitUntilClosed(): Promise<void> {
    return await this.closed;
  }

  private send(value: unknown): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error("Hara Relay is disconnected");
    this.socket.send(JSON.stringify(value));
  }

  private async receive(raw: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) throw new Error("Relay requires text frames");
    const text = Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
    if (!text || text.length > 400_000) throw new Error("Relay frame is invalid");
    const message = record(JSON.parse(text));
    if (!message || message.protocolVersion !== 1 || typeof message.type !== "string") {
      throw new Error("Relay frame is invalid");
    }
    if (message.type === "relay.challenge") {
      if (!identifier(message.connectionId) || !base64url(message.nonce, 128) || !timestamp(message.expiresAt) || message.expiresAt <= this.clock()) {
        throw new Error("Relay challenge is invalid");
      }
      const proofSignature = signPayload(
        this.state.desktop.key.privateKeyPem,
        relayConnectionProofPayload({
          connectionId: message.connectionId,
          credential: this.state.desktop.credential,
          nonce: message.nonce,
        }),
      );
      this.send({
        credential: this.state.desktop.credential,
        proofSignature,
        protocolVersion: 1,
        type: "relay.authenticate",
      });
      return;
    }
    if (message.type === "relay.ready") {
      const device = parseDevice(message.device);
      if (
        !device
        || device.id !== this.state.desktop.id
        || device.kind !== "desktop"
        || device.publicKeySpki !== this.state.desktop.key.publicKeySpki
        || device.publicKeyThumbprint !== publicKeyThumbprint(this.state.desktop.key.publicKeySpki)
        || !timestamp(message.serverTime)
      ) {
        throw new Error("Relay identity is invalid");
      }
      if (!Array.isArray(message.peers) || message.peers.length > 32) {
        throw new Error("Relay peer directory is invalid");
      }
      for (const rawPeer of message.peers) {
        const peer = parseDevice(rawPeer);
        if (!peer) throw new Error("Relay peer directory is invalid");
        const paired = this.pairedMobile(peer.id);
        if (
          paired
          && (peer.kind !== "mobile"
            || peer.publicKeySpki !== paired.publicKeySpki
            || peer.publicKeyThumbprint !== paired.publicKeyThumbprint)
        ) throw new Error("Relay peer identity changed");
      }
      this.ready = true;
      this.markReady();
      return;
    }
    if (!this.ready) throw new Error("Relay message arrived before authentication");
    if (message.type === "relay.presence") {
      const device = parseDevice(message.device);
      if (!device || typeof message.online !== "boolean") {
        throw new Error("Relay presence is invalid");
      }
      const paired = this.pairedMobile(device.id);
      if (
        paired
        && (device.kind !== "mobile"
          || device.publicKeySpki !== paired.publicKeySpki
          || device.publicKeyThumbprint !== paired.publicKeyThumbprint)
      ) throw new Error("Relay peer identity changed");
      return;
    }
    if (message.type === "relay.receipt") return;
    if (message.type !== "relay.envelope") throw new Error("Relay message type is invalid");
    await this.envelope(message);
  }

  private async envelope(message: Record<string, unknown>): Promise<void> {
    const sender = parseDevice(message.sender);
    const paired = sender ? this.pairedMobile(sender.id) : undefined;
    if (
      !sender
      || sender.kind !== "mobile"
      || !paired
      || sender.publicKeySpki !== paired.publicKeySpki
      || sender.publicKeyThumbprint !== paired.publicKeyThumbprint
      || message.targetDeviceId !== this.state.desktop.id
      || !identifier(message.messageId)
      || !timestamp(message.expiresAt)
      || message.expiresAt <= this.clock()
      || message.expiresAt > this.clock() + 60_000
      || !base64url(message.nonce, 128)
      || !base64url(message.ciphertext)
      || !base64url(message.signature, 256)
    ) throw new Error("Relay envelope is invalid");
    const fields: RelayEnvelopeFields = {
      accountId: this.state.account.id,
      ciphertext: message.ciphertext,
      expiresAt: message.expiresAt,
      messageId: message.messageId,
      nonce: message.nonce,
      senderDeviceId: sender.id,
      targetDeviceId: this.state.desktop.id,
    };
    if (!verifyPayload(sender.publicKeySpki, relayEnvelopePayload(fields), message.signature)) {
      throw new Error("Relay envelope signature is invalid");
    }
    const plaintext = decryptFromPeer(
      this.state.desktop.key.privateKeyPem,
      sender.publicKeySpki,
      encryptionContext(this.state.account.id, sender.id, this.state.desktop.id),
      message.ciphertext,
      message.nonce,
    );
    if (Buffer.byteLength(plaintext, "utf8") > 256_000) throw new Error("Relay plaintext is invalid");
    const request = parseCompanionRequest(JSON.parse(plaintext));
    if (!request) throw new Error("Companion request is invalid");
    const response = await this.router.route(request);
    await this.sendResponse(sender, response);
  }

  private async sendResponse(sender: RelayDevice, response: unknown): Promise<void> {
    const plaintext = JSON.stringify(response);
    const encrypted = encryptForPeer(
      this.state.desktop.key.privateKeyPem,
      sender.publicKeySpki,
      encryptionContext(this.state.account.id, sender.id, this.state.desktop.id),
      plaintext,
    );
    const fields: RelayEnvelopeFields = {
      accountId: this.state.account.id,
      ciphertext: encrypted.ciphertext,
      expiresAt: this.clock() + 30_000,
      messageId: `message_${randomUUID()}`,
      nonce: encrypted.nonce,
      senderDeviceId: this.state.desktop.id,
      targetDeviceId: sender.id,
    };
    this.send({
      ciphertext: fields.ciphertext,
      expiresAt: fields.expiresAt,
      messageId: fields.messageId,
      nonce: fields.nonce,
      protocolVersion: 1,
      signature: signPayload(this.state.desktop.key.privateKeyPem, relayEnvelopePayload(fields)),
      targetDeviceId: fields.targetDeviceId,
      type: "relay.forward",
    });
  }

  private stopWithError(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    this.closeReject?.(error);
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      this.socket.close(4400, "protocol failure");
    }
  }

  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    await this.router.close();
    const socket = this.socket;
    if (!socket || socket.readyState === WebSocket.CLOSED) {
      this.closeResolve?.();
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 1_000);
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.close(1000, "mobile bridge stopped");
    });
    this.closeResolve?.();
  }
}
