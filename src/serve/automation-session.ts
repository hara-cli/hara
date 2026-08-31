import { redactSensitiveText } from "../security/secrets.js";
import type { SessionMeta } from "../session/store.js";

/** Keep automation history serialization small, credential-safe, and independently testable from sockets. */
export function automationSessionForClient(meta: SessionMeta): Record<string, unknown> {
  const run = meta.automationRun;
  return {
    id: meta.id,
    title: meta.title,
    cwd: meta.cwd,
    source: meta.source,
    sourceName: meta.sourceName,
    jobId: meta.jobId,
    updatedAt: meta.updatedAt,
    ...(run
      ? {
          status: run.status,
          startedAt: run.startedAt,
          ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
          ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
          ...(run.error ? { error: redactSensitiveText(run.error).text } : {}),
          needsAttention: run.status === "error" || run.status === "timed_out",
        }
      : {}),
  };
}
