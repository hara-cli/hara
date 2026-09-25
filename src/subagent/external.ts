import {
  ExternalRuntimeSessionGoneError,
  type ExternalSessionService,
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
  text?(delta: string): void;
  tool?(name: string, preview: string): void;
  notice?(text: string): void;
}

/**
 * Execute one durable Agent generation through Hara Live's official Codex/Claude adapters.
 * The caller must supply the Agent-owned isolated worktree as cwd. The returned opaque runtime id is
 * persisted by DurableAgentTeam so follow-up generations continue the same provider conversation.
 */
export async function executeExternalCodingAgent(
  request: AgentTeamExecutionRequest,
  service: ExternalSessionService,
  observer: ExternalCodingAgentObserver = {},
): Promise<AgentTeamExecutionResult> {
  if (request.runtime === "hara") {
    return { status: "error", text: "", error: "native Hara Agents do not use the external coding runtime" };
  }
  if (!request.workspace || request.workspace.mode !== "isolated-write") {
    return {
      status: "error",
      text: "",
      error: "Codex and Claude Agents require an Agent-owned isolated Git worktree",
    };
  }
  if (request.signal.aborted) return { status: "cancelled", text: "" };

  let runtimeSessionId = request.runtimeSessionId;
  let providerSessionId = request.providerSessionId;
  if (!runtimeSessionId) {
    const created = await service.createSession({
      sourceId: "runtime",
      cwd: request.workspace.cwd,
      agentKind: request.runtime,
      title: `${request.runtime === "codex" ? "Codex" : "Claude"} · ${request.path}`,
      launch: request.runtime === "codex"
        ? { sandboxMode: "workspace-write" }
        : { permissionMode: "acceptEdits" },
    });
    runtimeSessionId = created.session.id;
    providerSessionId = created.session.providerSessionId;
  } else {
    // Rehydrate the runtime adapter after a Hara restart before attempting continuation.
    try {
      const live = await service.readSession(runtimeSessionId);
      providerSessionId ??= live.session.providerSessionId;
    } catch (error) {
      // Rebuild only after an authoritative missing-terminal result. Transport/read failures remain
      // failures so a transient outage can never create two controllers for one provider session.
      if (!(error instanceof ExternalRuntimeSessionGoneError) || !providerSessionId) throw error;
      const recovered = await service.recoverRuntimeSession({
        sourceId: "runtime",
        cwd: request.workspace.cwd,
        agentKind: request.runtime,
        providerSessionId,
        title: `${request.runtime === "codex" ? "Codex" : "Claude"} · ${request.path}`,
        launch: request.runtime === "codex"
          ? { sandboxMode: "workspace-write" }
          : { permissionMode: "acceptEdits" },
      });
      runtimeSessionId = recovered.session.id;
      providerSessionId = recovered.session.providerSessionId ?? providerSessionId;
      observer.notice?.(
        `Hara restored the same ${request.runtime === "codex" ? "Codex" : "Claude Code"} conversation in a new local terminal.`,
      );
    }
  }
  if (request.signal.aborted) {
    await service.interrupt(runtimeSessionId).catch(() => undefined);
    return {
      status: "cancelled",
      text: "",
      runtimeSessionId,
      ...(providerSessionId ? { providerSessionId } : {}),
    };
  }

  const metrics = { providerRounds: 1, toolCalls: 0, inputTokens: 0, outputTokens: 0 };
  if (!request.reportProgress(metrics)) {
    return {
      status: "halted",
      text: "",
      error: "Agent tree execution budget reached before the external coding turn",
      metrics,
      runtimeSessionId,
      ...(providerSessionId ? { providerSessionId } : {}),
    };
  }

  const mailboxPumpController = new AbortController();
  const abort = (): void => {
    mailboxPumpController.abort();
    void service.interrupt(runtimeSessionId!).catch(() => undefined);
  };
  request.signal.addEventListener("abort", abort, { once: true });
  let pumping = true;
  let mailboxError = "";
  const mailboxPump = (async () => {
    while (pumping && !request.signal.aborted) {
      await pollDelay(mailboxPumpController.signal);
      if (!pumping || request.signal.aborted) break;
      let deliveries;
      try {
        deliveries = await request.pendingInput();
      } catch (error) {
        mailboxError = safeError(error, "Hara could not read in-flight Agent messages");
        await service.interrupt(runtimeSessionId!).catch(() => undefined);
        return;
      }
      for (const delivery of deliveries) {
        try {
          await service.terminalInput(
            runtimeSessionId!,
            `[Hara Agent message from ${delivery.sourcePath}]\n${delivery.content}`,
          );
          observer.notice?.(`Hara relayed a message from ${delivery.sourcePath} to the active ${request.runtime} Agent.`);
        } catch (error) {
          mailboxError = safeError(error, "Hara could not relay an in-flight Agent message");
          await service.interrupt(runtimeSessionId!).catch(() => undefined);
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
      text: (delta) => observer.text?.(delta),
      tool: (name, preview) => observer.tool?.(name, preview),
      notice: (text) => observer.notice?.(text),
      // Hara Live launches Codex/Claude with a bounded worktree permission profile. It does not ask
      // arbitrary provider questions during relay; fail closed if a future adapter unexpectedly does.
      confirm: async () => false,
    };
    let turn;
    try {
      turn = await service.submit(runtimeSessionId, request.task, sink);
    } catch (error) {
      return {
        status: request.signal.aborted ? "cancelled" : "error",
        text: "",
        error: safeError(error, "external coding Agent failed before completion"),
        metrics,
        runtimeSessionId,
        ...(providerSessionId ? { providerSessionId } : {}),
      };
    }
    await stopMailboxPump();
    if (mailboxError) {
      return {
        status: "error",
        text: redactSensitiveText(turn.reply).text,
        error: mailboxError,
        model: `${request.runtime} coding runtime`,
        metrics,
        runtimeSessionId,
        ...(providerSessionId ? { providerSessionId } : {}),
      };
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
      runtimeSessionId,
      ...(providerSessionId ? { providerSessionId } : {}),
    };
  } finally {
    request.signal.removeEventListener("abort", abort);
    await stopMailboxPump();
  }
}
