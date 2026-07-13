// external_agent — delegate a self-contained task to an EXTERNAL coding-agent CLI (claude-code / codex / …)
// running headless on the host, and return its final text. Inspired by openclaw's ACP subagent feature, but
// zero-dep: we drive each agent's native headless flag (`claude -p`, `codex exec`) over node:child_process
// instead of the heavy ACP/acpx stack.
//
// Safety: kind:"exec" → inherits the loop's approval gate. It can read/write/run on the host, so it is the most
// privileged tool — and because fan-out sub-agents only get the read-only allow-list (READONLY_TOOLS), they
// never see this tool. Trust tiers (off|gated|full) gate the dangerous bypass/full-access sub-modes.
import { spawn, execFileSync } from "node:child_process";
import { platform } from "node:os";
import { registerTool, type ToolContext } from "./registry.js";
import { capHeadTail } from "./builtin.js";
import { loadConfig } from "../config.js";
import type { SandboxMode } from "../sandbox.js";
import {
  createToolOutputLineRedactor,
  redactToolSubprocessOutput,
  terminateSubprocessTree,
  toolSubprocessEnv,
} from "../security/subprocess-env.js";

export type Trust = "off" | "gated" | "full";

export interface ExternalArgvOpts {
  cwd: string;
  model?: string;
  sandbox: SandboxMode;
  trust: Trust;
}

/** Pure: build the spawn (cmd, args) for a backend, or null if unknown. Maps hara's sandbox/trust → the agent's
 *  own permission flags; the dangerous bypass/full-access modes are only reachable at trust "full". */
export function buildExternalArgv(backend: string, task: string, o: ExternalArgvOpts): { cmd: string; args: string[] } | null {
  if (backend === "claude") {
    const mode = o.trust === "full" ? "bypassPermissions" : o.sandbox === "workspace-write" ? "acceptEdits" : "plan";
    return { cmd: "claude", args: ["-p", task, "--output-format", "text", ...(o.model ? ["--model", o.model] : []), "--permission-mode", mode] };
  }
  if (backend === "codex") {
    const sb = o.trust === "full" ? "danger-full-access" : o.sandbox === "workspace-write" ? "workspace-write" : "read-only";
    return { cmd: "codex", args: ["exec", task, "--cd", o.cwd, ...(o.model ? ["-m", o.model] : []), "--sandbox", sb] };
  }
  return null;
}

const BUILTIN_BACKENDS = ["claude", "codex"];
const EXTERNAL_CAPTURE_PER_STREAM = 2 * 1024 * 1024;
const EXTERNAL_OUTPUT_KILL_LIMIT = 4 * 1024 * 1024;

export function appendBoundedExternalOutput(current: string, chunk: string, limit = EXTERNAL_CAPTURE_PER_STREAM): string {
  if (!Number.isSafeInteger(limit) || limit < 1) return "";
  const combined = current + chunk;
  if (combined.length <= limit) return combined;
  const marker = "\n…[external output truncated]…\n";
  const retained = Math.max(0, limit - marker.length);
  const head = Math.floor(retained / 4);
  const tail = retained - head;
  return combined.slice(0, head) + marker.slice(0, limit - head - tail) + (tail ? combined.slice(-tail) : "");
}

/** Probe a CLI's availability via `<bin> --version` (cached per process). */
const availCache = new Map<string, boolean>();
function available(bin: string): boolean {
  if (availCache.has(bin)) return availCache.get(bin)!;
  let ok = false;
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore", timeout: 5000, env: toolSubprocessEnv() });
    ok = true;
  } catch {
    ok = false;
  }
  availCache.set(bin, ok);
  return ok;
}

function resolveTrust(): Trust {
  const cfg = loadConfig() as any;
  const v = (process.env.HARA_EXTERNAL_AGENT_TRUST ?? cfg.externalAgentTrust ?? "gated") as Trust;
  return v === "off" || v === "full" ? v : "gated";
}

