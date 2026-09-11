import { createHash, randomUUID } from "node:crypto";

import type { LocalCompanionRpc } from "./local-serve-client.js";
import type { MobileCommandReceipt } from "./state.js";

const MAX_SESSIONS = 100;
const MAX_MESSAGE_TEXT = 32_768;
const MAX_COMMAND_RECEIPTS = 64;

type CapabilityName = "read" | "submit" | "approve" | "interrupt" | "terminalObserve" | "terminalControl";
type PublishedCapabilities = Record<CapabilityName, boolean>;

type Publication = {
  capabilities: PublishedCapabilities;
  expiresAt: number;
  id: string;
  sessionId: string;
  sourceId: "codex" | "claude" | "runtime";
};

type TerminalLease = {
  expiresAt: number;
  handoffFrozen: boolean;
  inputSequence: number;
  leaseId: string;
  publicationId: string;
  streamId: string;
};

type CommandReceiptBody = MobileCommandReceipt["receipt"];

type CompanionRequest = Readonly<{
  body: unknown;
  method: "sessions.list" | "sessions.read" | "terminal.snapshot" | "terminal.control" | "command.execute" | "command.status";
  protocolVersion: 1;
  requestId: string;
  type: "companion.request";
}>;

export type CompanionResponse = Readonly<{
  body?: unknown;
  errorCode?: string;
  ok: boolean;
  protocolVersion: 1;
  requestId: string;
  type: "companion.response";
}>;

const bounded = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;
const identifier = (value: unknown): value is string => bounded(value, 160) && value.trim() === value && !/\s/u.test(value);
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const safeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function parseCompanionRequest(value: unknown): CompanionRequest | null {
  const input = record(value);
  if (!input || Object.keys(input).some((key) => !["body", "method", "protocolVersion", "requestId", "type"].includes(key))) {
    return null;
  }
  if (
    input.type !== "companion.request"
    || input.protocolVersion !== 1
    || !identifier(input.requestId)
    || !["sessions.list", "sessions.read", "terminal.snapshot", "terminal.control", "command.execute", "command.status"].includes(String(input.method))
  ) return null;
  return input as unknown as CompanionRequest;
}

const ok = (requestId: string, body: unknown): CompanionResponse => ({
  body,
  ok: true,
  protocolVersion: 1,
  requestId,
  type: "companion.response",
});
const failed = (requestId: string, errorCode: string): CompanionResponse => ({
  errorCode,
  ok: false,
  protocolVersion: 1,
  requestId,
  type: "companion.response",
});

function sourceCapabilities(value: unknown): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(value)) return result;
  for (const raw of value) {
    const source = record(raw);
    const capabilities = record(source?.capabilities);
    if (source && capabilities && ["codex", "claude", "runtime"].includes(String(source.id))) {
      result.set(String(source.id), capabilities);
    }
  }
  return result;
}

function sessionState(value: unknown): "running" | "needs_input" | "completed" | "failed" | "offline" {
  switch (value) {
    case "working": return "running";
    case "waiting": return "needs_input";
    case "error": return "failed";
    case "stored": return "offline";
    default: return "completed";
  }
}

function engine(sourceId: Publication["sourceId"]): "hara" | "codex" | "claude-code" {
  return sourceId === "runtime" ? "hara" : sourceId === "claude" ? "claude-code" : "codex";
}

function canonicalBase64(value: unknown): Buffer | null {
  if (typeof value !== "string" || !value || value.length > 65_536 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return null;
  }
  const bytes = Buffer.from(value, "base64");
  return bytes.toString("base64") === value ? bytes : null;
}

export class MobileCompanionRouter {
  readonly leaseEpoch: number;
  private readonly publications = new Map<string, Publication>();
  private readonly leases = new Map<string, TerminalLease>();
  private readonly grants = new Map<string, unknown>();
  private readonly receipts = new Map<string, MobileCommandReceipt>();
  private readonly terminalInputTails = new Map<string, Promise<void>>();
  private readonly activeTurns = new Map<string, string>();
  private readonly runningSubmits = new Set<string>();
  private readonly approvals = new Map<string, { publicationId: string; question: string }>();
  private readonly removeNotificationListener: () => void;

