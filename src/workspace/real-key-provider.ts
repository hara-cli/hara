import { randomUUID } from "node:crypto";
import { bindPrivateHaraStateFile, readPrivateStateFileSnapshotSync, withPrivateStateLockSync, writePrivateStateFileSync } from "../security/private-state.js";
import { createOpenAIProvider } from "../providers/openai.js";
import type { Provider, TurnArgs, TurnResult } from "../providers/types.js";
import { captureWorkspaceFileCredential, resolveWorkspaceFileCredential, type WorkspaceFileCredential } from "./file-credential.js";
import type { ScopedConnection, ScopedConnectionInput, ScopedRunConnection } from "./scoped-connections.js";
import { canonical, exact, plain } from "./local-state.js";

export const ARK_REAL_KEY_SLICE = Object.freeze({ mode: "ark-real-key" as const,
  baseURL: "https://ark.cn-beijing.volces.com/api/coding/v3", model: "deepseek-v4-1-flash-260910",
  maxTokens: 300_000, maxRequests: 24, maxOutputTokens: 4096 });
interface RequestReceipt { id: string; startedAt: string; endedAt: string | null; state: "pending" | "complete" | "unknown";
  reserved: number; input: number; output: number; httpStatus: number | null }
interface Ledger { schemaVersion: 1; mode: "ark-real-key"; credentialFile: WorkspaceFileCredential; requests: RequestReceipt[] }
const paused = () => new Error("本次火山實測已暫停；請檢查本機預算回執並由 Jeff 決定。沒有重送或切換模型。");

/** One explicit, persisted acceptance budget across ALL Workspaces, Agents, runs and restarts in this
 * fixture. It is NOT a general BYOK or fallback route. Credentials are only read just before the request. */
