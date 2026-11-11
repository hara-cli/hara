import { assertAgentBoundaryEffectCurrent, assertAgentBoundaryFileAccess } from "./agent-boundary-execution.js";
import { lexicalSensitiveFileReason } from "../security/sensitive-files.js";
import { decorateWorkspaceExtensionTool } from "./extension-binding.js";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, join, dirname } from "node:path";
import { atomicWriteText, bindAtomicWritePath, bindHaraPrivateStateWritePath } from "../fs-write.js";
import { readVerifiedRegularFileSnapshotSync } from "../fs-read.js";
import type { Tool } from "../tools/registry.js";
import { exact, plain, text } from "./local-state.js";

/** Transport IDs are easy for a model to miscopy. Repeat the actual host-owned ID inside a successful
 * structured result; this is a citation hint, NOT evidence authority. The engine ledger still checks it. */
export function withWorkspaceToolReceipts(tools: Tool[]): Tool[] {
  return tools.map(tool => decorateWorkspaceExtensionTool(tool, { ...tool, async run(input, ctx) {
    if (ctx.toolCallId !== undefined && !text(ctx.toolCallId, 240)) throw new Error("invalid Workspace tool receipt id");
    const result = await tool.run(input, ctx);
    if (!ctx.toolCallId) return result;
    let value: unknown; try { value = JSON.parse(result); } catch { return result; }
    return plain(value) ? JSON.stringify({ ...value, receipt: { toolCallId: ctx.toolCallId, toolName: tool.name } }) : result;
  } }));
}

