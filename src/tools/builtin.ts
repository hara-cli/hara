import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, isAbsolute } from "node:path";
import { stdout as procOut } from "node:process";
import { registerTool } from "./registry.js";
import { runShell } from "../sandbox.js";
import { nearestPaths } from "../fs-walk.js";
import { emitDiff } from "../diff.js";
import { recordEdit } from "../undo.js";
import { atomicWriteText, bindAtomicWritePath, type AtomicWriteBoundary } from "../fs-write.js";
import { invalidateFileCandidates } from "../context/mentions.js";
import { BinaryFileError, readVerifiedRegularFileSnapshot, resolveVerifiedModelPath, streamFileSlice } from "../fs-read.js";
import { startJob, listJobs, tailJob, killJob } from "../exec/jobs.js";
import { sensitiveFileError, sensitiveShellCommandReason } from "../security/sensitive-files.js";
import { createToolOutputLineRedactor, redactToolSubprocessOutput } from "../security/subprocess-env.js";
import {
  hostsInCommand,
  isNetworkGitOp,
  hostFromConnectError,
  isConnectFailure,
  markHostUnreachable,
  isHostUnreachable,
  unreachableHostsSnapshot,
} from "./net-reachability.js";

const MAX = 100_000;

/** Package installs are network-bound and routinely exceed the ordinary foreground cap. */
export function isPackageInstallCommand(command: string): boolean {
  return /(?:^|[;&|]\s*)(?:npm\s+(?:i|install|ci)\b|pnpm\s+(?:i|install|add)\b|yarn(?:\s+(?:install|add))?(?:\s|$)|bun\s+(?:i|install|add)\b)/i.test(command.trim());
}

/** Resolve a bounded foreground timeout. Installs get a longer default, but remain attached so a headless
 * run cannot exit, kill its background child, and leave node_modules half-written. */
export function shellTimeoutMs(command: string, requested?: number): number {
  if (Number.isFinite(requested) && (requested as number) > 0) {
    return Math.min(Math.max(Math.trunc(requested as number), 1_000), 3_600_000);
  }
  return isPackageInstallCommand(command) ? 900_000 : 300_000;
}

export function isNgrokTunnelCommand(command: string): boolean {
  return /(?:^|[;&|]\s*)ngrok\s+(?:http|tcp|tls|start)\b/i.test(command.trim());
}

/** Read only the presence of ngrok auth — never return or print its value. */
export function ngrokAuthConfigured(env: NodeJS.ProcessEnv = process.env, home = homedir()): boolean {
  if (env.NGROK_AUTHTOKEN || env.NGROK_API_KEY) return true;
  const files = [
    resolve(home, ".config/ngrok/ngrok.yml"),
    resolve(home, "Library/Application Support/ngrok/ngrok.yml"),
    resolve(home, ".ngrok2/ngrok.yml"),
  ];
  for (const file of files) {
    try {
      if (existsSync(file) && /^\s*(?:authtoken|api_key)\s*:\s*\S+/im.test(readFileSync(file, "utf8"))) return true;
    } catch {
      /* unreadable config counts as unconfigured */
    }
  }
  return false;
}

/** Resolve the remote HOST a bare `git pull/fetch/push` targets (no URL in the command → host lives in the
 *  repo's remote config). Local + fast (no network); best-effort — returns "" on any hiccup. Only ever
 *  called after a host has already been marked unreachable, so it adds zero overhead on the happy path. */
async function gitRemoteHost(command: string, cwd: string, sandbox: Parameters<typeof runShell>[2]): Promise<string> {
  const m = command.match(/\bgit\b[^\n]*\b(?:fetch|pull|push)\b\s+(?!-)(\S+)/);
  const remote = m && /^[\w./-]+$/.test(m[1]) ? m[1] : "origin";
  try {
    const { stdout } = await runShell(`git remote get-url ${remote}`, cwd, sandbox, { timeout: 5000, maxBuffer: 65536 });
    return hostsInCommand(stdout.trim())[0] ?? "";
  } catch {
    return "";
  }
}

/** git ignores the macOS system / Clash proxy unless told to — so a browser that reaches GitHub doesn't
 *  mean the terminal does. Appended to connectivity-failure output so the agent diagnoses instead of retrying. */