export class WorkspaceRealKeyLane {
  private readonly reference: WorkspaceFileCredential;
  constructor(private readonly root: string, keyFile: string, private readonly wireFetch: typeof fetch = fetch) {
    this.reference = captureWorkspaceFileCredential(keyFile);
    this.update(value => value); // freeze this exact file generation on first boot; never reset usage
  }
  private update(change: (value: Ledger) => Ledger): Ledger {
    return withPrivateStateLockSync(this.root, [], "real-key-budget", () => {
      const file = bindPrivateHaraStateFile(this.root, [], "real-key-budget-v1.json"), before = readPrivateStateFileSnapshotSync(file.path, 64 * 1024);
      let value: Ledger;
      try {
        value = before ? JSON.parse(before.text) : { schemaVersion: 1, mode: "ark-real-key", credentialFile: this.reference, requests: [] };
        if (!plain(value) || !exact(value as unknown as Record<string, unknown>, ["schemaVersion", "mode", "credentialFile", "requests"])
          || value.schemaVersion !== 1 || value.mode !== "ark-real-key" || canonical(value.credentialFile) !== canonical(this.reference)
          || !Array.isArray(value.requests) || value.requests.length > ARK_REAL_KEY_SLICE.maxRequests) throw new Error();
        const ids = new Set<string>();
        for (const row of value.requests) {
          if (!plain(row) || !exact(row as unknown as Record<string, unknown>, ["id", "startedAt", "endedAt", "state", "reserved", "input", "output", "httpStatus"])
            || typeof row.id !== "string" || ids.has(row.id) || !Number.isFinite(Date.parse(row.startedAt))
            || (row.endedAt !== null && !Number.isFinite(Date.parse(row.endedAt))) || !["pending", "complete", "unknown"].includes(row.state)
            || ![row.reserved, row.input, row.output].every(n => Number.isSafeInteger(n) && n >= 0)
            || (row.state === "complete" && row.input + row.output > row.reserved)
            || (row.httpStatus !== null && (!Number.isInteger(row.httpStatus) || row.httpStatus < 100 || row.httpStatus > 599))) throw new Error();
          ids.add(row.id);
        }
      } catch { throw paused(); }
      const next = change(value);
      writePrivateStateFileSync(file, JSON.stringify(next) + "\n", before ? { expectedText: before.text } : { expectedMissing: true });
      return next;
    });
  }
  summary() {
    const value = this.update(v => v), complete = value.requests.filter(row => row.state === "complete");
    return { mode: ARK_REAL_KEY_SLICE.mode, model: ARK_REAL_KEY_SLICE.model, maxTokens: ARK_REAL_KEY_SLICE.maxTokens,
      maxRequests: ARK_REAL_KEY_SLICE.maxRequests, requests: value.requests.length,
      inputTokens: complete.reduce((sum, row) => sum + row.input, 0), outputTokens: complete.reduce((sum, row) => sum + row.output, 0),
      uncertainReservedTokens: value.requests.filter(row => row.state !== "complete").reduce((sum, row) => sum + row.reserved, 0),
      paused: value.requests.some(row => row.state !== "complete") };
  }
  connectionInput(): ScopedConnectionInput {
    resolveWorkspaceFileCredential(this.reference);
    return { label: "火山 Coding Plan · 本機授權實測", provider: "openai", baseURL: ARK_REAL_KEY_SLICE.baseURL,
      defaultModel: ARK_REAL_KEY_SLICE.model, credentialFile: { ...this.reference } };
  }
  private reserve(body: string): string {
    const reserved = Buffer.byteLength(body, "utf8") + 8192 + ARK_REAL_KEY_SLICE.maxOutputTokens, id = randomUUID();
    this.update(value => {
      const used = value.requests.reduce((sum, row) => sum + (row.state === "complete" ? row.input + row.output : row.reserved), 0);
      // JSON UTF-8 bytes + ample protocol overhead is a conservative input-token upper bound for this
      // approved text-only route. Unknown/crashed reservations are never automatically refunded/replayed.
      if (value.requests.some(row => row.state !== "complete") || value.requests.length >= ARK_REAL_KEY_SLICE.maxRequests
        || used + reserved > ARK_REAL_KEY_SLICE.maxTokens) throw paused();
      value.requests.push({ id, startedAt: new Date().toISOString(), endedAt: null, state: "pending", reserved,
        input: 0, output: 0, httpStatus: null }); return value;
    }); return id;
  }
  private finish(id: string, result: TurnResult | undefined, httpStatus: number | null): boolean {
    let complete = false;
    this.update(value => {
      const row = value.requests.find(row => row.id === id);
      if (!row || row.state !== "pending") throw paused();
      const input = result?.usage?.input, output = result?.usage?.output;
      complete = !!result && result.stop !== "error" && Number.isSafeInteger(input) && Number.isSafeInteger(output)
        && input! > 0 && output! >= 0 && input! + output! <= row.reserved && output! <= ARK_REAL_KEY_SLICE.maxOutputTokens;
      Object.assign(row, { state: complete ? "complete" : "unknown", endedAt: new Date().toISOString(), httpStatus,
        input: complete ? input : 0, output: complete ? output : 0 }); return value;
    }); return complete;
  }
  createProvider(connection: ScopedConnection, binding: ScopedRunConnection): Provider {
    if (connection.provider !== "openai" || connection.baseURL !== ARK_REAL_KEY_SLICE.baseURL || connection.apiKey !== undefined
      || canonical(connection.credentialFile) !== canonical(this.reference) || binding.model !== ARK_REAL_KEY_SLICE.model) throw paused();
    return { id: "openai", model: binding.model, supportsToolImages: false, trailingTurnContext: true,
      turn: async (args: TurnArgs): Promise<TurnResult> => {
        let requestId: string | undefined, httpStatus: number | null = null;
        try {
          if (args.signal?.aborted) throw paused();
          const key = resolveWorkspaceFileCredential(this.reference);
          const guardedFetch: typeof fetch = async (url, init) => {
            const target = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
            if (requestId || target !== `${ARK_REAL_KEY_SLICE.baseURL}/chat/completions` || init?.method !== "POST"
              || typeof init.body !== "string" || Buffer.byteLength(init.body) > 256 * 1024
              || new Headers(init.headers).get("authorization") !== `Bearer ${key}` || init.body.includes(key)) throw paused();
            const body = JSON.parse(init.body);
            if (body.model !== ARK_REAL_KEY_SLICE.model || body.max_tokens !== ARK_REAL_KEY_SLICE.maxOutputTokens || body.stream !== true) throw paused();
            resolveWorkspaceFileCredential(this.reference); // revalidate generation immediately before reservation/IO
            requestId = this.reserve(init.body);
            const response = await this.wireFetch(url, { ...init, redirect: "error",
              signal: AbortSignal.any([AbortSignal.timeout(90_000), ...(args.signal ? [args.signal] : []), ...(init.signal ? [init.signal] : [])]) });
            httpStatus = response.status; return response;
          };
          const provider = createOpenAIProvider({ apiKey: key, model: binding.model, baseURL: connection.baseURL,
            reasoningStyle: "deepseek", supportsImages: false, maxOutputTokens: ARK_REAL_KEY_SLICE.maxOutputTokens, fetch: guardedFetch });
          // Do not forward raw streamed fragments/errors. They may split a secret or echo headers; only
          // the checked neutral result can leave this adapter. Opaque reasoning stays host-private.
          const result = await provider.turn({ ...args, onText() {}, onReasoning() {} });
          const clean = !JSON.stringify(result).includes(key);
          if (!requestId || !this.finish(requestId, clean ? result : undefined, httpStatus)) throw paused();
          if (result.text) args.onText(result.text);
          return result;
        } catch {
          if (requestId) {
            // If finish already recorded the result, do not rewrite it on a later host-side exception.
            try { this.finish(requestId, undefined, httpStatus); } catch { /* original durable receipt retained */ }
          }
          const hint = httpStatus === 401 || httpStatus === 403 ? "供應商拒絕認證或權限。"
            : httpStatus === 429 ? "供應商回報限流或額度限制。" : httpStatus === 400 || httpStatus === 404 ? "供應商拒絕模型或協議。" : "";
          return { text: "", toolUses: [], stop: "error", errorMsg: `${hint}${paused().message}` };
        }
      } };
  }
}