  constructor(
    private readonly local: LocalCompanionRpc,
    private readonly desktopDeviceId: string,
    private readonly publicationExpiresAt: number,
    options: Readonly<{
      clock?: () => number;
      commandReceipts?: readonly MobileCommandReceipt[];
      persistCommandReceipts?: (receipts: readonly MobileCommandReceipt[]) => void;
    }> = {},
  ) {
    if (!identifier(desktopDeviceId) || !safeInteger(publicationExpiresAt)) {
      throw new TypeError("mobile companion router identity is invalid");
    }
    this.clock = options.clock ?? Date.now;
    this.persistCommandReceipts = options.persistCommandReceipts;
    this.leaseEpoch = this.clock();
    for (const entry of options.commandReceipts ?? []) {
      if (entry.expiresAt > this.clock()) this.receipts.set(entry.commandId, entry);
    }
    this.removeNotificationListener = local.onNotification((method, params) => this.notification(method, params));
  }

  private readonly clock: () => number;
  private readonly persistCommandReceipts?: (receipts: readonly MobileCommandReceipt[]) => void;

  private notification(method: string, params: Record<string, unknown>): void {
    if (
      method === "external.event.terminal.handoff_requested"
      && identifier(params.streamId)
      && identifier(params.handoffId)
    ) {
      const lease = [...this.leases.values()].find((candidate) => candidate.streamId === params.streamId);
      if (!lease) return;
      lease.handoffFrozen = true;
      const tail = this.terminalInputTails.get(lease.streamId) ?? Promise.resolve();
      void tail.then(() => this.local.call("external.sessions.terminal.handoff-ready", {
        handoffId: params.handoffId,
        streamId: lease.streamId,
        throughInputSeq: lease.inputSequence - 1,
      })).catch(() => {
        lease.handoffFrozen = false;
      });
      return;
    }
    if (
      method === "external.event.terminal.handoff_cancelled"
      && identifier(params.streamId)
    ) {
      const lease = [...this.leases.values()].find((candidate) => candidate.streamId === params.streamId);
      if (lease) lease.handoffFrozen = false;
      return;
    }
    if (method === "external.event.turn_start" && identifier(params.sessionId) && identifier(params.turnId)) {
      this.activeTurns.set(params.sessionId, params.turnId);
      return;
    }
    if (method === "external.event.turn_end" && identifier(params.sessionId)) {
      this.activeTurns.delete(params.sessionId);
      this.runningSubmits.delete(params.sessionId);
      return;
    }
    if (
      method === "external.approval.request"
      && identifier(params.sessionId)
      && identifier(params.approvalId)
      && bounded(params.question, 2_000)
    ) {
      const publication = [...this.publications.values()].find((entry) => entry.sessionId === params.sessionId);
      if (publication) {
        this.approvals.set(params.approvalId, {
          publicationId: publication.id,
          question: params.question,
        });
      }
    }
  }

  private publicationId(sessionId: string): string {
    return `pub_${createHash("sha256")
      .update(this.desktopDeviceId, "utf8")
      .update("\0", "utf8")
      .update(sessionId, "utf8")
      .digest("base64url")
      .slice(0, 40)}`;
  }

