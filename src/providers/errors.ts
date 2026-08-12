import { redactKnownSecrets } from "../security/secrets.js";

const MAX_PROVIDER_ERROR_LENGTH = 2_000;

/** Convert an untrusted provider/SDK error into a bounded, display-safe diagnostic.
 * Provider errors occasionally echo request URLs, headers, or opaque API keys, so callers must never
 * forward `error.message` directly into the UI, logs, or durable session history. */
export function safeProviderErrorMessage(
  error: unknown,
  knownSecrets: readonly (string | undefined)[] = [],
  fallback = "Provider request failed.",
): string {
  let raw = "";
  if (typeof error === "string") {
    raw = error;
  } else if (error instanceof Error) {
    const providerStatus = (error as Error & { status?: unknown }).status;
    raw = [typeof providerStatus === "number" || typeof providerStatus === "string" ? providerStatus : "", error.message]
      .filter(Boolean)
      .join(" ");
  } else if (error && typeof error === "object") {
    const providerError = error as { status?: unknown; message?: unknown };
    const providerStatus = typeof providerError.status === "number" || typeof providerError.status === "string"
      ? providerError.status
      : "";
    const providerMessage = typeof providerError.message === "string" ? providerError.message : "";
    raw = [providerStatus, providerMessage].filter(Boolean).join(" ");
  } else if (error != null) {
    raw = String(error);
  }

  const safe = redactKnownSecrets(raw, knownSecrets).text
    // Keep diagnostics on one readable line while preventing terminal/control-sequence injection.
    .replace(/[\t\r\n]+/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
  if (!safe) return fallback;
  return safe.length <= MAX_PROVIDER_ERROR_LENGTH
    ? safe
    : `${safe.slice(0, MAX_PROVIDER_ERROR_LENGTH - 1)}…`;
}
