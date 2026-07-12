// One invariant for every registered tool: no single result may monopolize the model context. Individual
// tools can use tighter domain-specific limits, but this final boundary also covers plugins/new tools.

export const MAX_TOOL_RESULT_CHARS = 24_000;

function safeHead(value: string, end: number): string {
  let at = Math.max(0, Math.min(value.length, end));
  if (at > 0 && /[\uD800-\uDBFF]/.test(value[at - 1] ?? "")) at--;
  return value.slice(0, at);
}

function safeTail(value: string, start: number): string {
  let at = Math.max(0, Math.min(value.length, start));
  if (at < value.length && /[\uDC00-\uDFFF]/.test(value[at] ?? "")) at++;
  return value.slice(at);
}

/** Keep actionable beginnings and endings while bounding the exact string persisted in history. */
export function limitToolResult(value: unknown, max = MAX_TOOL_RESULT_CHARS): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  const cap = Math.max(0, Math.floor(max));
  if (text.length <= cap) return text;
  if (cap === 0) return "";

  let omitted = text.length - cap;
  let fullMarker = "";
  // The marker consumes part of the budget too. Iterate twice so its count reflects the actual payload
  // removed rather than understating it by roughly the marker's own length.
  for (let i = 0; i < 2; i++) {
    fullMarker = `\n…[hara: ${omitted} chars omitted; narrow the query or continue read_file with offset/limit]…\n`;
    omitted = text.length - Math.max(0, cap - fullMarker.length);
  }
  const marker = fullMarker.length < cap ? fullMarker : "…[truncated]…".slice(0, cap);
  const room = cap - marker.length;
  const headChars = Math.floor(room * 0.6);
  const tailChars = room - headChars;
  return safeHead(text, headChars) + marker + safeTail(text, text.length - tailChars);
}
