export const RUNTIME_TIME_ZONE_ENV = "HARA_RUNTIME_TIME_ZONE";

export interface RuntimeTimePromptOptions {
  /** Injectable only for deterministic callers/tests. Production callers omit it for a fresh clock. */
  now?: Date;
  /** IANA zone. Cron supplies the job zone; ordinary sessions use the execution host's local zone. */
  timeZone?: string;
}

function canonicalTimeZone(candidate: string | undefined): string | undefined {
  const value = candidate?.trim();
  if (!value || value.length > 128 || /[\r\n]/u.test(value)) return undefined;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/** Resolve a safe IANA zone without ever inserting an unchecked environment value into the prompt. */
export function resolveRuntimeTimeZone(
  preferred: string | undefined = process.env[RUNTIME_TIME_ZONE_ENV],
): string {
  const explicit = canonicalTimeZone(preferred);
  if (explicit) return explicit;
  try {
    const local = canonicalTimeZone(new Intl.DateTimeFormat().resolvedOptions().timeZone);
    if (local) return local;
  } catch {
    // Minimal ICU builds can fail to resolve a local zone. UTC remains deterministic and truthful.
  }
  return "UTC";
}

function normalizedUtcOffset(label: string | undefined): string {
  if (!label || label === "GMT" || label === "UTC") return "UTC+00:00";
  const match = /^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/u.exec(label);
  if (!match) return label.replace(/^GMT/u, "UTC");
  return `UTC${match[1]}${match[2].padStart(2, "0")}:${match[3] ?? "00"}`;
}

/** A locale-neutral clock suffix for the model system prompt. */
export function runtimeTimePrompt(options: RuntimeTimePromptOptions = {}): string {
  const now = options.now ? new Date(options.now.getTime()) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error("runtime clock must be a valid date");
  const timeZone = resolveRuntimeTimeZone(options.timeZone);
  const parts = new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  const date = `${value("year")}-${value("month")}-${value("day")}`;
  const time = `${value("hour")}:${value("minute")}:${value("second")}`;
  const offset = normalizedUtcOffset(value("timeZoneName"));

  return (
    "# Runtime date and time\n" +
    `Current date and time: ${date} ${time} (${value("weekday")})\n` +
    `Time zone: ${timeZone} (${offset})\n` +
    "This value is refreshed before every model request. Treat it as authoritative for relative-date " +
    "reasoning such as today, yesterday, and tomorrow. Do not invent a different system date or confuse " +
    "the model's knowledge cutoff with the current date."
  );
}
