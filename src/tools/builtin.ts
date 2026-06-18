import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, isAbsolute } from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { registerTool } from "./registry.js";

const pexec = promisify(exec);
const MAX = 100_000;

function abs(p: string, cwd: string): string {
  return isAbsolute(p) ? p : resolve(cwd, p);
}

function cap(s: string): string {
  return s.length > MAX ? s.slice(0, MAX) + `\n…[truncated ${s.length - MAX} chars]` : s;
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
    return cap(await readFile(abs(input.path, ctx.cwd), "utf8"));
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
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, input.content, "utf8");
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
      timeout_ms: { type: "number", description: "default 120000" },
    },
    required: ["command"],
  },
  kind: "exec",
  async run(input, ctx) {
    try {
      const { stdout, stderr } = await pexec(input.command, {
        cwd: ctx.cwd,
        timeout: input.timeout_ms ?? 120_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const combined = (stdout || "") + (stderr ? `\n[stderr]\n${stderr}` : "");
      return cap(combined.trim() || "(no output)");
    } catch (e: any) {
      return cap(`Command failed: ${e.message}\n${e.stdout || ""}${e.stderr || ""}`);
    }
  },
});
