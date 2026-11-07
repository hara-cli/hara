import { isSecretEnvironmentName, redactToolSubprocessOutput } from "../security/subprocess-env.js";
import { requestsCredentialDisclosure } from "../security/secrets.js";
/** Ephemeral prose only. Hold incomplete words/known secrets; never expose raw RPC or reasoning. */
export function createAssistantPreview(input: {
  source: NodeJS.ProcessEnv; emit(text: string): void;
  schedule?: (callback: () => void) => unknown; cancel?: (handle: unknown) => void;
}) {
  const known = Object.entries(input.source).filter(([name, value]) => value && value.length >= 6 && isSecretEnvironmentName(name)).map(([, value]) => value!);
  let raw = "", safe = "", sent = "", stopped = known.reduce((sum, value) => sum + value.length, 0) > 256 * 1024;
  let timer: unknown;
  const cancel = () => { if (timer !== undefined) (input.cancel ?? (handle => clearTimeout(handle as ReturnType<typeof setTimeout>)))(timer); timer = undefined; };
  const flush = () => { cancel(); if (stopped || !safe || safe === sent) return; sent = safe; input.emit(safe); };
  const prepare = (final: boolean) => {
    if (stopped) return;
    // Quoted/multiline credentials, URLs, code and solicitation are left for the canonical final
    // redactor/guard. An unfinished opaque word never crosses a preview boundary.
    const dangerous = /```|-----BEGIN|https?:\/\/|\b(?:authorization|bearer|[a-z0-9_.-]*(?:key|secret|token|password|passwd|webhook)[a-z0-9_.-]*)\b\s*(?:[:=]|\s*$)/iu.exec(raw);
    let end = 0;
    if (final) end = raw.length;
    else for (const match of raw.matchAll(/\s|[。！？!?]|[^\x00-\x7f]/gu)) end = match.index! + match[0].length;
    if (dangerous) end = Math.min(end, dangerous.index);
    // A secret can contain whitespace/punctuation. Keep every incomplete known-secret suffix,
    // including its earliest characters, rather than showing a prefix and retracting it later.
    for (const value of known) for (let length = Math.min(raw.length, value.length - 1); length > 0; length--) {
      if (raw.endsWith(value.slice(0, length))) { end = Math.min(end, raw.length - length); break; }
    }
    for (const value of known) {
      let at = raw.indexOf(value);
      while (at >= 0 && at < end) { if (at + value.length > end) end = at; at = raw.indexOf(value, at + value.length); }
    }
    const candidate = raw.slice(0, end);
    if (requestsCredentialDisclosure(candidate)) { stopped = true; cancel(); return; }
    const next = redactToolSubprocessOutput(candidate, input.source);
    if (!next.startsWith(sent)) { stopped = true; cancel(); return; }
    safe = next;
    if (!sent) flush(); // First safe text has no timer wait.
    else if (safe !== sent && timer === undefined) timer = (input.schedule ?? (callback => setTimeout(callback, 16)))(flush);
  };
  return {
    push(delta: string) {
      if (stopped || !delta || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(delta)) return;
      if (raw.length + delta.length > 24_000) { stopped = true; cancel(); return; }
      raw += delta; prepare(false);
    },
    finish() { prepare(true); flush(); },
    stop() { stopped = true; raw = ""; safe = ""; cancel(); },
  };
}