  private async listPublishedSessions(): Promise<unknown[]> {
    const result = record(await this.local.call("external.sessions.list", { limit: MAX_SESSIONS }));
    if (!result || !Array.isArray(result.sessions)) throw new Error("invalid local session directory");
    const sources = sourceCapabilities(result.sources);
    const next = new Map<string, Publication>();
    const published: unknown[] = [];
    for (const raw of result.sessions.slice(0, MAX_SESSIONS)) {
      const session = record(raw);
      if (
        !session
        || !identifier(session.id)
        || !["codex", "claude", "runtime"].includes(String(session.sourceId))
        || !bounded(session.title, 240)
        || !bounded(session.workspaceName, 160)
        || !bounded(session.updatedAt, 120)
      ) continue;
      const sourceId = session.sourceId as Publication["sourceId"];
      const source = sources.get(sourceId) ?? {};
      const terminalObserve = sourceId === "runtime" && source.terminalView === true;
      const capabilities: PublishedCapabilities = {
        approve: source.submit === true,
        interrupt: source.interrupt === true,
        read: source.read === true,
        submit: source.submit === true,
        terminalControl: terminalObserve && source.terminalInput === true,
        terminalObserve,
      };
      const publication: Publication = {
        capabilities,
        expiresAt: this.publicationExpiresAt,
        id: this.publicationId(session.id),
        sessionId: session.id,
        sourceId,
      };
      next.set(publication.id, publication);
      published.push({
        capabilities,
        engine: engine(sourceId),
        id: session.id,
        leaseEpoch: this.leaseEpoch,
        publicationExpiresAt: publication.expiresAt,
        publicationId: publication.id,
        status: sessionState(session.state),
        title: session.title,
        updatedAtLabel: String(session.updatedAt).replace("T", " ").slice(0, 16),
        workspaceLabel: session.workspaceName,
      });
    }
    this.publications.clear();
    for (const [key, value] of next) this.publications.set(key, value);
    return published;
  }

  private async publication(value: unknown): Promise<Publication | null> {
    if (!identifier(value)) return null;
    let publication = this.publications.get(value);
    if (!publication) {
      await this.listPublishedSessions();
      publication = this.publications.get(value);
    }
    if (!publication || publication.expiresAt <= this.clock()) return null;
    return publication;
  }

  private async readSession(publication: Publication): Promise<unknown> {
    if (!publication.capabilities.read) throw new Error("capability denied");
    const result = record(await this.local.call("external.sessions.read", { sessionId: publication.sessionId }));
    if (!result || !Array.isArray(result.messages)) throw new Error("invalid local session");
    const messages: unknown[] = [];
    let retainedCharacters = 0;
    for (const raw of result.messages.slice(-100)) {
      const message = record(raw);
      if (!message || !identifier(message.id) || !["user", "assistant", "notice"].includes(String(message.role)) || typeof message.text !== "string") continue;
      const text = message.text.slice(0, MAX_MESSAGE_TEXT);
      if (retainedCharacters + text.length > 200_000) break;
      retainedCharacters += text.length;
      messages.push({ id: message.id, role: message.role, text });
    }
    const pendingApprovals = [...this.approvals.entries()]
      .filter(([, value]) => value.publicationId === publication.id)
      .slice(0, 10)
      .map(([approvalId, value]) => ({ approvalId, question: value.question }));
    return {
      controlMode: result.controlMode === "live" || result.controlMode === "managed" ? result.controlMode : "history",
      leaseEpoch: this.leaseEpoch,
      messages,
      pendingApprovals,
      publicationId: publication.id,
      readOnly: result.readOnly === true,
      schemaVersion: 1,
    };
  }

  private async terminalSnapshot(publication: Publication): Promise<unknown> {
    if (!publication.capabilities.terminalObserve) throw new Error("capability denied");
    const result = record(await this.local.call("external.sessions.terminal.snapshot", {
      sessionId: publication.sessionId,
    }));
    if (!result || typeof result.text !== "string" || result.text.length > 256_000 || !bounded(result.updatedAt, 120)) {
      throw new Error("invalid terminal snapshot");
    }
    return {
      leaseEpoch: this.leaseEpoch,
      publicationId: publication.id,
      schemaVersion: 1,
      state: ["stored", "idle", "working", "waiting", "error", "unknown"].includes(String(result.state))
        ? result.state
        : "unknown",
      text: result.text,
      updatedAt: result.updatedAt,
    };
  }

  private validCommandFields(body: Record<string, unknown>, publication: Publication): boolean {
    return body.schemaVersion === 1
      && identifier(body.commandId)
      && safeInteger(body.expiresAt)
      && body.expiresAt > this.clock()
      && body.expiresAt <= publication.expiresAt
      && body.leaseEpoch === this.leaseEpoch
      && body.publicationId === publication.id;
  }

