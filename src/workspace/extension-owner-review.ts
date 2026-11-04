// Human-only code/catalog review. No instance of this service is an agent tool.
import { AsyncResource } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { ensurePrivateStateSubdirectory } from "../security/private-state.js";
import { assertRuntimeProxyReachable } from "../security/runtime-proxy.js";
import { extensionDigest, type ExtensionSourceDescriptor } from "./extension-catalog.js";
import { normalizeWorkspaceMcpLaunch, type WorkspaceMcpLaunchProvider } from "./extension-candidate.js";
import { assertWorkspaceMcpReviewCurrent, prepareWorkspaceMcpReview, restoreWorkspaceMcpReview, workspaceMcpProtocolMetadata, type McpReviewRecord, type ReviewedMcpSource } from "./extension-review.js";
import { ManagedMcpStdioTransport, managedMcpProxy } from "./extension-process.js";
import { McpOwnerReviewError, WorkspaceMcpReviewLibrary } from "./extension-review-store.js";

export type OwnerReviewReason = McpOwnerReviewError["code"];
export interface McpOwnerContext {
  clientId: string; key: string; workspaceId: string; generation: string; stateHome: string;
  assertCurrent(): void; proxy(): { revision: number; proxyUrl: string | null; readOnly: boolean };
}
interface Proposal {
  id: string; source: ExtensionSourceDescriptor; available: boolean; context: McpOwnerContext;
  revision: number; expiresAt: number; phase: "unprepared" | "code" | "inspecting" | "tools" | "failed" | "approved" | "revoked";
  saved?: McpReviewRecord; fixed?: McpReviewRecord; startup?: ReviewedMcpSource;
  failure?: OwnerReviewReason; controller?: AbortController; proxy?: { revision: number; url: string };
}
export class WorkspaceMcpOwnerReview {
  readonly library: WorkspaceMcpReviewLibrary;
  private readonly hostScope = new AsyncResource("hara-host-mcp-owner-review");
  private readonly proposals = new Map<string, Proposal>();
  private readonly inspections = new Set<Promise<unknown>>();
  private children = 0; private closed = false;
  constructor(private readonly input: { home: string; sources(): readonly ExtensionSourceDescriptor[]; launch: WorkspaceMcpLaunchProvider; changed(): void }) {
    this.library = new WorkspaceMcpReviewLibrary(input.home, input.changed);
  }
  valid(sources: readonly ExtensionSourceDescriptor[]) { return this.hostScope.runInAsyncScope(() => this.library.valid(sources)); }
  invalidate(sourceId: string, revision: string) { this.hostScope.runInAsyncScope(() => this.library.invalidate(sourceId, revision)); }
  private prune() {
    for (const [id, proposal] of this.proposals) if (proposal.expiresAt <= Date.now()) { proposal.controller?.abort(); this.proposals.delete(id); }
  }
  private current(id: string, context: McpOwnerContext, code = false, fenceOnly = false): Proposal {
    this.prune(); context.assertCurrent();
    const proposal = this.proposals.get(id);
    if (this.closed || !proposal || proposal.context.clientId !== context.clientId || proposal.context.key !== context.key) throw new McpOwnerReviewError("view_changed");
    proposal.context.assertCurrent();
    if (!fenceOnly) {
      const library = this.library.read();
      if (library.readOnly) throw new McpOwnerReviewError("library_read_only");
      if (library.value.revision !== proposal.revision) throw new McpOwnerReviewError("review_changed");
    }
    const source = this.input.sources().find(row => row.sourceId === proposal.source.sourceId);
    if (proposal.available ? !source || extensionDigest(source) !== extensionDigest(proposal.source) : !!source) throw new McpOwnerReviewError("review_changed");
    if (proposal.proxy && code) {
      const proxy = context.proxy();
      if (proxy.readOnly || proxy.revision !== proposal.proxy.revision || managedMcpProxy(proxy.proxyUrl) !== proposal.proxy.url) throw new McpOwnerReviewError("proxy_unavailable");
    }
    if (code && proposal.startup && proposal.fixed) {
      const launch = normalizeWorkspaceMcpLaunch(proposal.source, this.input.launch(proposal.source), this.input.home, context.stateHome);
      if (extensionDigest([launch.command, launch.args, launch.packageRoot]) !== extensionDigest([proposal.fixed.command, proposal.fixed.args, proposal.fixed.packageRoot])) throw new McpOwnerReviewError("review_changed");
      try { assertWorkspaceMcpReviewCurrent(proposal.startup); } catch { throw new McpOwnerReviewError("review_changed"); }
    }
    return proposal;
  }
  list(context: McpOwnerContext) {
    context.assertCurrent(); this.prune(); this.dismiss(context.clientId);
    const library = this.library.read(), sources = [...this.input.sources()], availableIds = new Set(sources.map(source => source.sourceId)), valid = this.valid(sources);
    for (const record of library.value.records) if (!sources.some(source => source.sourceId === record.source.sourceId)) sources.push(record.source);
    const rows = sources.map(source => {
      const saved = library.value.records.find(record => record.source.sourceId === source.sourceId);
      const available = availableIds.has(source.sourceId);
      let proposal: Proposal | undefined;
      if (!proposal && this.proposals.size < 512) {
        proposal = { id: randomUUID(), source, available, saved, context, revision: library.value.revision,
          expiresAt: Date.now() + 120_000, phase: "unprepared" };
        this.proposals.set(proposal.id, proposal);
      }
      return { sourceId: source.sourceId, recordId: proposal?.id ?? null, name: source.name,
        status: saved ? valid.some(row => row.descriptor.sourceId === source.sourceId) ? "reviewed" : "stale" : "candidate",
        reason: !available ? "package_unavailable" : process.platform !== "darwin" ? "unsupported_platform" : source.transport !== "stdio" ? "unsupported_transport" : null };
    });
    return { workspaceId: context.workspaceId, resourceGeneration: context.generation, revision: library.value.revision, readOnly: library.readOnly, allowed: true, reason: null, sources: rows };
  }
  private abbreviated(path: string) {
    const homes = [this.input.home, userInfo().homedir].sort((a, b) => b.length - a.length);
    for (const home of homes) if (path === home || path.startsWith(home + "/")) return "~" + path.slice(home.length);
    return path;
  }
  private detail(proposal: Proposal) {
    const record = proposal.fixed ?? proposal.saved;
    return { workspaceId: proposal.context.workspaceId, resourceGeneration: proposal.context.generation, revision: proposal.revision,
      recordId: proposal.id, sourceId: proposal.source.sourceId, name: proposal.source.name, transport: proposal.source.transport,
      phase: proposal.phase, reason: proposal.failure ?? (!proposal.available ? "package_unavailable" : null),
      hasReview: !!proposal.saved, canInspect: !!proposal.startup && proposal.phase === "code", canApprove: proposal.phase === "tools" && !proposal.failure,
      binaryPath: record ? this.abbreviated(record.command) : null, packagePath: record ? this.abbreviated(record.packageRoot) : null,
      binaryDigest: record?.binaryDigest ?? null, packageDigest: record?.packageDigest ?? null,
      launchSummary: record ? record.args.map(arg => JSON.stringify(this.abbreviated(arg))).join(" ") : null,
      network: "proxy_only", credentials: "none", tools: (record?.tools ?? []).map(tool => ({ name: tool.remoteName, description: tool.description,
        schema: tool.inputSchema, schemaDigest: extensionDigest(tool.inputSchema), effect: tool.effect })) };
  }
  describe(id: string, context: McpOwnerContext) {
    const proposal = this.current(id, context);
    if (proposal.phase !== "unprepared") return this.detail(proposal);
    try {
      if (!proposal.available) throw new McpOwnerReviewError("package_unavailable");
      const launch = normalizeWorkspaceMcpLaunch(proposal.source, this.input.launch(proposal.source), this.input.home, context.stateHome);
      const fixed = prepareWorkspaceMcpReview({ ...launch, tools: [], reviewNonce: proposal.id });
      const proxy = context.proxy();
      if (proxy.readOnly) throw new McpOwnerReviewError("proxy_unavailable");
      proposal.proxy = { revision: proxy.revision, url: managedMcpProxy(proxy.proxyUrl) };
      proposal.fixed = fixed; proposal.startup = restoreWorkspaceMcpReview(fixed); proposal.phase = "code";
      // A saved catalog is shown as saved data; approving a new one always requires fresh inspection.
      if (proposal.saved) proposal.fixed = { ...fixed, tools: proposal.saved.tools };
    } catch (error) { proposal.phase = "failed"; proposal.failure = error instanceof McpOwnerReviewError ? error.code : "package_unavailable"; }
    return this.detail(proposal);
  }
  inspect(id: string, confirmed: boolean, context: McpOwnerContext): Promise<ReturnType<WorkspaceMcpOwnerReview["detail"]>> {
    if (confirmed !== true) throw new McpOwnerReviewError("owner_required");
    const proposal = this.current(id, context, true);
    if (!proposal.startup || !proposal.fixed || proposal.phase !== "code" || this.children >= 2) throw new McpOwnerReviewError("review_changed");
    proposal.phase = "inspecting"; proposal.controller = new AbortController(); this.children++;
    const operation = this.inspectOnce(proposal, context);
    this.inspections.add(operation); void operation.finally(() => this.inspections.delete(operation)).catch(() => {});
    return operation;
  }
  private async inspectOnce(proposal: Proposal, context: McpOwnerContext) {
    const signal = AbortSignal.any([proposal.controller!.signal, AbortSignal.timeout(15_000)]);
    let client: Client | undefined, transport: ManagedMcpStdioTransport | undefined, failed: OwnerReviewReason | undefined, catalogChanged = false;
    try {
      await assertRuntimeProxyReachable(proposal.proxy!.url, signal).catch(() => { throw new McpOwnerReviewError("proxy_unavailable"); });
      this.current(proposal.id, context, true);
      const root = ensurePrivateStateSubdirectory(context.stateHome, [".hara", "mcp-review-inspections", proposal.id]).path;
      for (const name of ["home", "config", "cache", "state", "tmp"]) ensurePrivateStateSubdirectory(root, [name]);
      transport = new ManagedMcpStdioTransport({ source: proposal.startup!, root, accountHome: this.input.home, stateHome: context.stateHome, proxy: proposal.proxy!.url, signal });
      client = new Client({ name: "hara-owner-catalog-inspection", version: "1" }, { capabilities: {} });
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => { catalogChanged = true; });
      await client.connect(transport, { signal, timeout: 10_000 });
      // No tools/call, roots, sampling, elicitation or model route exists in this inspector.
      const inventory = await client.listTools({}, { signal, timeout: 10_000 });
      if (catalogChanged || inventory.nextCursor || !inventory.tools.length || inventory.tools.length > 64 || new Set(inventory.tools.map(tool => tool.name)).size !== inventory.tools.length) throw new McpOwnerReviewError("schema_unsupported");
      const tools = inventory.tools.map(tool => {
        let metadata: Record<string, unknown>;
        try { metadata = workspaceMcpProtocolMetadata(tool); } catch { throw new McpOwnerReviewError("schema_unsupported"); }
        return { toolId: "tool-" + extensionDigest(tool.name).slice(0, 24), remoteName: tool.name, description: tool.description ?? "", inputSchema: tool.inputSchema as McpReviewRecord["tools"][number]["inputSchema"], effect: "exec" as const,
          ...(Object.keys(metadata).length ? { protocolMetadata: metadata } : {}) };
      });
      this.current(proposal.id, context, true);
      // Retain the exact code digests that the owner authorized; never rebase onto changed code.
      const fixed = { ...proposal.fixed!, tools };
      try { restoreWorkspaceMcpReview(fixed); } catch { throw new McpOwnerReviewError("schema_unsupported"); }
      proposal.fixed = fixed;
    } catch (error) { failed = error instanceof McpOwnerReviewError ? error.code : "inspection_failed"; }
    try { await client?.close(); } catch { failed ??= "inspection_failed"; }
    try { await transport?.close(); this.children--; }
    catch { failed = "drain_unknown"; } // unknown ownership keeps the capacity reservation
    if (catalogChanged) failed ??= "schema_unsupported";
    if (failed) { proposal.phase = "failed"; proposal.failure = failed; }
    else { this.current(proposal.id, context, true); proposal.phase = "tools"; }
    return this.detail(proposal);
  }
  approve(id: string, confirmed: boolean, context: McpOwnerContext) {
    if (confirmed !== true) throw new McpOwnerReviewError("owner_required");
    const proposal = this.current(id, context, true);
    if (proposal.phase !== "tools" || !proposal.fixed) throw new McpOwnerReviewError("review_changed");
    const next = this.hostScope.runInAsyncScope(() => this.library.approve(proposal.fixed!, proposal.revision, () => { this.current(id, context, true, true); }));
    proposal.phase = "approved"; proposal.saved = proposal.fixed; proposal.revision = next.revision;
    return this.detail(proposal);
  }
  revoke(id: string, confirmed: boolean, context: McpOwnerContext) {
    if (confirmed !== true) throw new McpOwnerReviewError("owner_required");
    const proposal = this.current(id, context);
    if (!proposal.saved || proposal.phase === "inspecting") throw new McpOwnerReviewError("review_changed");
    const next = this.hostScope.runInAsyncScope(() => this.library.revoke(proposal.source.sourceId, proposal.revision, () => { this.current(id, context, false, true); }));
    proposal.phase = "revoked"; proposal.saved = undefined; proposal.revision = next.revision;
    return this.detail(proposal);
  }
  cancel(id: string, context: McpOwnerContext) {
    context.assertCurrent(); const proposal = this.proposals.get(id);
    if (!proposal || proposal.context.clientId !== context.clientId || proposal.context.key !== context.key) throw new McpOwnerReviewError("view_changed");
    proposal.controller?.abort(); this.proposals.delete(id); return { cancelled: true };
  }
  dismiss(clientId: string) { for (const [id, proposal] of this.proposals) if (proposal.context.clientId === clientId) { proposal.controller?.abort(); this.proposals.delete(id); } }
  async close() { this.closed = true; for (const proposal of this.proposals.values()) proposal.controller?.abort(); await Promise.allSettled([...this.inspections]); this.proposals.clear(); this.hostScope.emitDestroy(); if (this.children) throw new McpOwnerReviewError("drain_unknown"); }
}
