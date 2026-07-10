import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, isAbsolute } from "node:path";
import { stdout as procOut } from "node:process";
import { registerTool } from "./registry.js";
import { runShell } from "../sandbox.js";
import { nearestPaths } from "../fs-walk.js";
import { emitDiff } from "../diff.js";
import { recordEdit } from "../undo.js";
import { startJob, listJobs, tailJob, killJob } from "../exec/jobs.js";
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

registerTool({
  name: "read_file",
  description: "Read a UTF-8 text file and return its contents.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, relative to cwd or absolute" },
    },
    required: ["path"],
  },
  kind: "read",
  async run(input, ctx) {
    try {
      return cap(await readFile(abs(input.path, ctx.cwd), "utf8"));
    } catch (e: any) {
      const near = nearestPaths(ctx.cwd, input.path);
      return `Error: cannot read ${input.path}: ${e.code ?? e.message}.` + (near.length ? ` Did you mean: ${near.join(", ")}?` : "");
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
    let prev: string | null = null;
    try {
      prev = await readFile(p, "utf8");
    } catch {
      /* new file */
    }
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, input.content, "utf8");
    emitDiff(input.path, prev ?? "", input.content, ctx.ui);
    recordEdit([{ path: input.path, absPath: p, before: prev }]);
    return `Wrote ${String(input.content).length} chars to ${p}`;
  },
});

registerTool({
  name: "bash",
  description: "Run a shell command in the working directory; returns combined stdout/stderr.",
  input_schema: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout_ms: { type: "number", description: "default 300000 (5 min); raise for a long build/transform, or use background:true for a server" },
      background: { type: "boolean", description: "run as a background job (dev server, watcher, long task); returns a job id immediately — tail/kill it with the `job` tool" },
    },
    required: ["command"],
  },
  kind: "exec",
  async run(input, ctx) {
    if (input.background) {
      const id = startJob(input.command, ctx.cwd, ctx.sandbox ?? "off");
      return `Started background job ${id}: \`${input.command}\`. Manage with the \`job\` tool — {action:"tail",id:"${id}"} for output, {action:"kill",id:"${id}"} to stop, {action:"list"} for all.`;
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
    let buf = ""; // TUI: line-buffer live output into the sink (one notice per line)
    const live = ctx.ui
      ? (s: string) => {
          buf += s;
          let i: number;
          while ((i = buf.indexOf("\n")) >= 0) {
            ctx.ui!.notice(buf.slice(0, i));
            buf = buf.slice(i + 1);
          }
        }
      : procOut.isTTY
        ? (s: string) => procOut.write(s) // stream output in a plain terminal
        : undefined;
    try {
      const { stdout, stderr } = await runShell(input.command, ctx.cwd, ctx.sandbox ?? "off", {
        timeout: input.timeout_ms ?? 300_000, // was 120s — a long file transform/build legitimately runs longer
        maxBuffer: 10 * 1024 * 1024,
        onData: live,
      });
      if (ctx.ui && buf) ctx.ui.notice(buf); // flush trailing partial line
      const combined = (stdout || "") + (stderr ? `\n[stderr]\n${stderr}` : "");
      return capHeadTail(combined.trim() || "(no output)");
    } catch (e: any) {
      const base = `Command failed: ${e.message}\n${e.stdout || ""}${e.stderr || ""}`;
      // Network fault tolerance — if this was a genuine host-unreachability (connect timeout / DNS, NOT
      // auth / 404 / connection-refused), remember the host so we fast-fail future ops to it this session.
      if (isConnectFailure(base)) {
        let host = hostFromConnectError(base) || hostsInCommand(input.command)[0] || "";
        if (!host && isNetworkGitOp(input.command)) host = await gitRemoteHost(input.command, ctx.cwd, ctx.sandbox ?? "off");
        if (host) {
          markHostUnreachable(host);
          ctx.ui?.notice(`↯ ${host} marked unreachable for this session — won't retry network ops to it`);
          return capHeadTail(base + proxyHint(host));
        }
      }
      return capHeadTail(base);
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
      return js.map((j) => `${j.id}  [${j.status}${j.code != null ? " " + j.code : ""}]  ${Math.round(j.ageMs / 1000)}s  ${j.command}`).join("\n");
    }
    const id = String(input.id ?? "");
    if (!id) return "Error: `id` is required for tail/kill.";
    if (action === "tail") {
      const t = tailJob(id, Number(input.lines) || 40);
      return t == null ? `No job ${id}.` : t.trim() || "(no output yet)";
    }
    if (action === "kill") return killJob(id) ? `Killed ${id}.` : `No running job ${id} (already exited/killed or unknown).`;
    return `Error: unknown action '${action}'.`;
  },
});