  private receipt(commandId: string, status: "accepted" | "succeeded" | "failed", errorCode: string | null = null): CommandReceiptBody {
    return { commandId, errorCode, schemaVersion: 1, status };
  }

  private saveReceipt(commandId: string, expiresAt: number, fingerprint: string, receipt: CommandReceiptBody): void {
    const observedAt = this.clock();
    for (const [id, entry] of this.receipts) {
      if (entry.expiresAt <= observedAt) this.receipts.delete(id);
    }
    this.receipts.delete(commandId);
    this.receipts.set(commandId, { commandId, expiresAt, fingerprint, receipt, recordedAt: observedAt });
    while (this.receipts.size > MAX_COMMAND_RECEIPTS) this.receipts.delete(this.receipts.keys().next().value!);
    this.persistCommandReceipts?.([...this.receipts.values()]);
  }

  private activeLease(publication: Publication, leaseId: unknown): TerminalLease | null {
    const lease = this.leases.get(publication.id);
    if (!lease || lease.leaseId !== leaseId || lease.expiresAt <= this.clock()) return null;
    return lease;
  }

  private async writeTerminalInput(lease: TerminalLease, text: string): Promise<void> {
    const previous = this.terminalInputTails.get(lease.streamId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const response = record(await this.local.call("external.sessions.terminal.raw-input", {
        inputSeq: lease.inputSequence,
        streamId: lease.streamId,
        text,
      }));
      if (!response || response.accepted !== true || !Number.isSafeInteger(response.nextInputSeq)) {
        throw new Error("terminal input failed");
      }
      lease.inputSequence = Number(response.nextInputSeq);
    });
    const tail = operation.then(() => undefined, () => undefined);
    this.terminalInputTails.set(lease.streamId, tail);
    try {
      await operation;
    } finally {
      if (this.terminalInputTails.get(lease.streamId) === tail) {
        this.terminalInputTails.delete(lease.streamId);
      }
    }
  }

  private async terminalControl(raw: unknown): Promise<unknown> {
    const body = record(raw);
    const publication = body ? await this.publication(body.publicationId) : null;
    if (
      !body
      || !publication
      || !this.validCommandFields(body, publication)
      || !Number.isInteger(body.requestedDurationMs)
      || Number(body.requestedDurationMs) < 10_000
      || Number(body.requestedDurationMs) > 300_000
      || !publication.capabilities.terminalControl
    ) throw new Error("terminal control denied");
    const existing = this.grants.get(body.commandId as string);
    if (existing) return existing;
    const previous = this.leases.get(publication.id);
    if (previous) {
      await (this.terminalInputTails.get(previous.streamId) ?? Promise.resolve());
      await this.local.call("external.sessions.terminal.release", { streamId: previous.streamId }).catch(() => undefined);
      this.terminalInputTails.delete(previous.streamId);
    }
    const attached = record(await this.local.call("external.sessions.terminal.attach", {
      cols: 88,
      mode: "control",
      rows: 28,
      sessionId: publication.sessionId,
      takeover: true,
    }));
    if (!attached || !identifier(attached.streamId) || attached.mode !== "control") throw new Error("terminal control failed");
    const lease: TerminalLease = {
      expiresAt: Math.min(this.clock() + Number(body.requestedDurationMs), publication.expiresAt),
      handoffFrozen: false,
      inputSequence: Number.isInteger(attached.nextInputSeq) ? Number(attached.nextInputSeq) : 1,
      leaseId: `lease_${randomUUID()}`,
      publicationId: publication.id,
      streamId: attached.streamId,
    };
    this.leases.set(publication.id, lease);
    const grant = {
      expiresAt: lease.expiresAt,
      leaseEpoch: this.leaseEpoch,
      leaseId: lease.leaseId,
      publicationId: publication.id,
      schemaVersion: 1,
    };
    this.grants.set(body.commandId as string, grant);
    return grant;
  }

  private async executeCommand(raw: unknown): Promise<unknown> {
    const body = record(raw);
    const commandId = body && identifier(body.commandId) ? body.commandId : "invalid-command";
    const publication = body ? await this.publication(body.publicationId) : null;
    if (!body || !publication) return this.receipt(commandId, "failed", "PUBLICATION_NOT_FOUND");
    const fingerprint = createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex");
    const prior = this.receipts.get(commandId);
    if (prior) {
      return prior.fingerprint === fingerprint
        ? prior.receipt
        : this.receipt(commandId, "failed", "COMMAND_ID_COLLISION");
    }
    let result: unknown;
    if (!this.validCommandFields(body, publication)) {
      result = this.receipt(commandId, "failed", body.leaseEpoch === this.leaseEpoch ? "COMMAND_EXPIRED" : "STALE_EPOCH");
    } else if (body.kind === "submit") {
      const payload = record(body.payload);
      if (!publication.capabilities.submit || !payload || !bounded(payload.text, 32_768)) {
        result = this.receipt(commandId, "failed", "CAPABILITY_DENIED");
      } else {
        const activeTurnId = this.activeTurns.get(publication.sessionId);
        if (activeTurnId) {
          await this.local.call("external.sessions.steer", {
            commandId,
            expectedTurnId: activeTurnId,
            sessionId: publication.sessionId,
            text: payload.text,
          });
          result = this.receipt(commandId, "succeeded");
        } else if (this.runningSubmits.has(publication.sessionId)) {
          result = this.receipt(commandId, "failed", "SESSION_BUSY");
        } else {
          this.runningSubmits.add(publication.sessionId);
          void this.local.call("external.sessions.submit", {
            commandId,
            sessionId: publication.sessionId,
            text: payload.text,
          }, 30 * 60_000).finally(() => {
            this.runningSubmits.delete(publication.sessionId);
            this.activeTurns.delete(publication.sessionId);
          }).catch(() => undefined);
          result = this.receipt(commandId, "accepted");
        }
      }
    } else if (body.kind === "interrupt") {
      if (!publication.capabilities.interrupt) {
        result = this.receipt(commandId, "failed", "CAPABILITY_DENIED");
      } else {
        await this.local.call("external.sessions.interrupt", {
          commandId,
          ...(this.activeTurns.has(publication.sessionId)
            ? { expectedTurnId: this.activeTurns.get(publication.sessionId) }
            : {}),
          sessionId: publication.sessionId,
        });
        result = this.receipt(commandId, "succeeded");
      }
    } else if (body.kind === "approval") {
      const payload = record(body.payload);
      const lease = payload ? this.activeLease(publication, payload.leaseId) : null;
      const approval = payload && identifier(payload.approvalId) ? this.approvals.get(payload.approvalId) : null;
      if (!publication.capabilities.approve || !payload || !lease || !approval || approval.publicationId !== publication.id) {
        result = this.receipt(commandId, "failed", "CONTROL_LEASE_INVALID");
      } else if (payload.decision !== "approve" && payload.decision !== "reject") {
        result = this.receipt(commandId, "failed", "CAPABILITY_DENIED");
      } else {
        const approvalId = payload.approvalId as string;
        await this.local.call("approval.reply", {
          allow: payload.decision === "approve",
          approvalId,
        });
        this.approvals.delete(approvalId);
        result = this.receipt(commandId, "succeeded");
      }
    } else if (body.kind === "terminal_input") {
      const payload = record(body.payload);
      const lease = payload ? this.activeLease(publication, payload.leaseId) : null;
      const bytes = payload ? canonicalBase64(payload.dataBase64) : null;
      if (!publication.capabilities.terminalControl || !lease || !bytes) {
        result = this.receipt(commandId, "failed", "CONTROL_LEASE_INVALID");
      } else if (lease.handoffFrozen) {
        result = this.receipt(commandId, "failed", "CONTROL_HANDOFF_PENDING");
      } else {
        const text = bytes.toString("utf8");
        if (!Buffer.from(text, "utf8").equals(bytes)) {
          result = this.receipt(commandId, "failed", "INPUT_INVALID");
        } else {
          await this.writeTerminalInput(lease, text);
          result = this.receipt(commandId, "succeeded");
        }
      }
    } else if (body.kind === "terminal_resize") {
      const payload = record(body.payload);
      const lease = payload ? this.activeLease(publication, payload.leaseId) : null;
      if (
        !lease
        || !Number.isInteger(payload?.columns)
        || Number(payload?.columns) < 1
        || Number(payload?.columns) > 500
        || !Number.isInteger(payload?.rows)
        || Number(payload?.rows) < 1
        || Number(payload?.rows) > 500
      ) {
        result = this.receipt(commandId, "failed", "CONTROL_LEASE_INVALID");
      } else {
        await this.local.call("external.sessions.terminal.resize", {
          cols: payload!.columns,
          rows: payload!.rows,
          streamId: lease.streamId,
        });
        result = this.receipt(commandId, "succeeded");
      }
    } else if (body.kind === "terminal_release") {
      const payload = record(body.payload);
      const lease = payload ? this.activeLease(publication, payload.leaseId) : null;
      if (!lease) {
        result = this.receipt(commandId, "failed", "CONTROL_LEASE_INVALID");
      } else {
        await (this.terminalInputTails.get(lease.streamId) ?? Promise.resolve());
        await this.local.call("external.sessions.terminal.release", { streamId: lease.streamId });
        this.terminalInputTails.delete(lease.streamId);
        this.leases.delete(publication.id);
        result = this.receipt(commandId, "succeeded");
      }
    } else {
      result = this.receipt(commandId, "failed", "CAPABILITY_DENIED");
    }
    if (safeInteger(body.expiresAt) && body.expiresAt > this.clock()) {
      this.saveReceipt(commandId, body.expiresAt, fingerprint, result as CommandReceiptBody);
    }
    return result;
  }

  private commandStatus(raw: unknown): CommandReceiptBody | null {
    const body = record(raw);
    if (!body || !identifier(body.commandId)) return null;
    const prior = this.receipts.get(body.commandId);
    if (!prior) return null;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(body), "utf8")
      .digest("hex");
    return prior.fingerprint === fingerprint
      ? prior.receipt
      : this.receipt(body.commandId, "failed", "COMMAND_ID_COLLISION");
  }

  async route(request: CompanionRequest): Promise<CompanionResponse> {
    try {
      switch (request.method) {
        case "sessions.list":
          return ok(request.requestId, await this.listPublishedSessions());
        case "sessions.read": {
          const body = record(request.body);
          const publication = body ? await this.publication(body.publicationId) : null;
          return publication
            ? ok(request.requestId, await this.readSession(publication))
            : failed(request.requestId, "PUBLICATION_NOT_FOUND");
        }
        case "terminal.snapshot": {
          const body = record(request.body);
          const publication = body ? await this.publication(body.publicationId) : null;
          return publication
            ? ok(request.requestId, await this.terminalSnapshot(publication))
            : failed(request.requestId, "PUBLICATION_NOT_FOUND");
        }
        case "terminal.control":
          return ok(request.requestId, await this.terminalControl(request.body));
        case "command.execute":
          return ok(request.requestId, await this.executeCommand(request.body));
        case "command.status": {
          const receipt = this.commandStatus(request.body);
          return receipt
            ? ok(request.requestId, receipt)
            : failed(request.requestId, "COMMAND_OUTCOME_UNKNOWN");
        }
      }
    } catch {
      return failed(request.requestId, "LOCAL_SERVICE_UNAVAILABLE");
    }
  }

  async close(): Promise<void> {
    this.removeNotificationListener();
    const releases = [...this.leases.values()].map(async (lease) => {
      await (this.terminalInputTails.get(lease.streamId) ?? Promise.resolve());
      await this.local.call("external.sessions.terminal.release", { streamId: lease.streamId }).catch(() => undefined);
    });
    this.leases.clear();
    this.terminalInputTails.clear();
    await Promise.all(releases);
  }
}