function proxyHint(host: string): string {
  const h = host || "the remote host";
  return `\n\n↯ hara: this is a CONNECTIVITY failure to ${h} (timeout/DNS), not an auth error — I will NOT retry network ops to ${h} for the rest of this session (a repeat just hangs ~75s again). git does NOT use the macOS system/Clash proxy unless configured; check \`git config --global http.proxy\` and \`echo $https_proxy $ALL_PROXY\`. If you've since started a VPN/proxy or fixed DNS, tell me and I'll clear the mark and retry.`;
}

function abs(p: string, cwd: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function cap(s: string): string {
  return s.length > MAX ? s.slice(0, MAX) + `\n…[truncated ${s.length - MAX} chars]` : s;
}

/** Truncate keeping the HEAD and the TAIL — for command output, where the start gives context but the END
 *  usually holds the error/result, so plain head-truncation would cut exactly the part that matters most. */
export function capHeadTail(s: string, max = MAX): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.6);
  return s.slice(0, head) + `\n…[${s.length - max} chars truncated]…\n` + s.slice(s.length - (max - head));
}

const READ_LINES = 300; // sized to stay useful under the global 24k-char tool-result context boundary
const LINE_CAP = 2000; // chars per line before truncation (minified bundles / data lines)
/** Render a line slice of a file, cat -n style. The old read_file dumped the WHOLE file (100K-char cap,
 *  tail simply lost) — on long files that both flooded the context (~25k tokens per read, again on every
 *  re-read) and made everything past the cap unreachable. Now: line numbers (anchor for edits and for
 *  "read around line N"), a default window of READ_LINES, and a header that says how to continue. Pure —
 *  exported for tests. */
export function renderFileSlice(text: string, offset?: number, limit?: number): string {
  const lines = text.split("\n");
  // A trailing newline yields one phantom "" line at the end — don't count or show it.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const total = lines.length;
  const start = Math.max(1, Math.floor(offset ?? 1));
  const want = Math.max(1, Math.floor(limit ?? READ_LINES));
  if (start > total) return `(file has ${total} lines — offset ${start} is past the end)`;
  const end = Math.min(total, start + want - 1);
  const body = lines
    .slice(start - 1, end)
    .map((l, i) => `${String(start + i).padStart(6)}\t${l.length > LINE_CAP ? l.slice(0, LINE_CAP) + `…[+${l.length - LINE_CAP} chars]` : l}`)
    .join("\n");
  const sliced = start > 1 || end < total;
  const head = sliced ? `(lines ${start}–${end} of ${total}${end < total ? ` — continue with offset:${end + 1}` : ""})\n` : "";
  return head + body;
}

registerTool({
  name: "read_file",
  description:
    "Read a UTF-8 text file; returns cat -n style numbered lines. Reads up to 300 lines by default — for a longer file pass offset/limit to read the next slice (the header tells you where to continue). Large files are streamed instead of loaded whole. Prefer grep to locate, then read just that region.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to cwd or absolute" },
      offset: { type: "number", description: "1-based line number to start from (for long files)" },
      limit: { type: "number", description: "max lines to return (default 300)" },
    },
    required: ["path"],
  },
  kind: "read",
  async run(input, ctx) {
    const p = abs(input.path, ctx.cwd);
    const denied = sensitiveFileError(p, "read");
    if (denied) return denied;
    try {
      const target = resolveVerifiedModelPath(p, "read");
      // streamFileSlice opens O_NONBLOCK, validates the same fd as a regular file, and stops after the
      // requested window. Using it for every size removes the path-level stat→read race entirely.
      return cap(await streamFileSlice(target, input.offset, input.limit ?? READ_LINES, {
        lineCap: LINE_CAP,
        protectSensitive: true,
      }));
    } catch (e: any) {
      if (e instanceof BinaryFileError) return `Error: cannot read ${input.path}: file appears binary; use an image/media-specific tool or inspect it with \`file\`.`;
      const near = nearestPaths(ctx.cwd, input.path);
      return `Error: cannot read ${input.path}: ${e.message ?? e.code}.` + (near.length ? ` Did you mean: ${near.join(", ")}?` : "");
    }
  },
});