/** Host-scoped project tools. No shell, links, protected state, caller-defined roots or external IO. */
export function localWorkspaceFileTools(project: string, assertCurrent: () => void, managed?: { legacyProject: string; ownHome: string; onWrite: () => void; beginWrite?: () => () => void }): Tool[] {
  const assertLive = () => { assertAgentBoundaryEffectCurrent(); assertCurrent(); };
  const selectedRoot = (root: unknown) => {
    if (root === undefined || root === "home") return project;
    if (root === "legacy" && managed) return managed.legacyProject;
    throw new Error("Unsupported Workspace file root");
  };
  const target = (value: unknown, root?: unknown, write = false): string => {
    assertLive();
    const project = selectedRoot(root);
    if (!text(value, 512) || isAbsolute(value)) throw new Error("Workspace file path must be project-relative");
    const path = resolve(project, value), rel = relative(project, path), parts = rel.split(sep);
    assertAgentBoundaryFileAccess(path, write ? "write" : "read");
    if (!rel || isAbsolute(rel) || parts.some(p => !p || p === ".." || p.startsWith(".") || p === "node_modules" || /[. ]$/.test(p) || p.includes(":"))
      || /(?:^|[\\/])(?:credentials?|secrets?|id_rsa|id_ed25519)(?:\.|[\\/]|$)/i.test(rel)) throw new Error("Workspace file path is outside the granted safe project");
    if (write && managed) {
      const inRoot = (base: string, child: string) => { const tail = relative(base, child); return !isAbsolute(tail) && tail !== ".." && !tail.startsWith(".." + sep); };
      const namespace = join(managed.legacyProject, "colleagues");
      if (inRoot(namespace, path) && !inRoot(managed.ownHome, path)) throw new Error("Another colleague working folder is read-only");
      // Engines also load instruction files from subdirectories (Claude reads a nested CLAUDE.md when it works there),
      // so these names need the confirmation card at any depth, not only at a root.
      if ([managed.legacyProject, managed.ownHome].some(base => inRoot(base, path)) && /^(?:agents\.md|claude(?:\.local)?\.md)$/i.test(parts[parts.length - 1]!))
        throw new Error("Managed instructions require a Hara confirmation card");
    }
    let cursor = project;
    for (const part of parts) {
      cursor = resolve(cursor, part);
      try { const info = lstatSync(cursor); if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1)) throw new Error("Workspace links are not permitted"); }
      catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    }
    assertLive(); return path;
  };
  // Only this Host-derived managed root can lift the Hara-state classification. Credential names,
  // symlinks/hard links and every path restriction above remain checked independently.
  const managedStateFile = (path: string) => Boolean(managed && lexicalSensitiveFileReason(path) === "private Hara state");
  const snapshotAt = (path: string) => readVerifiedRegularFileSnapshotSync(path, 128 * 1024, { protectSensitive: !managedStateFile(path), ...(managed ? { expectedCanonicalPath: path } : {}) });
  const writeBoundary = (path: string) => {
    if (!managedStateFile(path)) return bindAtomicWritePath(path);
    const missing: string[] = []; let parent = dirname(path);
    while (true) { try { lstatSync(parent); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; missing.unshift(parent); parent = dirname(parent); } }
    for (const dir of missing) { assertLive(); mkdirSync(dir, { mode: 0o700 }); if (realpathSync.native(dir) !== dir || lstatSync(dir).isSymbolicLink()) throw new Error("Workspace parent alias changed"); }
    assertLive(); return bindHaraPrivateStateWritePath(path, dirname(path), "write managed Workspace project file");
  };
  const schema = { type: "object" as const, properties: { path: { type: "string" }, ...(managed ? { root: { type: "string", enum: ["home", "legacy"] } } : {}) }, required: ["path"] };
  const read = (input: unknown) => {
    if (!plain(input) || !exact(input, ["path", ...(Object.hasOwn(input, "root") && managed ? ["root"] : [])])) throw new Error("invalid Workspace read input");
    const path = target(input.path, input.root), snapshot = snapshotAt(path);
    assertLive();
    if (!snapshot) throw new Error("Workspace file does not exist");
    return { path: input.path as string, text: snapshot.text, sha256: createHash("sha256").update(snapshot.text).digest("hex"), bytes: Buffer.byteLength(snapshot.text) };
  };
  return [
    { name: "workspace_read", description: "Read one safe relative file from the admitted working folder. Use root=legacy only for the fixed related Workspace folder.", input_schema: schema, kind: "read",
      async run(input) {
        try { return JSON.stringify({ ...read(input), exists: true }); }
        catch (error: any) { if (error?.code === "ENOENT") return JSON.stringify({ exists: false }); throw error; }
      } },
    { name: "workspace_write", description: "Atomically write UTF-8 to one safe relative admitted file; managed instructions need their own confirmation card; then verify it before completion.", kind: "edit",
      input_schema: { type: "object", properties: { ...schema.properties, content: { type: "string" } }, required: ["path", "content"] },
      async run(input, ctx) {
        if (!plain(input) || !exact(input, ["path", "content", ...(Object.hasOwn(input, "root") && managed ? ["root"] : [])]) || typeof input.content !== "string" || input.content.length > 64_000) throw new Error("invalid Workspace write input");
        const path = target(input.path, input.root, true), boundary = writeBoundary(path);
        let previous: ReturnType<typeof readVerifiedRegularFileSnapshotSync> | undefined;
        try { previous = snapshotAt(path); }
        catch (error: any) { if (error?.code !== "ENOENT") throw error; }
        const finishWrite = managed?.beginWrite?.();
        try { await atomicWriteText(path, input.content, { expected: previous?.text ?? null, ...(previous ? { expectedIdentity: previous } : {}), boundary,
          signal: ctx.signal, assertCurrent: () => { target(input.path, input.root, true); } }); } finally { finishWrite?.(); }
        managed?.onWrite();
        const verified = read({ path: input.path, ...(input.root ? { root: input.root } : {}) }); ctx.verifiedChange?.(verified.sha256);
        return JSON.stringify({ path: verified.path, sha256: verified.sha256, bytes: verified.bytes, written: true });
      } },
    { name: "workspace_verify", description: "Read exact file bytes and compare with expected UTF-8 content; return file hash as evidence.", kind: "read",
      input_schema: { type: "object", properties: { ...schema.properties, expectedContent: { type: "string" } }, required: ["path", "expectedContent"] },
      async run(input) {
        if (!plain(input) || !exact(input, ["path", "expectedContent", ...(Object.hasOwn(input, "root") && managed ? ["root"] : [])]) || typeof input.expectedContent !== "string" || input.expectedContent.length > 64_000) throw new Error("invalid Workspace verification input");
        const file = read({ path: input.path, ...(input.root ? { root: input.root } : {}) });
        if (file.text !== input.expectedContent) throw new Error("Workspace file content did not match acceptance");
        return JSON.stringify({ path: file.path, sha256: file.sha256, bytes: file.bytes, verified: true });
      } },
  ];
}
