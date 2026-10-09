import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ToolSpec } from "../providers/types.js";
import type { ExternalTurnSink } from "../external-sessions/types.js";
import { normalizeExternalUserQuestions, validateExternalUserAnswers } from "../external-sessions/questions.js";
import { decodeUtf8Strict, verifyOpenedRegularFileSync } from "../fs-read.js";
import { optionalPosixOpenFlag } from "../fs-open-flags.js";
import { isUnsafeProjectWorkspace } from "../context/workspace-scope.js";
import { sensitiveFileReason } from "../security/sensitive-files.js";
import { redactSensitiveText } from "../security/secrets.js";
import { ORIGINAL_CODING_READ_FILE_TOOL, ORIGINAL_TASK_WRITE_FILE_TOOL, renderFileSlice } from "../tools/builtin.js";
import { ORIGINAL_TASK_EDIT_FILE_TOOL } from "../tools/edit.js";
import type { Tool, ToolContext } from "../tools/registry.js";

const MAX_TEXT = 1_000_000;
const MAX_READ_BYTES = 4 * 1024 * 1024;
const MAX_LIST_ENTRIES = 2_000;
const MAX_RESULT_CHARS = 24_000;
const MAX_APPROVAL_CHARS = 16_000;
const CONTROL = /[\u0000-\u001f\u007f]/u;

export interface CodingToolsetOptions {
  /** Trusted host MUST supply the already-admitted, Agent-owned isolated worktree, never model input. */
  cwd: string;
  signal: AbortSignal;
  /** Synchronous current execution/turn identity assertion. False, throw, or a promise is a refusal. */
  assertCurrent: () => void | boolean;
  confirm?: ExternalTurnSink["confirm"];
  askUser?: ExternalTurnSink["askUser"];
}

function fail(): never { throw new Error("coding_tool_boundary_refused"); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function sameIdentity(a: Stats, b: Stats): boolean { return a.dev === b.dev && a.ino === b.ino && a.isDirectory() === b.isDirectory(); }
function protectedPath(root: string, path: string): boolean {
  // The trusted managed root itself lives in ~/.hara/workspace/agent-worktrees. Only descendant
  // control-plane names are prohibited here; the central secret policy still sees the absolute path.
  const parts = relative(root,path).split(/[\\/]/u).map(part => part.toLowerCase().replace(/[. ]+$/u, ""));
  return parts.some(part => [".git", ".hara", ".gitattributes", ".gitmodules"].includes(part)) || sensitiveFileReason(path) !== null;
}
function strictInput(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => value[key] === undefined)) fail();
  return structuredClone(value);
}
function boundedText(value: unknown): value is string { return typeof value === "string" && value.length <= MAX_TEXT; }
function spec(tool: Tool, description = tool.description, pathDescription?: string): ToolSpec {
  const input_schema = structuredClone(tool.input_schema);
  if (pathDescription !== undefined) {
    input_schema.properties.path = { ...(input_schema.properties.path as Record<string, unknown>), description: pathDescription };
  }
  return { name: tool.name, description, input_schema };
}
const SPECS: ToolSpec[] = [
  spec(ORIGINAL_CODING_READ_FILE_TOOL,
    "Read UTF-8 text inside this isolated worktree; returns numbered lines (default 300). Use offset/limit for another slice. Protected files and symlinks are refused."),
  spec(ORIGINAL_TASK_WRITE_FILE_TOOL,
    "Create or overwrite UTF-8 text inside this isolated worktree; creates safe parent directories. Every change requires fresh human approval.",
    "Path relative to this isolated worktree."),
  spec(ORIGINAL_TASK_EDIT_FILE_TOOL,
    "Replace exact raw file text inside this isolated worktree. Supply old_string/new_string or ordered edits; strip read_file line numbers. Matches must be unique unless replace_all is true. Use write_file for new files. Every change requires fresh human approval."),
  { name: "list_files", description: "List a bounded single directory inside this isolated worktree. Protected files, symlinks and hard links are omitted; no recursion.",
    input_schema: { type: "object", properties: { path: { type: "string", description: "Directory relative to the isolated worktree; defaults to ." } } } },
  { name: "ask_user", description: "Ask the human a blocking question. This is input, never execution permission. Never request credentials; there is no implicit answer or default.",
    input_schema: { type: "object", properties: { question: { type: "string" }, options: { type: "array", items: { type: "string" }, maxItems: 32 } }, required: ["question"] } },
];