registerTool({
  name: "write_file",
  description: "Create or overwrite a UTF-8 text file (creates parent directories).",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  kind: "edit",
  async run(input, ctx) {
    const p = abs(input.path, ctx.cwd);
    const denied = sensitiveFileError(p, "write");
    if (denied) return denied;
    if (typeof input.content !== "string") return "Error: write_file `content` must be a string. No changes written.";
    let prevSnapshot: Awaited<ReturnType<typeof readVerifiedRegularFileSnapshot>> | null = null;
    let boundary: AtomicWriteBoundary | undefined;
    try {
      boundary = bindAtomicWritePath(p, "write");
      prevSnapshot = await readVerifiedRegularFileSnapshot(boundary.target, undefined, "write");
    } catch (error: any) {
      if (error?.code !== "ENOENT" || !boundary) return `Error: cannot inspect ${input.path}: ${error?.message ?? error?.code}. No changes written.`;
    }
    if (!boundary) return `Error: cannot bind ${input.path} to a stable parent. No changes written.`;
    const prev = prevSnapshot?.text ?? null;
    if (prev === input.content) return `Unchanged ${p} (${input.content.length} chars already match).`;
    let committed;
    try {
      committed = await atomicWriteText(boundary.target, input.content, {
        expected: prev,
        expectedIdentity: prevSnapshot ?? undefined,
        boundary,
      });
    } catch (error: any) {
      return `Error: cannot write ${input.path}: ${error?.message ?? String(error)} No changes written.`;
    }
    emitDiff(input.path, prev ?? "", input.content, ctx.ui);
    recordEdit([{ path: input.path, absPath: boundary.target, before: prev, beforeMode: prevSnapshot?.mode, committed, after: input.content }]);
    invalidateFileCandidates(ctx.cwd);
    return `Wrote ${String(input.content).length} chars to ${p}` + (committed.warnings?.length ? ` Warning: ${committed.warnings.join("; ")}` : "");
  },
});

