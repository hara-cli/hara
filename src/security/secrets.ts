/** Shared secret redaction for anything that may leave the live model context (session JSON, public
 *  feedback, logs). Deliberately conservative: a false positive hides a value in a local transcript;
 *  a false negative leaves a credential on disk. */

export interface SecretRedaction {
  text: string;
  redactions: string[];
}

type Pattern = {
  label: string;
  re: RegExp;
  replace: string | ((...args: string[]) => string);
};

const CREDENTIAL_NAME = String.raw`(?:[A-Za-z][A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|password|passwd)[A-Za-z0-9_.-]*|(?:api[_-]?key|apikey|secret|token|password|passwd)[A-Za-z0-9_.-]*)`;
const CREDENTIAL_FLAG = String.raw`--?(?:api[-_]?key|token|secret|password|passwd)`;

const PATTERNS: Pattern[] = [
  {
    label: "private-key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: "<REDACTED:private-key>",
  },
  { label: "sk-key", re: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replace: "sk-***" },
  { label: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: "gh*_***" },
  { label: "gitlab-token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g, replace: "glpat-***" },
  { label: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g, replace: "xox*-***" },
  { label: "npm-token", re: /\bnpm_[A-Za-z0-9]{20,}\b/g, replace: "npm_***" },
  { label: "google-api-key", re: /\bAIza[A-Za-z0-9_-]{20,}\b/g, replace: "AIza***" },
  { label: "stripe-live-key", re: /\b(?:sk|rk)_live_[A-Za-z0-9]{12,}\b/g, replace: "stripe-live-***" },
  { label: "aws-key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: "AWS-KEY-***" },
  { label: "jwt", re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: "JWT-***" },
  {
    label: "bearer-token",
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: "Bearer ***",
  },
  {
    label: "url-credential",
    re: /(\bhttps?:\/\/[^\s/:@]+:)([^\s/@]{3,})(@)/gi,
    replace: (_match: string, prefix: string, _value: string, suffix: string) => `${prefix}***${suffix}`,
  },
  {
    // Quoted credentials may legitimately contain whitespace. Handle them before the unquoted patterns so
    // `PASSWORD="correct horse battery staple"` is redacted as one value rather than leaking its tail.
    label: "environment-credential",
    re: /(\b[A-Z][A-Z0-9_]*(?:_KEY|_SECRET|_TOKEN|_PASSWORD|_PASSWD)\b\s*=\s*)(["'])([\s\S]*?)\2/g,
    replace: (_match: string, prefix: string, quote: string) => `${prefix}${quote}***${quote}`,
  },
  {
    label: "credential-assignment",
    re: new RegExp(`(\\b${CREDENTIAL_NAME}\\b["']?\\s*[:=]\\s*)(["'])([\\s\\S]*?)\\2`, "gi"),
    replace: (_match: string, prefix: string, quote: string) => `${prefix}${quote}***${quote}`,
  },
  {
    label: "authorization",
    re: /(\bAuthorization\s*[:=]\s*)(["'])([\s\S]*?)\2/gi,
    replace: (_match: string, prefix: string, quote: string) => `${prefix}${quote}***${quote}`,
  },
  {
    label: "credential-flag",
    re: new RegExp(`(${CREDENTIAL_FLAG}(?:\\s+|=))(["'])([\\s\\S]*?)\\2`, "gi"),
    replace: (_match: string, prefix: string, quote: string) => `${prefix}${quote}***${quote}`,
  },
  {
    // Generic all-caps environment variables such as OPENAI_KEY / SOME_SERVICE_PRIVATE_KEY. Keep this
    // case-sensitive so ordinary prose/code identifiers ending in "key" are not over-redacted.
    label: "environment-credential",
    re: /(\b[A-Z][A-Z0-9_]*(?:_KEY|_SECRET|_TOKEN|_PASSWORD|_PASSWD)\b\s*=\s*)(["']?)([^\s"',;}\]]{6,})(["']?)/g,
    replace: (_match: string, prefix: string, open: string, _value: string, close: string) => `${prefix}${open}***${close}`,
  },
  {
    // FEISHU_APP_SECRET=… · apiKey: "…" · "access_token": "…". The optional quote immediately
    // after the key handles JSON without consuming the opening quote of the value.
    label: "credential-assignment",
    re: new RegExp(`(\\b${CREDENTIAL_NAME}\\b["']?\\s*[:=]\\s*)(?!["'])([^\\s"',;}\\]]{6,})`, "gi"),
    replace: (_match: string, prefix: string) => `${prefix}***`,
  },
  {
    label: "authorization",
    re: /(\bAuthorization\s*[:=]\s*)(?!["']|Bearer\s+)([^\s"',;}\]]{6,})/gi,
    replace: (_match: string, prefix: string) => `${prefix}***`,
  },
  {
    label: "credential-flag",
    re: new RegExp(`(${CREDENTIAL_FLAG}(?:\\s+|=))(?!["'])([^\\s"']{6,})`, "gi"),
    replace: (_match: string, prefix: string) => `${prefix}***`,
  },
];

export function redactSensitiveText(text: string): SecretRedaction {
  let out = text;
  const redactions: string[] = [];
  for (const pattern of PATTERNS) {
    pattern.re.lastIndex = 0;
    out = out.replace(pattern.re, (...args: any[]) => {
      redactions.push(pattern.label);
      return typeof pattern.replace === "string" ? pattern.replace : pattern.replace(...(args as string[]));
    });
  }
  return { text: out, redactions };
}

/** Structured tool/config data often carries an opaque value that has no recognizable token prefix. In that
 *  case the FIELD name is the evidence (`apiKey`, `access_token`, `FEISHU_APP_SECRET`, …). Keep this narrow
 *  enough not to erase ordinary fields such as `tokenCount` or `secretary`. */
function sensitiveFieldName(key: string): boolean {
  if (/^[A-Z][A-Z0-9_]*(?:_KEY|_SECRET|_TOKEN|_PASSWORD|_PASSWD)$/.test(key)) return true;
  const compact = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    compact === "authorization" ||
    compact.endsWith("apikey") ||
    compact.endsWith("privatekey") ||
    compact.endsWith("token") ||
    compact.endsWith("secret") ||
    compact.endsWith("password") ||
    compact.endsWith("passwd")
  );
}

/** Deep-copy a JSON-shaped value while redacting every string. Session history contains secrets not only
 *  in user text but also in assistant tool inputs and tool results, so a top-level content-only pass is
 *  insufficient. The live value is never mutated. */
export function redactSensitiveValue<T>(value: T): { value: T; redactions: string[] } {
  const hits: string[] = [];
  const seen = new WeakMap<object, unknown>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactSensitiveText(v);
      hits.push(...r.redactions);
      return r.text;
    }
    if (Array.isArray(v)) {
      const prior = seen.get(v);
      if (prior) return prior;
      const out: unknown[] = [];
      seen.set(v, out);
      for (const child of v) out.push(walk(child));
      return out;
    }
    if (v && typeof v === "object") {
      const prior = seen.get(v);
      if (prior) return prior;
      const out: Record<string, unknown> = {};
      seen.set(v, out);
      for (const [key, child] of Object.entries(v as Record<string, unknown>)) {
        let copied: unknown;
        if (typeof child === "string" && child && sensitiveFieldName(key)) {
          hits.push("credential-field");
          copied = "***";
        } else {
          copied = walk(child);
        }
        // defineProperty keeps an own `__proto__` data key from mutating the clone's prototype.
        Object.defineProperty(out, key, { value: copied, enumerable: true, writable: true, configurable: true });
      }
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, redactions: hits };
}
