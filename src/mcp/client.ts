// MCP client — connect to configured MCP servers (stdio) and register their tools into hara.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { registerTool } from "../tools/registry.js";
import type { McpServerConfig } from "../config.js";
import { redactToolSubprocessOutput, toolSubprocessEnv } from "../security/subprocess-env.js";
import { sensitiveStructuredInputReason } from "../security/sensitive-files.js";

const clients: Client[] = [];
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const MIN_STARTUP_TIMEOUT_MS = 50;
const MAX_STARTUP_TIMEOUT_MS = 60_000;
const safeDiagnosticName = (name: string): string => name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 128) || "server";

export interface McpConnectOptions {
  /** The caller obtained an explicit startup grant from the interactive user. Launch-time
   * HARA_ALLOW_TRUSTED_EXTENSIONS=1 is the only non-interactive equivalent. */
  approved?: boolean;
  /** Upper bound for both MCP initialization and initial tool discovery. Primarily injectable so tests and
   * embedders do not have to wait for the production default when exercising an unresponsive server. */
  timeoutMs?: number;
}

function startupTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_STARTUP_TIMEOUT_MS;
  return Math.max(MIN_STARTUP_TIMEOUT_MS, Math.min(MAX_STARTUP_TIMEOUT_MS, Math.floor(value)));
}

async function closeFailedMcp(client: Client | undefined, transport: StdioClientTransport | undefined): Promise<void> {
  try {
    if (client) await client.close();
    else if (transport) await transport.close();
  } catch {
    // Client.close normally owns the transport. If it failed part-way through, make one direct best-effort
    // attempt so an unresponsive startup cannot leave its child process running in the background.
    try { await transport?.close(); } catch { /* preserve the original connect/list error */ }
  }
}

/** Drain MCP stderr without letting a server leak split credentials, inject terminal control bytes, or grow
 * an unbounded no-newline buffer. Oversized lines are dropped whole so even a partial token is never emitted. */
function mcpStderrRedactor(
  name: string,
  explicitEnv: Record<string, string> | undefined,
  log: (message: string) => void,
): { push(chunk: string): void; flush(): void } {
  const lineLimit = 16 * 1024;
  const totalLimit = 64 * 1024;
  const safeName = safeDiagnosticName(name);
  let pending = "";
  let droppingLine = false;
  let emitted = 0;
  let silenced = false;

  const emitOmitted = (): void => {
    if (silenced) return;
    const message = `mcp: ${safeName} stderr: [oversized diagnostic line omitted]`;
    if (emitted + message.length > totalLimit) {
      log(`mcp: ${safeName} stderr: [further diagnostics omitted]`);
      silenced = true;
      return;
    }
    emitted += message.length;
    log(message);
  };
  const emit = (raw: string): void => {
    if (silenced) return;
    const clean = redactToolSubprocessOutput(raw, process.env, explicitEnv ?? {})
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
      .replace(/\r?\n$/, "");
    if (!clean) return;
    const message = `mcp: ${safeName} stderr: ${clean}`;
    if (emitted + message.length > totalLimit) {
      log(`mcp: ${safeName} stderr: [further diagnostics omitted]`);
      silenced = true;
      return;
    }
    emitted += message.length;
    log(message);
  };

  return {
    push(chunk: string): void {
      if (silenced || !chunk) return;
      let start = 0;
      while (start < chunk.length && !silenced) {
        const newline = chunk.indexOf("\n", start);
        const end = newline < 0 ? chunk.length : newline + 1;
        const length = end - start;
        if (droppingLine) {
          if (newline >= 0) {
            droppingLine = false;
            emitOmitted();
          }
        } else if (pending.length + length > lineLimit) {
          pending = "";
          if (newline >= 0) emitOmitted();
          else droppingLine = true;
        } else {
          pending += chunk.slice(start, end);
          if (newline >= 0) {
            emit(pending);
            pending = "";
          }
        }
        start = end;
      }
    },
    flush(): void {
      if (droppingLine) emitOmitted();
      else if (pending) emit(pending);
      pending = "";
      droppingLine = false;
    },
  };
}

