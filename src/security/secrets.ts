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

const PATTERNS: Pattern[] = [
  {
    label: "private-key",
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: "<REDACTED:private-key>",
  },
  { label: "sk-key", re: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replace: "sk-***" },
  { label: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replace: "gh*_***" },
  { label: "aws-key", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: "AWS-KEY-***" },
  { label: "jwt", re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, replace: "JWT-***" },
  {
    label: "bearer-token",
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    replace: "Bearer ***",
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
    re: /(\b(?:[A-Za-z][A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|password|passwd)[A-Za-z0-9_.-]*|(?:api[_-]?key|apikey|secret|token|password|passwd)[A-Za-z0-9_.-]*)\b["']?\s*[:=]\s*)(["']?)([^\s"',;}\]]{6,})(["']?)/gi,
    replace: (_match: string, prefix: string, open: string, _value: string, close: string) => `${prefix}${open}***${close}`,
  },
  {
    label: "authorization",
    re: /(\bAuthorization\s*[:=]\s*)(?!Bearer\s+)(["']?)([^\s"',;}\]]{6,})(["']?)/gi,
    replace: (_match: string, prefix: string, open: string, _value: string, close: string) => `${prefix}${open}***${close}`,
  },
  {
    label: "credential-flag",
    re: /(--?(?:api[-_]?key|token|secret|password|passwd)(?:\s+|=))(["']?)([^\s"']{6,})(["']?)/gi,
    replace: (_match: string, prefix: string, open: string, _value: string, close: string) => `${prefix}${open}***${close}`,
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

/** Deep-copy a JSON-shaped value while redacting every string. Session history contains secrets not only
 *  in user text but also in assistant tool inputs and tool results, so a top-level content-only pass is
 *  insufficient. The live value is never mutated. */
export function redactSensitiveValue<T>(value: T): { value: T; redactions: string[] } {
  const hits: string[] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const r = redactSensitiveText(v);
      hits.push(...r.redactions);
      return r.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, child]) => [k, walk(child)]));
    }
    return v;
  };
  return { value: walk(value) as T, redactions: hits };
}
