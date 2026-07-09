import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, isAbsolute } from "node:path";
import { stdout as procOut } from "node:process";
import { registerTool } from "./registry.js";
import { runShell } from "../sandbox.js";
import { nearestPaths } from "../fs-walk.js";
import { emitDiff } from "../diff.js";
import { recordEdit } from "../undo.js";
import { startJob, listJobs, tailJob, killJob } from "../exec/jobs.js";

const MAX = 100_000;

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
      return capHeadTail(`Command failed: ${e.message}\n${e.stdout || ""}${e.stderr || ""}`);
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