/** Connect each server, register its tools as `mcp__<server>__<tool>`. Returns #tools registered. */
export async function connectMcpServers(
  servers: Record<string, McpServerConfig>,
  log: (m: string) => void,
  options: McpConnectOptions = {},
): Promise<number> {
  // Starting a configured MCP server already executes arbitrary external code, before any MCP tool call
  // reaches the agent approval loop. Keep that side effect behind its own explicit startup grant even when
  // a future caller forgets to apply the CLI-level policy.
  if (!options.approved && process.env.HARA_ALLOW_TRUSTED_EXTENSIONS !== "1") {
    if (Object.keys(servers).length) {
      log(
        "mcp: skipped — configured servers are trusted extensions outside Hara's file boundary; " +
          "approve them interactively or set HARA_ALLOW_TRUSTED_EXTENSIONS=1 before launch after review",
      );
    }
    return 0;
  }

  const timeoutMs = startupTimeout(options.timeoutMs);
  const requestOptions = { timeout: timeoutMs, maxTotalTimeout: timeoutMs };
  let count = 0;
  for (const [name, cfg] of Object.entries(servers)) {
    const diagnosticName = safeDiagnosticName(name);
    let flushStderr: (() => void) | undefined;
    let transport: StdioClientTransport | undefined;
    let client: Client | undefined;
    let stage = "connect";
    try {
      transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args ?? [],
        // The inherited agent environment is scrubbed; server-specific cfg.env is an explicit grant.
        env: toolSubprocessEnv(process.env, cfg.env ?? {}) as Record<string, string>,
        // The SDK default is "inherit", which would let an external server print credentials or terminal
        // control sequences straight to Hara's stderr. Pipe it so every diagnostic crosses our redactor.
        stderr: "pipe",
      });
      const stderrRedactor = mcpStderrRedactor(name, cfg.env, log);
      flushStderr = () => stderrRedactor.flush();
      // `stderr` is available before connect() when piping is requested, so early startup errors are neither
      // lost nor inherited. Line buffering prevents a credential split across chunks from evading redaction.
      transport.stderr?.on("data", (chunk) => stderrRedactor.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)));
      transport.stderr?.on("end", flushStderr);
      transport.stderr?.on("close", flushStderr);
      client = new Client({ name: "hara", version: "0.4.0" }, { capabilities: {} });
      await client.connect(transport, requestOptions);

      stage = "list tools";
      const activeClient = client;
      const { tools } = await activeClient.listTools(undefined, requestOptions);
      for (const t of tools) {
        const schema = (t.inputSchema as any) ?? { type: "object", properties: {} };
        registerTool({
          name: `mcp__${name}__${t.name}`,
          description: t.description ?? `${name}/${t.name}`,
          input_schema: schema,
          kind: "exec",
          trustBoundary: "external",
          async run(input, ctx) {
            if (!ctx.ask && process.env.HARA_ALLOW_TRUSTED_EXTENSIONS !== "1") {
              return "Blocked: MCP is a trusted extension outside Hara's file boundary and is disabled in non-interactive runs. Set HARA_ALLOW_TRUSTED_EXTENSIONS=1 before launch only after reviewing the server.";
            }
            const protectedReason = sensitiveStructuredInputReason(input, ctx.cwd);
            if (protectedReason) return `Blocked: MCP input names protected ${protectedReason}.`;
            const res: any = await activeClient.callTool({ name: t.name, arguments: input ?? {} });
            const blocks: any[] = Array.isArray(res?.content) ? res.content : [];
            const text = blocks.map((b) => (b?.type === "text" ? b.text : JSON.stringify(b))).join("\n");
            return redactToolSubprocessOutput(text || "(no output)", process.env, cfg.env ?? {});
          },
        });
        count++;
      }
      clients.push(activeClient);
      log(`mcp: ${diagnosticName} → ${tools.length} tool(s)`);
    } catch (e: any) {
      // Do this before returning/logging: a timeout is not merely a failed request; the external process
      // must be torn down immediately and must not enter the global successful-client pool.
      await closeFailedMcp(client, transport);
      flushStderr?.();
      const error = redactToolSubprocessOutput(String(e?.message ?? e), process.env, cfg.env ?? {})
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
        .trim();
      log(`mcp: ${diagnosticName} failed during ${stage} (${error})`);
    }
  }
  return count;
}

export async function closeMcp(): Promise<void> {
  for (const cl of clients) {
    try {
      await cl.close();
    } catch {
      /* ignore */
    }
  }
  clients.length = 0;
}