/** A deliberately smaller capability surface than the general Hara registry. No shell or plugin lookup. */
export function createCodingToolset(options: CodingToolsetOptions): {
  tools: ToolSpec[];
  executeTool(name: string, input: unknown, signal?: AbortSignal): Promise<string>;
} {
  const root = realpathSync.native(resolve(options.cwd));
  const rootInfo = lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || isUnsafeProjectWorkspace(root)
    || (typeof process.getuid === "function" && rootInfo.uid !== process.getuid())) fail();
  // cwd may have a conventional OS alias (/tmp on macOS); bind its canonical inode, not that alias.
  const rootCurrent = () => {
    const info = lstatSync(root);
    if (!sameIdentity(rootInfo, info) || info.uid !== rootInfo.uid || info.isSymbolicLink() || realpathSync.native(root) !== root) fail();
  };
  const target = (value: unknown, allowMissing = false, directory = false): string => {
    rootCurrent();
    if (typeof value !== "string" || value.length === 0 || value.length > 4_096 || CONTROL.test(value)) fail();
    const path = resolve(root, value);
    if (!inside(root, path) || protectedPath(root,path)) fail();
    const parts = relative(root, path).split(sep).filter(Boolean);
    // Alternate streams / drive aliases are never meaningful coding-worktree paths.
    if (parts.length > 128 || parts.some(part => part.includes(":"))) fail();
    let current = root;
    let missing = false;
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]);
      if (protectedPath(root,current)) fail();
      if (missing) continue;
      let info;
      try { info = lstatSync(current); } catch (error: any) {
        if (error?.code !== "ENOENT" || !allowMissing) throw error;
        missing = true; continue;
      }
      if (info.uid !== rootInfo.uid || info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))
        || realpathSync.native(current) !== current || (index < parts.length - 1 && !info.isDirectory())) fail();
      if (index === parts.length - 1 && (directory ? !info.isDirectory() : !info.isFile())) fail();
    }
    if (parts.length === 0 && !directory) fail();
    return path;
  };

  async function executeTool(name: string, value: unknown, callSignal?: AbortSignal): Promise<string> {
    const combined = callSignal ? AbortSignal.any([options.signal, callSignal]) : options.signal;
    let ancestors: Array<{path: string; info: Stats}> = [];
    const current = () => {
      if (combined.aborted) return false;
      try {
        rootCurrent();
        for (const entry of ancestors) {
          const info = lstatSync(entry.path);
          if (!sameIdentity(entry.info, info) || info.uid !== rootInfo.uid || info.isSymbolicLink() || realpathSync.native(entry.path) !== entry.path) return false;
        }
        const result = options.assertCurrent();
        return result === undefined || result === true;
      } catch { return false; }
    };
    const check = () => { if (!current()) fail(); };
    // Built-in atomic writers read signal.aborted immediately before namespace commits. Recheck the
    // host identity there too, not merely before awaiting their filesystem work.
    const signal = new Proxy(combined, { get(source, key) {
      if (key === "aborted") return !current();
      const member = Reflect.get(source, key, source);
      return typeof member === "function" ? member.bind(source) : member;
    } });
    const human = async <T>(callback: () => Promise<T>): Promise<T> => {
      check();
      let onAbort: () => void = () => {};
      const cancelled = new Promise<never>((_resolve, reject) => { onAbort = () => reject(new Error("coding_tool_cancelled")); });
      combined.addEventListener("abort", onAbort, { once: true });
      try { check(); const answer = await Promise.race([Promise.resolve().then(() => { check(); return callback(); }), cancelled]); check(); return answer; }
      finally { combined.removeEventListener("abort", onAbort); }
    };
    try {
      check();
      if (name === "ask_user") {
        const input = strictInput(value, ["question", "options"], ["question"]);
        if (input.options !== undefined && (!Array.isArray(input.options) || input.options.some(option => typeof option !== "string"))) fail();
        const request = normalizeExternalUserQuestions({ questions: [{ id: "question", question: input.question,
          ...(input.options === undefined ? {} : {options: (input.options as string[]).map(label => ({label}))}), isOther: true }] });
        if (!request || !options.askUser) fail();
        const answer = validateExternalUserAnswers(request, await human(() => options.askUser!(request, signal)));
        if (answer === undefined) fail();
        return JSON.stringify(answer);
      }
      if (name === "list_files") {
        const input = strictInput(value, ["path"], []);
        const directory = target(input.path ?? ".", false, true);
        const before = lstatSync(directory);
        const handle = opendirSync(directory); const entries: Array<{path: string; type: "file" | "directory"}> = [];
        try {
          for (let count = 0; ; count++) {
            check(); target(directory,false,true); if (!sameIdentity(before,lstatSync(directory))) fail();
            const entry = handle.readSync(); if (!entry) break;
            if (count >= MAX_LIST_ENTRIES) fail();
            try {
              const child = join(directory, entry.name); const info = lstatSync(child);
              target(relative(root, child), false, info.isDirectory());
              entries.push({path:relative(root, child).split(sep).join("/"),type:info.isDirectory() ? "directory" : "file"});
            } catch { /* An untrusted entry is not enumerated into model context. */ }
          }
        } finally { handle.closeSync(); }
        target(directory, false, true); if (!sameIdentity(before, lstatSync(directory))) fail(); check();
        const output = JSON.stringify(entries.sort((a,b) => a.path.localeCompare(b.path)));
        if (output.length > MAX_RESULT_CHARS) fail();
        return output;
      }
      if (name === "read_file") {
        const input = strictInput(value, ["path", "offset", "limit"], ["path"]);
        for (const field of ["offset", "limit"]) if (input[field] !== undefined
          && (!Number.isSafeInteger(input[field]) || (input[field] as number) < 1 || (field === "limit" && (input[field] as number) > 2_000))) fail();
        const path = target(input.path);
        const before = lstatSync(path);
        const fd = openSync(path,constants.O_RDONLY | optionalPosixOpenFlag("O_NONBLOCK") | optionalPosixOpenFlag("O_NOFOLLOW"));
        let text: string;
        try {
          const opened = fstatSync(fd);
          // Check the *opened fd's* canonical target against this exact root BEFORE reading bytes.
          // The general reader verifies regular-file identity but does not know our worktree scope.
          if (verifyOpenedRegularFileSync(path,opened) !== path || !sameIdentity(before,opened)
            || opened.size > MAX_READ_BYTES) fail();
          target(path); check();
          const bytes = Buffer.alloc(Math.min(MAX_READ_BYTES+1,opened.size+1)); let length = 0;
          while (length < bytes.length) {
            check(); const count = readSync(fd,bytes,length,bytes.length-length,length);
            if (count === 0) break; length += count;
          }
          const latest = fstatSync(fd);
          if (length > MAX_READ_BYTES || verifyOpenedRegularFileSync(path,latest) !== path
            || !sameIdentity(opened,latest) || opened.size !== latest.size
            || opened.mtimeMs !== latest.mtimeMs || opened.ctimeMs !== latest.ctimeMs) fail();
          target(path); if (!sameIdentity(before,lstatSync(path))) fail(); check();
          text = decodeUtf8Strict(bytes.subarray(0,length),path);
        } finally { closeSync(fd); }
        check();
        const result = redactSensitiveText(renderFileSlice(text, input.offset as number | undefined, input.limit as number | undefined)).text;
        return result.length > MAX_RESULT_CHARS ? result.slice(0, MAX_RESULT_CHARS) + "\n[bounded coding read truncated]" : result;
      }
      if (name !== "write_file" && name !== "edit_file") fail();
      const input = name === "write_file" ? strictInput(value, ["path", "content"], ["path", "content"])
        : strictInput(value, ["path", "old_string", "new_string", "replace_all", "edits"], ["path"]);
      const path = target(input.path, name === "write_file");
      if (name === "write_file") { if (!boundedText(input.content)) fail(); }
      else {
        const edits = input.edits === undefined ? [input] : input.edits;
        if (!Array.isArray(edits) || edits.length === 0 || edits.length > 64) fail();
        for (const edit of edits) if (!record(edit) || !boundedText(edit.old_string) || !boundedText(edit.new_string)
          || (edit.replace_all !== undefined && typeof edit.replace_all !== "boolean")
          || (edit !== input && Object.keys(edit).some(key => !["old_string","new_string","replace_all"].includes(key)))) fail();
        if (JSON.stringify(input).length > MAX_TEXT) fail();
      }
      if (!options.confirm) fail();
      const preview = redactSensitiveText(JSON.stringify({...input,path:relative(root,path).split(sep).join("/")})).text;
      // Never truncate an approval into a misleading partial proposal.
      if (preview.length > MAX_APPROVAL_CHARS) fail();
      const names = relative(root,path).split(sep).filter(Boolean);
      const proposal = names.map((_part,index) => {
        const entry = join(root,...names.slice(0,index+1));
        try { return {path:entry,info:lstatSync(entry)}; }
        catch (error: any) { if (error?.code !== "ENOENT") throw error; return {path:entry,info:undefined}; }
      });
      if (await human(() => options.confirm!({question:`Allow this isolated coding ${name} action?\n${preview}`,allowAlways:false},signal)) !== true) fail();
      check(); target(path, name === "write_file");
      for (const entry of proposal) {
        let info: Stats | undefined;
        try { info = lstatSync(entry.path); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
        if (entry.info ? !info || !sameIdentity(entry.info,info) : info !== undefined) fail();
      }
      // Build new parents synchronously, with a fresh host and canonical parent check for each mkdir.
      // This avoids delegating recursive missing-directory creation across async authorization gaps.
      let parent = root;
      for (const part of names.slice(0,-1)) {
        check(); target(parent,false,true);
        const next = join(parent,part);
        try { lstatSync(next); } catch (error: any) {
          if (error?.code !== "ENOENT") throw error;
          mkdirSync(next);
        }
        target(next,false,true); ancestors.push({path:next,info:lstatSync(next)}); parent = next;
      }
      if (parent !== dirname(path)) fail();
      check(); target(path,name === "write_file");
      const context: ToolContext = {cwd:root,writeBoundary:root,signal,ui:{text(){},reasoning(){},tool(){},diff(){},notice(){}}};
      const implementation = name === "write_file" ? ORIGINAL_TASK_WRITE_FILE_TOOL : ORIGINAL_TASK_EDIT_FILE_TOOL;
      const result = await implementation.run({...input,path},context);
      check(); target(path); // Reject a changed namespace before any result reaches the model.
      return redactSensitiveText(result).text.slice(0,MAX_RESULT_CHARS);
    } catch { return "Error: coding tool was refused, cancelled, or could not complete safely. No permission was retained."; }
  }
  return { tools: structuredClone(SPECS), executeTool };
}
