/** Closed observational metadata. None of these fields confer execution or completion authority. */
export const MESSAGE_TIMING_POINTS = ["T0", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9"] as const;
export type MessageTimingPoint = typeof MESSAGE_TIMING_POINTS[number];
export interface MessageTimingIdentity {
  workspaceId: string; resourceGeneration: string; agentId: string; sessionId: string; runId: string; attemptId: string; historyStart: number;
}
export interface MessageTimingInput { hostAtMs: number; errorMs: number }
export interface MessageTimingReport extends MessageTimingIdentity {
  schemaVersion: 1; origin: "host_receive"; clientClockErrorMs: number | null;
  points: Record<MessageTimingPoint, number | null>;
}
const LIMIT = 86_400_000;
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const id = new RegExp(`^${uuid}$`), workspace = new RegExp(`^ws_${uuid}$`), agent = new RegExp(`^ag_${uuid}$`);
const identityKeys = ["workspaceId", "resourceGeneration", "agentId", "sessionId", "runId", "attemptId", "historyStart"];
const keys = ["schemaVersion", ...identityKeys, "origin", "clientClockErrorMs", "points"];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: readonly string[]) => Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
export function parseMessageTimingInput(value: unknown): MessageTimingInput | null {
  if (!record(value) || !exact(value, ["hostAtMs", "errorMs"]) || typeof value.hostAtMs !== "number" || !Number.isFinite(value.hostAtMs)
    || value.hostAtMs < 0 || typeof value.errorMs !== "number" || !Number.isFinite(value.errorMs) || value.errorMs < 0 || value.errorMs > 1000) return null;
  return { hostAtMs: value.hostAtMs, errorMs: value.errorMs };
}
export function parseMessageTimingReport(value: unknown): MessageTimingReport | null {
  if (!record(value) || !exact(value, keys) || value.schemaVersion !== 1 || value.origin !== "host_receive"
    || typeof value.workspaceId !== "string" || !workspace.test(value.workspaceId) || typeof value.agentId !== "string" || !agent.test(value.agentId)
    || ![value.resourceGeneration, value.sessionId, value.runId, value.attemptId].every(value => typeof value === "string" && id.test(value))
    || !Number.isSafeInteger(value.historyStart) || Number(value.historyStart) < 0 || Number(value.historyStart) > 4000
    || !(value.clientClockErrorMs === null || Number.isSafeInteger(value.clientClockErrorMs) && Number(value.clientClockErrorMs) >= 0 && Number(value.clientClockErrorMs) <= 1000)
    || !record(value.points) || !exact(value.points, MESSAGE_TIMING_POINTS) || value.points.T1 !== 0) return null;
  for (const point of MESSAGE_TIMING_POINTS) {
    const at = value.points[point];
    if (at !== null && (!Number.isSafeInteger(at) || Number(at) < (point === "T0" ? -LIMIT : 0) || Number(at) > (point === "T0" ? Number(value.clientClockErrorMs ?? 0) : LIMIT))) return null;
  }
  if ((value.points.T0 === null) !== (value.clientClockErrorMs === null) || value.points.T7 !== null && value.clientClockErrorMs === null) return null;
  return structuredClone(value) as unknown as MessageTimingReport;
}
/** Host monotonic observations; unobserved points remain null, including unavailable client paint. */
export class MessageTimingRecorder {
  private readonly points = Object.fromEntries(MESSAGE_TIMING_POINTS.map(key => [key, key === "T1" ? 0 : null])) as Record<MessageTimingPoint, number | null>;
  private readonly began: number;
  private readonly errorMs: number | null = null;
  private ended = false;
  constructor(private readonly options: { receivedAt?: number; client?: MessageTimingInput; now?: () => number } = {}) {
    this.began = options.receivedAt ?? this.now();
    if (!Number.isFinite(this.began) || this.began < 0) throw new Error("Invalid message timing clock");
    const client = parseMessageTimingInput(options.client);
    if (client && client.hostAtMs <= this.began + Math.ceil(client.errorMs) && this.began - client.hostAtMs <= 60_000) {
      this.points.T0 = Math.floor(client.hostAtMs - this.began); this.errorMs = Math.ceil(client.errorMs);
    }
  }
  private now(): number { return (this.options.now ?? performance.now.bind(performance))(); }
  mark(point: Exclude<MessageTimingPoint, "T0" | "T1" | "T7">, at = this.now()): boolean {
    if (this.ended || !MESSAGE_TIMING_POINTS.includes(point) || this.points[point] !== null || !Number.isFinite(at)) return false;
    const offset = Math.floor(at - this.began);
    if (offset >= 0 && offset <= LIMIT) { this.points[point] = offset; return true; }
    return false;
  }
  paint(input: MessageTimingInput): boolean {
    const value = parseMessageTimingInput(input);
    if (!value || this.points.T7 !== null || this.errorMs === null || Math.ceil(value.errorMs) !== this.errorMs) return false;
    const offset = Math.floor(value.hostAtMs - this.began), now = this.now();
    if (offset < 0 || offset > LIMIT || value.hostAtMs > now + this.errorMs || now - value.hostAtMs > 30_000) return false;
    this.points.T7 = offset; return true;
  }
  finish(): void { if (!this.ended) { this.mark("T9"); this.ended = true; } }
  snapshot(identity: MessageTimingIdentity): MessageTimingReport {
    const report = parseMessageTimingReport({ schemaVersion: 1, ...identity, origin: "host_receive", clientClockErrorMs: this.errorMs, points: { ...this.points } });
    if (!report) throw new Error("Invalid message timing identity"); return report;
  }
}
