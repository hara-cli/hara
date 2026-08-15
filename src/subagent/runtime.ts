import { randomUUID } from "node:crypto";

export type SubagentStatus = "completed" | "error" | "empty" | "halted" | "cancelled";

export interface SubagentUsage {
  input: number;
  output: number;
  lastInput?: number;
}

export interface SubagentRequest {
  task: string;
  role?: string;
  signal?: AbortSignal;
}

export interface SubagentSettlement {
  status: SubagentStatus;
  text: string;
  model?: string;
  error?: string;
  stopReason?: string;
  usage?: SubagentUsage;
}

export interface SubagentResult extends SubagentSettlement {
  id: string;
  providerId: string;
  role?: string;
  queuedAt: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export type SubagentLifecycleState = "queued" | "working" | "completed" | "failed" | "cancelled";

/** Safe execution metadata for host status surfaces. It deliberately excludes task text, provider
 * messages, tool arguments, paths, output, and credentials. */
export interface SubagentLifecycleEvent {
  id: string;
  providerId: string;
  role?: string;
  state: SubagentLifecycleState;
  queuedAt: string;
  startedAt?: string;
  endedAt?: string;
}

export type SubagentLifecycleObserver = (event: SubagentLifecycleEvent) => void;

export interface SubagentProvider<Request extends SubagentRequest> {
  id: string;
  run(request: Request): Promise<SubagentSettlement>;
}

type AdmissionFailure = "cancelled" | "closed" | "queue_full";

class AdmissionError extends Error {
  constructor(readonly kind: AdmissionFailure) {
    super(kind);
  }
}

type Waiter = {
  signal?: AbortSignal;
  resolve: (release: () => void) => void;
  reject: (error: AdmissionError) => void;
  abort?: () => void;
};

function iso(): string {
  return new Date().toISOString();
}

function boundedMessage(value: unknown, fallback: string): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  const sanitized = raw
    .replace(/(?:authorization\s*:\s*bearer|bearer)\s+[^\s,;]+/giu, "Bearer ***")
    .replace(/\b(?:sk|ak)-[A-Za-z0-9_-]{8,}\b/giu, "[redacted credential]")
    .trim();
  return (sanitized || fallback).slice(0, 1_000);
}

/**
 * Provider-neutral sub-agent lifecycle. A root runner owns one runtime, while providers implement the
 * actual execution mechanism (native Hara today; ACP/Codex/other harnesses can be adapters later).
 * Admission is FIFO, bounded, abort-aware, and independent from provider/model identity.
 */
export class SubagentRuntime<Request extends SubagentRequest> {
  private readonly providers = new Map<string, SubagentProvider<Request>>();
  private readonly waiters: Waiter[] = [];
  private active = 0;
  private closed = false;

  constructor(
    private readonly options: {
      maxConcurrent: number;
      maxQueued?: number;
    },
  ) {
    if (!Number.isInteger(options.maxConcurrent) || options.maxConcurrent < 1) {
      throw new Error("sub-agent maxConcurrent must be a positive integer");
    }
    if (options.maxQueued !== undefined && (!Number.isInteger(options.maxQueued) || options.maxQueued < 0)) {
      throw new Error("sub-agent maxQueued must be a non-negative integer");
    }
  }