registerTool({
  name: "external_agent",
  description:
    "Delegate a self-contained coding task to an EXTERNAL agent CLI — `claude` (Claude Code) or `codex` — " +
    "running headless in the current directory, and return its result. Use for heavy, isolated work you want " +
    "another agent to own end-to-end. It can read/write/run on the host, so it's gated by approval. " +
    "Args: task (required), backend (claude|codex; default = first installed), model (optional).",
  kind: "exec", // → approval gate; never exposed to read-only fan-out sub-agents
  trustBoundary: "external",
  input_schema: {
    type: "object",
    properties: {
      task: { type: "string", description: "the self-contained task for the external agent" },
      backend: { type: "string", description: "claude | codex (default: first available on PATH)" },
      model: { type: "string", description: "optional model id override for the external agent" },
      timeout_ms: { type: "number", description: "hard cap in ms (default 600000, max 1800000)" },
    },
    required: ["task"],
  },
  async run(input: any, ctx: ToolContext): Promise<string> {
    if (!ctx.ask && process.env.HARA_ALLOW_TRUSTED_EXTENSIONS !== "1") {
      return (
        "Blocked: external_agent runs another host coding agent outside Hara's protected-file boundary. " +
        "Use it interactively after approval, or restart with HARA_ALLOW_TRUSTED_EXTENSIONS=1 only after reviewing that agent."
      );
    }
    const trust = resolveTrust();
    if (trust === "off") return "external_agent is disabled (set externalAgentTrust to gated|full, or HARA_EXTERNAL_AGENT_TRUST).";
    const task = typeof input.task === "string" ? input.task.trim() : "";
    if (!task) return "external_agent needs a non-empty `task`.";

    const installed = BUILTIN_BACKENDS.filter((b) => available(b));
    const backend = String(input.backend ?? "").trim() || installed[0] || "";
    if (!BUILTIN_BACKENDS.includes(backend)) return `Unknown backend '${backend || "(none)"}'. Supported: ${BUILTIN_BACKENDS.join(", ")}.`;
    if (!available(backend)) return `'${backend}' CLI not found on PATH. Installed external agents: ${installed.join(", ") || "none"}.`;

    const built = buildExternalArgv(backend, task, { cwd: ctx.cwd, model: input.model ? String(input.model) : undefined, sandbox: ctx.sandbox ?? "off", trust });
    if (!built) return `Unknown backend '${backend}'.`;
    const timeout = Math.min(Math.max(30_000, Number(input.timeout_ms) || 600_000), 1_800_000);

    return await new Promise<string>((resolve) => {
      const processGroup = platform() !== "win32";
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(built.cmd, built.args, {
          cwd: ctx.cwd,
          env: toolSubprocessEnv(),
          detached: processGroup,
        });
      } catch (error) {
        resolve(redactToolSubprocessOutput(`[${backend}] failed to start: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      let out = "";
      let err = "";
      let outputBytes = 0;
      let done = false;
      let stoppingReason: string | null = null;
      let forceIssued = false;
      let closeBeforeForce = false;
      let cancelTermination: ((cancelForce?: boolean) => void) | undefined;
      const liveOut = ctx.ui ? createToolOutputLineRedactor((line) => ctx.ui!.notice(line.replace(/\r?\n$/, ""))) : null;
      const liveErr = ctx.ui ? createToolOutputLineRedactor((line) => ctx.ui!.notice(line.replace(/\r?\n$/, ""))) : null;
      const finish = (s: string): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // A stopped tree must still receive its scheduled group KILL even if the direct shell closed first.
        // The default cancellation removes only the wall-clock fallback, not the force timer.
        cancelTermination?.();
        liveOut?.flush();
        liveErr?.flush();
        resolve(capHeadTail(redactToolSubprocessOutput(s)));
      };
      const stoppedText = (): string => {
        const text = out.trim() || "(external agent produced no output)";
        return `${stoppingReason}\n${text}${err ? `\n[stderr]\n${err.trim()}` : ""}`;
      };
      const stopTree = (reason: string): void => {
        if (done || stoppingReason) return;
        stoppingReason = reason;
        cancelTermination = terminateSubprocessTree(child, {
          processGroup,
          graceMs: 2_000,
          fallbackMs: 3_000,
          onForce: () => {
            forceIssued = true;
            if (closeBeforeForce) finish(stoppedText());
          },
          onFallback: () => {
            // A deliberately daemonized descendant may retain the pipes after escaping the owned group.
            child.stdout?.destroy();
            child.stderr?.destroy();
            finish(stoppedText());
          },
        });
      };
      const timer = setTimeout(() => {
        stopTree(`[${backend}] timed out after ${timeout}ms`);
      }, timeout);
      child.stdin?.on("error", () => { /* a backend may exit before stdin.end(); close/error settles it */ });
      child.stdin?.end(); // task is passed via argv
      child.stdout?.on("data", (d: Buffer) => {
        if (done || stoppingReason) return;
        const text = d.toString();
        outputBytes += d.length;
        out = appendBoundedExternalOutput(out, text);
        liveOut?.push(text);
        if (outputBytes > EXTERNAL_OUTPUT_KILL_LIMIT) {
          stopTree(`[${backend}] stopped after exceeding ${EXTERNAL_OUTPUT_KILL_LIMIT} output bytes`);
        }
      });
      child.stderr?.on("data", (d: Buffer) => {
        if (done || stoppingReason) return;
        const text = d.toString();
        outputBytes += d.length;
        err = appendBoundedExternalOutput(err, text);
        liveErr?.push(text);
        if (outputBytes > EXTERNAL_OUTPUT_KILL_LIMIT) {
          stopTree(`[${backend}] stopped after exceeding ${EXTERNAL_OUTPUT_KILL_LIMIT} output bytes`);
        }
      });
      child.on("error", (e) => {
        if (stoppingReason && !forceIssued) {
          closeBeforeForce = true;
          return;
        }
        finish(stoppingReason ? stoppedText() : `[${backend}] failed to start: ${e.message} (is it installed?)`);
      });
      child.on("close", (code) => {
        const text = out.trim() || "(external agent produced no output)";
        if (stoppingReason) {
          if (!forceIssued) {
            closeBeforeForce = true;
            return;
          }
          finish(stoppedText());
          return;
        }
        finish(code === 0 ? text : `[${backend} exit ${code}]\n${text}${err ? `\n[stderr]\n${err.trim()}` : ""}`);
      });
    });
  },
});
