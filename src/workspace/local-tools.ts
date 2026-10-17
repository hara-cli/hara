import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { atomicWriteText, bindAtomicWritePath } from "../fs-write.js";
import { readVerifiedRegularFileSnapshotSync } from "../fs-read.js";
import type { Tool } from "../tools/registry.js";
import { exact, plain, text } from "./local-state.js";

/** Transport IDs are easy for a model to miscopy. Repeat the actual host-owned ID inside a successful
 * structured result; this is a citation hint, NOT evidence authority. The engine ledger still checks it. */
export function withWorkspaceToolReceipts(tools: Tool[]): Tool[] {
  return tools.map(tool => ({ ...tool, async run(input, ctx) {
    if (ctx.toolCallId !== undefined && !text(ctx.toolCallId, 240)) throw new Error("invalid Workspace tool receipt id");
    const result = await tool.run(input, ctx);
    if (!ctx.toolCallId) return result;
    let value: unknown; try { value = JSON.parse(result); } catch { return result; }
    return plain(value) ? JSON.stringify({ ...value, receipt: { toolCallId: ctx.toolCallId, toolName: tool.name } }) : result;
  } }));
}

/** Fixture-only project tools. No shell, symlinks, protected files, arbitrary outputs or external IO. */
export function localWorkspaceFileTools(project: string, assertCurrent: () => void): Tool[] {
  const target = (value: unknown): string => {
    if (!text(value, 512) || isAbsolute(value)) throw new Error("Workspace file path must be project-relative");
    const path = resolve(project, value), rel = relative(project, path), parts = rel.split(sep);
    if (!rel || isAbsolute(rel) || parts.some(p => !p || p === ".." || p.startsWith(".") || p === "node_modules")
      || /(?:^|[\\/])(?:credentials?|secrets?|id_rsa|id_ed25519)(?:\.|[\\/]|$)/i.test(rel)) throw new Error("Workspace file path is outside the granted safe project");
    let cursor = project;
    for (const part of parts) {
      cursor = resolve(cursor, part);
      try { const info = lstatSync(cursor); if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1)) throw new Error("Workspace links are not permitted"); }
      catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    }
    assertCurrent(); return path;
  };
  const schema = { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] };
  const read = (input: unknown) => {
    if (!plain(input) || !exact(input, ["path"])) throw new Error("invalid Workspace read input");
    const path = target(input.path), snapshot = readVerifiedRegularFileSnapshotSync(path, 128 * 1024);
    assertCurrent();
    if (!snapshot) throw new Error("Workspace file does not exist");
    return { path: input.path as string, text: snapshot.text, sha256: createHash("sha256").update(snapshot.text).digest("hex"), bytes: Buffer.byteLength(snapshot.text) };
  };
  return [
    { name: "workspace_read", description: "Read one safe relative file from the explicitly granted fixture project.", input_schema: schema, kind: "read",
      async run(input) {
        try { return JSON.stringify({ ...read(input), exists: true }); }
        catch (error: any) { if (error?.code === "ENOENT") return JSON.stringify({ exists: false }); throw error; }
      } },
    { name: "workspace_write", description: "Atomically write UTF-8 to one safe relative project file; then verify it before completion.", kind: "edit",
      input_schema: { type: "object", properties: { ...schema.properties, content: { type: "string" } }, required: ["path", "content"] },
      async run(input, ctx) {
        if (!plain(input) || !exact(input, ["path", "content"]) || typeof input.content !== "string" || input.content.length > 64_000) throw new Error("invalid Workspace write input");
        const path = target(input.path), boundary = bindAtomicWritePath(path);
        let previous: ReturnType<typeof readVerifiedRegularFileSnapshotSync> | undefined;
        try { previous = readVerifiedRegularFileSnapshotSync(path, 128 * 1024); }
        catch (error: any) { if (error?.code !== "ENOENT") throw error; }
        await atomicWriteText(path, input.content, { expected: previous?.text ?? null, ...(previous ? { expectedIdentity: previous } : {}), boundary,
          signal: ctx.signal, assertCurrent: () => { target(input.path); } });
        const verified = read({ path: input.path }); ctx.verifiedChange?.(verified.sha256);
        return JSON.stringify({ path: verified.path, sha256: verified.sha256, bytes: verified.bytes, written: true });
      } },
    { name: "workspace_verify", description: "Read exact file bytes and compare with expected UTF-8 content; return file hash as evidence.", kind: "read",
      input_schema: { type: "object", properties: { ...schema.properties, expectedContent: { type: "string" } }, required: ["path", "expectedContent"] },
      async run(input) {
        if (!plain(input) || !exact(input, ["path", "expectedContent"]) || typeof input.expectedContent !== "string" || input.expectedContent.length > 64_000) throw new Error("invalid Workspace verification input");
        const file = read({ path: input.path });
        if (file.text !== input.expectedContent) throw new Error("Workspace file content did not match acceptance");
        return JSON.stringify({ path: file.path, sha256: file.sha256, bytes: file.bytes, verified: true });
      } },
  ];
}