  register(provider: SubagentProvider<Request>): void {
    const id = provider.id.trim();
    if (!id) throw new Error("sub-agent provider id cannot be blank");
    if (this.providers.has(id)) throw new Error(`sub-agent provider '${id}' is already registered`);
    this.providers.set(id, provider);
  }

  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.closed) return Promise.reject(new AdmissionError("closed"));
    if (signal?.aborted) return Promise.reject(new AdmissionError("cancelled"));
    if (this.active < this.options.maxConcurrent && this.waiters.length === 0) {
      this.active += 1;
      return Promise.resolve(this.releaseHandle());
    }
    const maxQueued = this.options.maxQueued ?? this.options.maxConcurrent * 4;
    if (this.waiters.length >= maxQueued) return Promise.reject(new AdmissionError("queue_full"));
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = { signal, resolve, reject };
      if (signal) {
        waiter.abort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new AdmissionError("cancelled"));
        };
        signal.addEventListener("abort", waiter.abort, { once: true });
      }
      this.waiters.push(waiter);
    });
  }

  private releaseHandle(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      this.drain();
    };
  }

  private drain(): void {
    while (!this.closed && this.active < this.options.maxConcurrent && this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (waiter.abort && waiter.signal) waiter.signal.removeEventListener("abort", waiter.abort);
      if (waiter.signal?.aborted) {
        waiter.reject(new AdmissionError("cancelled"));
        continue;
      }
      this.active += 1;
      waiter.resolve(this.releaseHandle());
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.abort && waiter.signal) waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.reject(new AdmissionError("closed"));
    }
  }

  async run(
    providerId: string,
    request: Request,
    onLifecycle?: SubagentLifecycleObserver,
  ): Promise<SubagentResult> {
    const id = randomUUID();
    const queuedAt = iso();
    const publish = (event: SubagentLifecycleEvent): void => {
      try {
        onLifecycle?.(event);
      } catch {
        // Observability can never change admission or provider execution.
      }
    };
    const lifecycleBase = {
      id,
      providerId,
      ...(request.role ? { role: request.role } : {}),
      queuedAt,
    };
    const provider = this.providers.get(providerId);
    if (!provider) {
      const result = this.failure(id, providerId, request.role, queuedAt, "error", `provider '${providerId}' is not registered`);
      publish({ ...lifecycleBase, state: "failed", endedAt: result.endedAt });
      return result;
    }
    if (typeof request.task !== "string" || !request.task.trim()) {
      const result = this.failure(id, providerId, request.role, queuedAt, "error", "task cannot be blank");
      publish({ ...lifecycleBase, state: "failed", endedAt: result.endedAt });
      return result;
    }

    publish({ ...lifecycleBase, state: "queued" });

    let release: (() => void) | undefined;
    try {
      release = await this.acquire(request.signal);
    } catch (error) {
      const kind = error instanceof AdmissionError ? error.kind : "closed";
      const message = kind === "queue_full"
        ? "the root sub-agent queue is full"
        : kind === "cancelled"
          ? "cancelled before execution"
          : "the root sub-agent runtime is closed";
      const result = this.failure(id, providerId, request.role, queuedAt, kind === "cancelled" ? "cancelled" : "error", message);
      publish({
        ...lifecycleBase,
        state: kind === "cancelled" ? "cancelled" : "failed",
        endedAt: result.endedAt,
      });
      return result;
    }

    const startedAt = iso();
    const startedMs = Date.now();
    publish({ ...lifecycleBase, state: "working", startedAt });
    try {
      const settlement = await provider.run(request);
      const endedAt = iso();
      const result: SubagentResult = {
        ...settlement,
        id,
        providerId,
        ...(request.role ? { role: request.role } : {}),
        queuedAt,
        startedAt,
        endedAt,
        durationMs: Math.max(0, Date.now() - startedMs),
      };
      publish({
        ...lifecycleBase,
        state: settlement.status === "completed"
          ? "completed"
          : settlement.status === "cancelled"
            ? "cancelled"
            : "failed",
        startedAt,
        endedAt,
      });
      return result;
    } catch (error) {
      const result = this.failure(
        id,
        providerId,
        request.role,
        queuedAt,
        request.signal?.aborted ? "cancelled" : "error",
        boundedMessage(error, "provider failed before completion"),
        startedAt,
        startedMs,
      );
      publish({
        ...lifecycleBase,
        state: request.signal?.aborted ? "cancelled" : "failed",
        startedAt,
        endedAt: result.endedAt,
      });
      return result;
    } finally {
      release();
    }
  }

  private failure(
    id: string,
    providerId: string,
    role: string | undefined,
    queuedAt: string,
    status: "error" | "cancelled",
    error: string,
    startedAt = queuedAt,
    startedMs = Date.now(),
  ): SubagentResult {
    return {
      id,
      providerId,
      ...(role ? { role } : {}),
      queuedAt,
      startedAt,
      endedAt: iso(),
      durationMs: Math.max(0, Date.now() - startedMs),
      status,
      text: "",
      error: boundedMessage(error, "sub-agent failed"),
    };
  }
}

/** Compatibility boundary for the current `agent` tool. Hosts can adopt SubagentResult directly without
 * changing model-visible output in the same release. */
export function subagentResultText(result: SubagentResult): string {
  if (result.status === "completed") return result.text.trim() || "(sub-agent produced no output)";
  const reason = result.error?.trim()
    || (result.status === "empty"
      ? "the model returned an empty response"
      : result.stopReason
        ? `the run stopped (${result.stopReason})`
        : result.status === "cancelled"
          ? "was cancelled"
          : `the run ended with status ${result.status}`);
  return `Error: sub-agent ${reason}`;
}
