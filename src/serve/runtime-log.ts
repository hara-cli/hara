import { createHash } from "node:crypto";
import { redactSensitiveText } from "../security/secrets.js";

const MAX_RUNTIME_LOG_BYTES = 2 * 1024 * 1024;
const MAX_RUNTIME_LOG_LINE_BYTES = 2 * 1024;

export type ServeRuntimeEvent =
  | "serve.started"
  | "client.authenticated"
  | "auth.denied"
  | "rpc.failed"
  | "turn.started"
  | "turn.completed"
  | "turn.paused"
  | "turn.failed"
  | "turn.interrupted"
  | "tool.started"
  | "tool.completed"
  | "tool.failed"
  | "provider.started"
  | "provider.completed"
  | "provider.failed"
  | "external.turn.failed"
  | "serve.stopping"
  | "log.limit";

export type ServeRuntimeFailureCategory =
  | "authentication"
  | "authorization"
  | "rate_limit"
  | "timeout"
  | "cancelled"
  | "provider"
  | "tool"
  | "invalid_request"
  | "conflict"
  | "internal";

export interface ServeRuntimeFields {
  sessionId?: string;
  method?: string;
  tool?: string;
  code?: number;
  category?: ServeRuntimeFailureCategory;
  durationMs?: number;
  version?: string;
  port?: number;
}

export function serveRuntimeFailureCategory(error: unknown): ServeRuntimeFailureCategory {
  const message = String(error instanceof Error ? error.message : error).toLowerCase();
  if (/abort|cancel|interrupt|stopp?ed/u.test(message)) return "cancelled";
  if (/timed?\s*out|deadline/u.test(message)) return "timeout";
  if (/rate.?limit|too many requests|\b429\b/u.test(message)) return "rate_limit";
  if (/unauthori[sz]ed|forbidden|permission|policy den|not allowed/u.test(message)) return "authorization";
  if (/auth|credential|api.?key|token|sign.?in|login|enroll/u.test(message)) return "authentication";
  if (/provider|model|response|completion/u.test(message)) return "provider";
  if (/tool|command|process/u.test(message)) return "tool";
  if (/invalid|required|parameter|unsupported/u.test(message)) return "invalid_request";
  if (/busy|conflict|changed|stale/u.test(message)) return "conflict";
  return "internal";
}

function opaqueSession(value: string): string {
  return `s_${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

function safeName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().slice(0, 96);
  if (redactSensitiveText(normalized).redactions.length > 0) return "redacted";
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,95}$/u.test(normalized) ? normalized : "redacted";
}

/** Bounded, allowlisted diagnostics for Desktop's redirected `serve.log`. It never accepts prompts,
 * replies, file paths, endpoints, credentials, or raw exception messages. Once the process budget is
 * reached, one terminal marker is emitted and further logging stops. */
export function createServeRuntimeLogger(options: {
  enabled?: boolean;
  write?: (line: string) => void;
  maxBytes?: number;
  now?: () => Date;
} = {}): (event: ServeRuntimeEvent, fields?: ServeRuntimeFields) => void {
  const enabled = options.enabled !== false;
  const write = options.write ?? ((line: string): void => {
    process.stderr.write(line);
  });
  const maxBytes = Math.max(512, Math.min(options.maxBytes ?? MAX_RUNTIME_LOG_BYTES, MAX_RUNTIME_LOG_BYTES));
  const now = options.now ?? (() => new Date());
  let written = 0;
  let limited = false;

  const emit = (event: ServeRuntimeEvent, fields: ServeRuntimeFields = {}): void => {
    if (!enabled || limited) return;
    const record: Record<string, unknown> = {
      at: now().toISOString(),
      event,
    };
    if (fields.sessionId) record.session = opaqueSession(fields.sessionId);
    const method = safeName(fields.method);
    if (method) record.method = method;
    const tool = safeName(fields.tool);
    if (tool) record.tool = tool;
    if (Number.isSafeInteger(fields.code)) record.code = fields.code;
    if (fields.category) record.category = fields.category;
    if (Number.isFinite(fields.durationMs)) record.durationMs = Math.max(0, Math.round(fields.durationMs!));
    const version = safeName(fields.version);
    if (version) record.version = version;
    if (Number.isInteger(fields.port) && fields.port! > 0 && fields.port! <= 65_535) record.port = fields.port;
    let line = `[hara-runtime] ${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_RUNTIME_LOG_LINE_BYTES) return;
    const limitLine = `[hara-runtime] ${JSON.stringify({ at: now().toISOString(), event: "log.limit" })}\n`;
    const lineBytes = Buffer.byteLength(line, "utf8");
    const limitBytes = Buffer.byteLength(limitLine, "utf8");
    if (written + lineBytes + limitBytes > maxBytes) {
      limited = true;
      if (written + limitBytes <= maxBytes) write(limitLine);
      return;
    }
    write(line);
    written += lineBytes;
  };
  return emit;
}
