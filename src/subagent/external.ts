import {
  ExternalRuntimeSessionGoneError,
  type ExternalSessionInfo,
  type ExternalSessionService,
  type ExternalTurnMetrics,
  type ExternalTurnSink,
} from "../external-sessions/types.js";
import { redactSensitiveText } from "../security/secrets.js";
import type { AgentTeamExecutionRequest, AgentTeamExecutionResult } from "./team.js";

const MAILBOX_POLL_MS = 200;

function safeError(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
  return (redactSensitiveText(raw).text.trim() || fallback).slice(0, 1_000);
}

function pollDelay(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, MAILBOX_POLL_MS);
    signal.addEventListener("abort", done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

export interface ExternalCodingAgentObserver {
  /** Synchronous host binding, before any provider turn or interaction is allowed. */
  onSession?(session: ExternalSessionInfo): void;
  text?(delta: string): void;
  tool?(name: string, preview: string): void;
  notice?(text: string): void;
  confirm?: ExternalTurnSink["confirm"];
  askUser?: ExternalTurnSink["askUser"];
  prepareCodingHost?: ExternalTurnSink["prepareCodingHost"];
  /** Host-authoritative absolute counters. When present, adapter event usage is diagnostic only. */
  executionMetrics?(): ExternalTurnMetrics;
}

async function humanReply<T>(
  signal: AbortSignal,
  fallback: T,
  callback: () => Promise<T>,
): Promise<T> {
  if (signal.aborted) return fallback;
  let cancelled: () => void = () => {};
  const abort = new Promise<T>((resolve) => { cancelled = () => resolve(fallback); });
  signal.addEventListener("abort", cancelled, { once: true });
  if (signal.aborted) cancelled();
  try {
    return await Promise.race([Promise.resolve().then(callback).catch(() => fallback), abort]);
  } finally {
    signal.removeEventListener("abort", cancelled);
  }
}

/**
 * Execute a durable generation through the structured Codex/Claude/OpenCode adapters. The provider
 * opaque id is persisted by DurableAgentTeam. Old live PTYs must be explicitly released, never killed
 * or silently joined by a second writer; an authoritatively gone PTY can recover its original provider.
 * Native interaction cards are independent of in-flight input: Claude's string-prompt SDK turn does
 * not expose a safe persistent input queue here. Unsupported mailbox delivery interrupts explicitly;
 * it never restarts the task or reports an unconfirmed message as delivered.
 */
export async function executeExternalCodingAgent(
  request: AgentTeamExecutionRequest,
  service: ExternalSessionService,
  observer: ExternalCodingAgentObserver = {},
): Promise<AgentTeamExecutionResult> {
  if (request.runtime === "hara") {
    return { status: "error", text: "", error: "native Hara Agents do not use the external coding runtime" };
  }
  if (request.runtime !== "codex" && request.runtime !== "claude" && request.runtime !== "opencode") {
    return { status: "error", text: "", error: "this executor is not an external structured coding provider" };
  }
  if (!request.workspace || request.workspace.mode !== "isolated-write") {
    return {
      status: "error",
      text: "",
      error: "External coding Agents require an Agent-owned isolated Git worktree",
    };
  }
  if (request.signal.aborted) return { status: "cancelled", text: "" };

  const runtimeSessionId = request.runtimeSessionId;
  let providerSessionId = request.providerSessionId;
  const ids = () => ({ ...(runtimeSessionId ? { runtimeSessionId } : {}),
    ...(providerSessionId ? { providerSessionId } : {}) });
  if (runtimeSessionId) {
    try {
      const live = await service.readSession(runtimeSessionId);
      if (providerSessionId && live.session.providerSessionId && providerSessionId !== live.session.providerSessionId) {
        return { status: "error", text: "", error: "the legacy terminal and saved provider conversation do not match", ...ids() };
      }
      providerSessionId ??= live.session.providerSessionId;
      return { status: "error", text: "", ...ids(), error:
        "This coding Agent still owns a legacy Hara Live terminal. Release that terminal explicitly before continuing with structured approval and question cards; Hara did not start a second writer." };
    } catch (error) {
      if (!(error instanceof ExternalRuntimeSessionGoneError) || !providerSessionId) {
        return { status: request.signal.aborted ? "cancelled" : "error", text: "", ...ids(),
          error: safeError(error, "Hara could not safely inspect the legacy coding terminal") };
      }
    }
  }
  if (request.signal.aborted) return { status: "cancelled", text: "", ...ids() };
  let session: ExternalSessionInfo;
  try {
    const input = { agentKind: request.runtime, cwd: request.workspace.cwd,
      title: `${request.runtime === "codex" ? "Codex" : request.runtime === "claude" ? "Claude" : "OpenCode"} · ${request.path}` };
    const admitted = providerSessionId
      ? await service.resumeCodingSession({ ...input, providerSessionId })
      : await service.createCodingSession(input);
    if (admitted.session.sourceId !== request.runtime
      || !new RegExp(`^ext_${request.runtime}_[a-f0-9]{24}$`, "u").test(admitted.session.id)
      || (providerSessionId && admitted.session.id !== providerSessionId)
      || admitted.readOnly || admitted.controlMode !== "managed") {
      throw new Error("the coding adapter did not admit the original owned provider session");
    }
    session = admitted.session;
    providerSessionId = session.id;
    // Persist the opaque native-conversation binding before any UI observer or model dispatch.
    // Optional invocation keeps old mock executors compatible; DurableAgentTeam always supplies it.
    request.bindProviderSession?.(providerSessionId);
  } catch (error) {
    return { status: request.signal.aborted ? "cancelled" : "error", text: "", ...ids(),
      error: safeError(error, "the structured coding session could not be admitted") };
  }
  if (request.signal.aborted) {
    return { status: "cancelled", text: "", ...ids() };
  }
  const initialIds = new Set<string>();
  try {
    const reserved = await request.reserveInput?.() ?? [];
    // The generation captures these ids with its prompt. An admission-time message must instead
    // remain in the pump, even if it is already visible in this first reservation.
    const captured = new Set(request.initialInputIds ?? reserved.map((delivery) => delivery.id));
    for (const delivery of reserved) if (captured.has(delivery.id)) initialIds.add(delivery.id);
  } catch (error) {
    return { status: request.signal.aborted ? "cancelled" : "error", text: "", ...ids(),
      error: safeError(error, "Hara could not reserve the generation's initial Agent input") };
  }
  if (request.signal.aborted) return { status: "cancelled", text: "", ...ids() };
  try { observer.onSession?.(session); }
  catch (error) {
    return { status: "error", text: "", ...ids(), error: safeError(error, "the parent conversation could not bind this coding session") };
  }

  // OpenCode's host reports actual absolute rounds; do not pre-charge a fictitious round.
  // Legacy adapters still lack detailed usage and retain their existing one-round estimate.
  const metrics: ExternalTurnMetrics = { providerRounds: request.runtime === "opencode" ? 0 : 1,
    toolCalls: 0, inputTokens: 0, outputTokens: 0 };
  if (!request.reportProgress(metrics)) {
    return {
      status: "halted",
      text: "",
      error: "Agent tree execution budget reached before the external coding turn",
      metrics,
      ...ids(),
    };
  }
  const finalMetrics = (adapter?: ExternalTurnMetrics): "valid" | "invalid" | "exhausted" => {
    let actual: ExternalTurnMetrics | undefined;
    try {
      actual = observer.executionMetrics ? observer.executionMetrics() : adapter;
      if (actual === undefined && !observer.executionMetrics) return "valid";
      if (actual !== undefined || observer.executionMetrics) {
        if (!actual || typeof actual !== "object" || Array.isArray(actual)) return "invalid";
        const snapshot = { providerRounds: actual.providerRounds, toolCalls: actual.toolCalls,
          inputTokens: actual.inputTokens, outputTokens: actual.outputTokens };
        if (Object.values(snapshot).some((value) => !Number.isSafeInteger(value) || value < 0)) return "invalid";
        Object.assign(metrics, snapshot);
      }
    } catch { return "invalid"; }
    return request.reportProgress(metrics) ? "valid" : "exhausted";
  };

  const mailboxPumpController = new AbortController();
  const abort = (): void => {
    mailboxPumpController.abort();
    void service.interrupt(providerSessionId!).catch(() => undefined);
  };
  request.signal.addEventListener("abort", abort, { once: true });
  let pumping = true;
  let mailboxError = "";
  const seenInput = new Set(initialIds);
  const mailboxPump = (async () => {
    while (pumping && !request.signal.aborted) {
      await pollDelay(mailboxPumpController.signal);
      if (!pumping || request.signal.aborted) break;
      let deliveries;
      try {
        deliveries = await (request.reserveInput?.() ?? request.pendingInput());
      } catch (error) {
        mailboxError = safeError(error, "Hara could not read in-flight Agent messages");
        await service.interrupt(providerSessionId!).catch(() => undefined);
        return;
      }
      for (const delivery of deliveries) {
        if (!pumping || request.signal.aborted) return;
        if (seenInput.has(delivery.id)) continue;
        try {
          const accepted = await service.steer(
            providerSessionId!,
            `[Hara Agent message from ${delivery.sourcePath}]\n${delivery.content}`,
          );
          if (accepted?.accepted !== true || accepted.sessionId !== providerSessionId) {
            throw new Error("the coding provider did not confirm this in-flight Agent message");
          }
          await request.acknowledgeInput?.(delivery.id);
          seenInput.add(delivery.id);
          observer.notice?.(`Hara relayed a message from ${delivery.sourcePath} to the active ${request.runtime} Agent.`);
        } catch (error) {
          mailboxError = safeError(error, "Hara could not relay an in-flight Agent message");
          await service.interrupt(providerSessionId!).catch(() => undefined);
          return;
        }
      }
    }
  })();
  const stopMailboxPump = async (): Promise<void> => {
    pumping = false;
    mailboxPumpController.abort();
    await mailboxPump.catch(() => undefined);
  };
  try {
    const sink: ExternalTurnSink = {
      signal: request.signal,
      ...(observer.prepareCodingHost ? {
        prepareCodingHost: async (signal: AbortSignal) => {
          const combined = AbortSignal.any([signal, request.signal]);
          if (combined.aborted) throw new Error("the coding host was cancelled before setup");
          return await observer.prepareCodingHost!(combined);
        },
      } : {}),
      text: (delta) => observer.text?.(delta),
      tool: (name, preview) => observer.tool?.(name, preview),
      notice: (text) => observer.notice?.(text),
      confirm: async (approval, signal) => {
        const combined = AbortSignal.any([signal, request.signal]);
        if (!observer.confirm || combined.aborted) return false;
        const verdict = await humanReply(combined, false as boolean | "always",
          () => observer.confirm!({ ...approval, allowAlways: false }, combined));
        // A worker may obtain a fresh single-action approval, never a provider-session grant.
        return !combined.aborted && (verdict === true || verdict === "always");
      },
      askUser: async (questions, signal) => {
        const combined = AbortSignal.any([signal, request.signal]);
        if (!observer.askUser || combined.aborted) return {};
        const answers = await humanReply(combined, {}, () => observer.askUser!(questions, combined));
        return combined.aborted ? {} : answers;
      },
    };
    let turn;
    try {
      if (request.signal.aborted) return { status: "cancelled", text: "", metrics, ...ids() };
      turn = await service.submit(providerSessionId!, request.task, sink);
    } catch (error) {
      const accounting = finalMetrics();
      if (accounting === "invalid") return { status: "error", text: "", ...ids(), error: "the coding host returned invalid execution counters" };
      return {
        status: accounting === "exhausted" ? "halted" : request.signal.aborted ? "cancelled" : "error",
        text: "",
        error: safeError(error, "external coding Agent failed before completion"),
        metrics,
        ...ids(),
      };
    }
    await stopMailboxPump();
    if (turn.sessionId !== providerSessionId) {
      if (observer.executionMetrics) {
        const accounting = finalMetrics();
        if (accounting === "invalid") return { status: "error", text: "", ...ids(), error: "the coding host returned invalid execution counters" };
      }
      return { status: "error", text: "", error: "the coding provider returned a different conversation", metrics, ...ids() };
    }
    const accounting = finalMetrics(turn.metrics);
    if (accounting === "invalid") return { status: "error", text: "", ...ids(), error: "the coding provider or host returned invalid execution counters" };
    if (accounting === "exhausted") return { status: "halted", text: redactSensitiveText(turn.reply).text,
      error: "Agent tree execution budget reached during the external coding turn", metrics, ...ids() };
    if (mailboxError) {
      return {
        status: "error",
        text: redactSensitiveText(turn.reply).text,
        error: mailboxError,
        model: `${request.runtime} coding runtime`,
        metrics,
        ...ids(),
      };
    }
    if (turn.status === "completed" && !request.signal.aborted) {
      try {
        for (const id of initialIds) await request.acknowledgeInput?.(id);
      } catch (error) {
        return { status: request.signal.aborted ? "cancelled" : "error", text: redactSensitiveText(turn.reply).text,
          error: safeError(error, "Hara could not acknowledge completed Agent input"), metrics, ...ids() };
      }
    }
    return {
      status: request.signal.aborted
        ? "cancelled"
        : turn.status === "completed"
          ? "completed"
          : turn.status === "interrupted" ? "cancelled" : "error",
      text: redactSensitiveText(turn.reply).text,
      model: `${request.runtime} coding runtime`,
      ...(turn.error ? { error: safeError(turn.error, "external coding Agent turn failed") } : {}),
      metrics,
      ...ids(),
    };
  } finally {
    request.signal.removeEventListener("abort", abort);
    await stopMailboxPump();
  }
}