registerTool({
  name: "bash",
  description: "Run a shell command in the working directory; returns combined stdout/stderr.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout_ms: { type: "number", description: "default 300000 (5 min), or 900000 (15 min) for package installs; bounded to 1s..1h" },
      background: { type: "boolean", description: "run as a background job (dev server, watcher, long task); package installs stay foreground unless explicitly requested" },
    },
    required: ["command"],
  },
  kind: "exec",
  async run(input, ctx) {
    const protectedReason = sensitiveShellCommandReason(String(input.command ?? ""), ctx.cwd);
    if (protectedReason) {
      return (
        `Blocked: shell command crosses Hara's protected secret boundary (${protectedReason}). ` +
        "This deny is not bypassed by full-auto. Restart hara with HARA_ALLOW_SENSITIVE_FILES=1 only for an intentional, user-approved exposure."
      );
    }
    if (isNgrokTunnelCommand(input.command) && !ngrokAuthConfigured()) {
      return (
        "Skipped ngrok tunnel: no authentication was found in NGROK_AUTHTOKEN/NGROK_API_KEY or the standard ngrok config files. " +
        "Configure ngrok authentication first, then retry. Do not rotate through other tunnel providers blindly; ask the user which authenticated provider to use."
      );
    }
    if (input.background) {
      const id = startJob(input.command, ctx.cwd, ctx.sandbox ?? "off");
      const safeCommand = redactToolSubprocessOutput(String(input.command));
      return `Started background job ${id}: \`${safeCommand}\`. Manage with the \`job\` tool — {action:"tail",id:"${id}"} for output, {action:"kill",id:"${id}"} to stop, {action:"list"} for all. Poll until it exits before running steps that depend on it.`;
    }
    // Network fault tolerance — short-circuit if this command targets a host already found unreachable this
    // session, so a repeat doesn't burn another ~75s OS connect timeout. Only pays the git-remote lookup
    // once something is actually marked (unreachableHostsSnapshot empty ⇒ zero overhead on the happy path).
    if (unreachableHostsSnapshot().length) {
      const explicit = hostsInCommand(input.command);
      let blocked = explicit.find(isHostUnreachable) ?? "";
      if (!blocked && !explicit.length && isNetworkGitOp(input.command)) {
        const h = await gitRemoteHost(input.command, ctx.cwd, ctx.sandbox ?? "off");
        if (h && isHostUnreachable(h)) blocked = h;
      }
      if (blocked) {
        ctx.ui?.notice(`↯ skipping — ${blocked} was unreachable earlier this session`);
        return `Skipped without running: host "${blocked}" already failed to connect earlier in THIS session — hara does not retry network operations to a host known unreachable this session (a retry just hangs ~75s again). Do not swap in a public mirror (won't serve private repos) or switch protocols; diagnose instead.${proxyHint(blocked)}`;
      }
    }
    const liveEmit = ctx.ui
      ? (line: string) => ctx.ui!.notice(line.replace(/\r?\n$/, ""))
      : procOut.isTTY
        ? (line: string) => procOut.write(line)
        : null;
    // stdout/stderr are independent byte streams. A shared partial-line buffer could splice stderr into
    // the middle of a stdout credential and defeat exact-value redaction in the live UI.
    const liveStdout = liveEmit ? createToolOutputLineRedactor(liveEmit) : null;
    const liveStderr = liveEmit ? createToolOutputLineRedactor(liveEmit) : null;
    const live = liveEmit
      ? (s: string, stream: "stdout" | "stderr") => (stream === "stdout" ? liveStdout : liveStderr)!.push(s)
      : undefined;
    const flushLive = (): void => { liveStdout?.flush(); liveStderr?.flush(); };
    const timeout = shellTimeoutMs(input.command, input.timeout_ms);
    try {
      const { stdout, stderr } = await runShell(input.command, ctx.cwd, ctx.sandbox ?? "off", {
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        onData: live,
      });
      flushLive();
      const combined = (stdout || "") + (stderr ? `\n[stderr]\n${stderr}` : "");
      return capHeadTail(redactToolSubprocessOutput(combined.trim() || "(no output)"));
    } catch (e: any) {
      flushLive();
      let base = `Command failed: ${e.message}\n${e.stdout || ""}${e.stderr || ""}`;
      // Timeout gets an ACTIONABLE next step, not just a corpse — the model (and user) should pick a
      // lane instead of blind-retrying into the same wall.
      if (/timed out after \d+ms/.test(String(e.message))) {
        base +=
          `\n⏱ hara: the command hit its ${timeout}ms cap and was killed. Pick ONE: ` +
          `a long build/transform → re-run with a larger timeout_ms; a server/watcher → background:true; ` +
          `a network op (git/curl/npm) → do NOT just retry — check connectivity/proxy or skip this step and tell the user.`;
      }
      // Network fault tolerance — if this was a genuine host-unreachability (connect timeout / DNS, NOT
      // auth / 404 / connection-refused), remember the host so we fast-fail future ops to it this session.
      if (isConnectFailure(base)) {
        let host = hostFromConnectError(base) || hostsInCommand(input.command)[0] || "";
        if (!host && isNetworkGitOp(input.command)) host = await gitRemoteHost(input.command, ctx.cwd, ctx.sandbox ?? "off");
        if (host) {
          markHostUnreachable(host);
          ctx.ui?.notice(`↯ ${host} marked unreachable for this session — won't retry network ops to it`);
          return capHeadTail(redactToolSubprocessOutput(base + proxyHint(host)));
        }
      }
      return capHeadTail(redactToolSubprocessOutput(base));
    }
  },
});

registerTool({
  name: "job",
  description: "Manage background shell jobs (started via bash {background:true}) — dev servers, watchers, long tasks. action: list | tail | kill.",
  input_schema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "tail", "kill"] },
      id: { type: "string", description: "job id (required for tail/kill)" },
      lines: { type: "number", description: "tail: number of trailing lines to show (default 40)" },
    },
    required: ["action"],
  },
  kind: "read", // manages only the agent's own background jobs; safe to run unconfirmed
  async run(input) {
    const action = String(input.action);
    if (action === "list") {
      const js = listJobs();
      if (!js.length) return "(no background jobs)";
      return js.map((j) => `${j.id}  [${j.status}${j.code != null ? " " + j.code : ""}]  ${Math.round(j.ageMs / 1000)}s  ${redactToolSubprocessOutput(j.command)}`).join("\n");
    }
    const id = String(input.id ?? "");
    if (!id) return "Error: `id` is required for tail/kill.";
    if (action === "tail") {
      const t = tailJob(id, Number(input.lines) || 40);
      return t == null ? `No job ${id}.` : redactToolSubprocessOutput(t.trim() || "(no output yet)");
    }
    if (action === "kill") return killJob(id) ? `Killed ${id}.` : `No running job ${id} (already exited/killed or unknown).`;
    return `Error: unknown action '${action}'.`;
  },
});
