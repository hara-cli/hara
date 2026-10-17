import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { runConfiguredAgent } from "../agent-runtime/dispatch.js";
import { continueTaskExecution, createTaskExecution, finishTaskExecution, type TaskExecution } from "../session/task.js";
import type { RunOpts, RunOutcome } from "../agent/loop.js";
import type { Provider } from "../providers/types.js";
import type { Tool } from "../tools/registry.js";
import { redactSensitiveText } from "../security/secrets.js";
import { ensurePrivateStateSubdirectory } from "../security/private-state.js";
import { LocalWorkspaceCatalog } from "./local-catalog.js";
import { WorkspaceResources } from "./resources.js";
import { currentWorkspaceResourceBinding, WorkspaceResourceStorage } from "./resource-context.js";
import { WorkspaceConnectionStoreV2, type ScopedConnection, type ScopedRunConnection } from "./scoped-connections.js";
import { closedWorkspaceHistory, WorkspaceConversationStore, type WorkspaceConversation, type WorkspaceUsage } from "./conversations.js";
import { WorkspaceSessionLease } from "./session-lease.js";
import { freezeWorkspaceRunBinding, workspaceAgentBindingHash, type WorkspaceRunBinding } from "./run-binding.js";
import { createWorkspaceRunPermit, bindWorkspaceRunOptions, assertWorkspaceRunAdmission, closeWorkspaceRunPermit, type WorkspaceRunPermit } from "./execution.js";
import { WorkspaceTreeBudget } from "./tree-budget.js";
import { openLocalWorkspaceDevRoot } from "./local-dev-root.js";
import { localWorkspaceFileTools, withWorkspaceToolReceipts } from "./local-tools.js";
import { createWorkspaceSyntheticProvider, SYNTHETIC_CONNECTION } from "./synthetic-provider.js";
import { canonical, exact, messageBody, plain, positive, text, UUID } from "./local-state.js";
import type { WorkspaceAgentView } from "./agents.js";
import { WorkspaceRealKeyLane, type ArkAcceptanceSlice } from "./real-key-provider.js";

const ZERO_USAGE = (): WorkspaceUsage => ({ modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 });
interface WorkspaceHostContext { resources: WorkspaceResources; storage: WorkspaceResourceStorage; connections: WorkspaceConnectionStoreV2; project: string }
export interface LocalWorkspaceApproval {
  id: string; workspaceId: string; agentId: string; runId: string; expiresAt: string;
  resourceGeneration: string;
  kind: "agent_create"; draft: { username: string; displayName: string; title: string; instructions: string; runtimeId: "pi" };
}
interface PendingApproval { card: LocalWorkspaceApproval; clientId: string; selectionEpoch: number; job: LocalJob;
  finish(approved: boolean): void; timer: ReturnType<typeof setTimeout> }
interface LocalJob {
  id: string; workspaceId: string; agentId: string; clientId: string;
  context: WorkspaceHostContext; store: WorkspaceConversationStore; value: WorkspaceConversation;
  lease: WorkspaceSessionLease; controller: AbortController; signal: AbortSignal; binding: Readonly<WorkspaceRunBinding>;
  permit?: WorkspaceRunPermit; options?: RunOpts; promise: Promise<void>; outcome?: RunOutcome; error?: string; closed: boolean;
}
export type LocalWorkspaceProviderFactory = (connection: ScopedConnection, binding: ScopedRunConnection,
  context: { agent: WorkspaceAgentView; objective: string; colleagues: () => WorkspaceAgentView[] }) => Provider;

/** Opt-in local synthetic Host. No Account, global profiles, legacy SessionHub, discovery or installed Dev. */
export class LocalWorkspaceHost {
  readonly root: string;
  readonly home: string;
  readonly project: string;
  readonly catalog: LocalWorkspaceCatalog;
  private readonly contexts = new Map<string, WorkspaceHostContext>();
  private readonly jobs = new Map<string, LocalJob>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly clients = new Map<string, { workspaceId: string | null; agentId: string | null; epoch: number }>();
  private closing = false;
  private readonly realKey?: WorkspaceRealKeyLane;
  constructor(root: string, private readonly options: {
    providerFactory?: LocalWorkspaceProviderFactory;
    realKeyFile?: string;
    realKeySlice?: ArkAcceptanceSlice;
    interactiveApprovals?: boolean;
    onChange?: (event: { workspaceId: string; agentId?: string }) => void;
  } = {}) {
    const opened = openLocalWorkspaceDevRoot(root); this.root = opened.root; this.home = opened.home; this.project = opened.project;
    this.catalog = new LocalWorkspaceCatalog(this.home);
    if (options.realKeyFile) {
      if (options.providerFactory) throw new Error("Real-key acceptance cannot replace its trusted Provider factory");
      this.realKey = new WorkspaceRealKeyLane(this.root, options.realKeyFile, undefined, options.realKeySlice);
    }
    else if (options.realKeySlice) throw new Error("A real-key slice requires its explicit file reference");
  }
  modelMode() { return this.realKey ? { syntheticOnly: false, executionMode: "ark-real-key" as const, budget: this.realKey.summary() }
    : { syntheticOnly: true, executionMode: "synthetic" as const }; }
  private context(workspaceId: string): WorkspaceHostContext {
    const row = this.catalog.resolve(workspaceId);
    const found = this.contexts.get(workspaceId);
    if (found) { found.storage.run(() => {}); return found; }
    const expected = canonical([row.scope, row.actorId, row.policyRevision, row.grantId, row.grantRevision]);
    const assertAuthority = () => {
      const current = this.catalog.resolve(workspaceId);
      if (canonical([current.scope, current.actorId, current.policyRevision, current.grantId, current.grantRevision]) !== expected) throw new Error("Workspace authority changed; reopen explicitly");
    };
    const storage = new WorkspaceResourceStorage(this.home, row.scope, assertAuthority); storage.initialize();
    const resources = new WorkspaceResources(this.home, row.scope, { assertCurrent: assertAuthority }); resources.initialize();
    // The fixture project is workspace data too. Sharing the container root would let B observe
    // or reuse A's same-relative-path artifacts despite isolated chat/config/budget state.
    const project = storage.run(() => ensurePrivateStateSubdirectory(this.root, ["project", row.scope.workspaceId]).path);
    const context = { storage, resources, connections: new WorkspaceConnectionStoreV2(storage), project };
    this.contexts.set(workspaceId, context); return context;
  }
  private changed(workspaceId: string, agentId?: string): void { this.options.onChange?.({ workspaceId, ...(agentId ? { agentId } : {}) }); }
  assertGeneration(workspaceId: string, generation: unknown): void {
    const current = this.context(workspaceId).storage.run(() => currentWorkspaceResourceBinding()!.generation);
    if (typeof generation !== "string" || generation !== current) throw new Error("Workspace resource generation changed; refresh before acting");
  }
  list() {
    const value = this.catalog.read();
    return { revision: value.revision, activeWorkspaceId: value.activeWorkspaceId,
      workspaces: value.workspaces.map(row => ({ workspaceId: row.scope.workspaceId, label: row.label, role: "owner", active: row.active })), ...this.modelMode() };
  }
  createWorkspace(label: string, expectedRevision: number) {
    if (this.closing) throw new Error("Workspace Host is closing");
    const row = this.catalog.create(label, expectedRevision), context = this.context(row.scope.workspaceId);
    context.resources.agents.initializeMain(); this.changed(row.scope.workspaceId);
    return this.snapshot(row.scope.workspaceId);
  }
  select(clientId: string, workspaceId: string, expectedRevision: number): void {
    this.catalog.select(workspaceId, expectedRevision);
    const previous = this.clients.get(clientId);
    this.clients.set(clientId, { workspaceId, agentId: this.context(workspaceId).resources.agents.list().mainAgentId, epoch: (previous?.epoch ?? 0) + 1 });
    this.dismissApprovals(clientId); // selection never cancels/retargets a background run
  }
  selectAgent(clientId: string, workspaceId: string, agentId: string): void {
    const selection = this.clients.get(clientId);
    if (!selection || selection.workspaceId !== workspaceId || !this.context(workspaceId).resources.agents.get(agentId)) throw new Error("Agent selection belongs to another Workspace view");
    this.clients.set(clientId, { workspaceId, agentId, epoch: selection.epoch + 1 }); this.dismissApprovals(clientId);
  }
  disconnect(clientId: string): void { this.dismissApprovals(clientId); this.clients.delete(clientId); }
  private dismissApprovals(clientId: string): void {
    for (const pending of [...this.pending.values()]) if (pending.clientId === clientId) pending.finish(false);
  }
  configureSynthetic(workspaceId: string, expectedRevision: number): void {
    if (this.realKey) throw new Error("This explicit real-key lane cannot substitute synthetic results");
    this.context(workspaceId).connections.add({ ...SYNTHETIC_CONNECTION }, expectedRevision); this.changed(workspaceId);
  }
  configureApprovedConnection(workspaceId: string, expectedRevision: number): void {
    if (!this.realKey) throw new Error("Real-key acceptance was not explicitly enabled");
    this.context(workspaceId).connections.add(this.realKey.connectionInput(), expectedRevision); this.changed(workspaceId);
  }
  configureConnection(workspaceId: string, input: unknown, expectedRevision: number): void {
    if (this.realKey) throw new Error("This acceptance lane only permits its approved file-reference connection");
    if (!plain(input)) throw new Error("invalid connection input");
    this.context(workspaceId).connections.add(input as unknown as Parameters<WorkspaceConnectionStoreV2["add"]>[0], expectedRevision);
    this.changed(workspaceId);
  }
  revokeConnection(workspaceId: string, connectionId: string, expectedRevision: number): void {
    this.context(workspaceId).connections.revoke(connectionId, expectedRevision);
    for (const job of this.jobs.values()) if (!job.closed && job.workspaceId === workspaceId && job.binding.connection.connectionId === connectionId) job.controller.abort();
    this.changed(workspaceId);
  }
  snapshot(workspaceId: string, agentId?: string, clientId?: string) {
    const row = this.catalog.resolve(workspaceId), context = this.context(workspaceId), catalog = context.resources.agents.list();
    const selected = agentId ?? catalog.mainAgentId;
    if (!selected || !catalog.agents.some(agent => agent.agentId === selected)) throw new Error("Workspace Agent unavailable; no legacy roster was selected");
    const value = new WorkspaceConversationStore(context.storage, selected).read();
    const live = [...this.jobs.values()].find(job => !job.closed && job.workspaceId === workspaceId && job.agentId === selected);
    return { workspaceId, resourceGeneration: context.storage.run(() => currentWorkspaceResourceBinding()!.generation),
      label: row.label, agentRevision: catalog.revision, agents: catalog.agents, selectedAgentId: selected,
      connections: context.connections.list(), conversation: { revision: value.revision, sessionId: value.sessionId,
        state: live ? live.controller.signal.aborted ? "draining" : "running"
          : value.attempt?.state === "running" || value.attempt?.state === "draining" ? "needs_recovery"
          : value.attempt?.state === "completed" && value.task?.status !== "completed" ? "blocked" : value.attempt?.state ?? "idle",
        taskId: value.task?.id ?? null, objective: value.task?.objective ?? "", taskState: value.task?.status ?? null,
        runId: value.task?.workspaceRunBinding?.runId ?? null,
        completion: value.task?.checkpoint?.completion ?? null, blockReason: value.task?.checkpoint?.blockReason ?? null,
        usage: value.usage, runUsage: value.runUsage, pastTaskCount: value.pastTasks.length,
        history: value.history.map(message => message.role === "assistant" ? { role: message.role, text: message.text, tools: message.toolUses.map(tool => tool.name) }
          : message.role === "tool" ? { role: message.role, results: message.results.map(result => ({ id: result.id, name: result.name, content: result.content, isError: result.isError ?? false })) }
          : { role: message.role, content: message.content }) },
      approvals: [...this.pending.values()].filter(pending => pending.card.workspaceId === workspaceId && pending.card.agentId === selected && pending.clientId === clientId).map(pending => pending.card),
      ...this.modelMode() };
  }
  answerApproval(clientId: string, workspaceId: string, id: string, approved: boolean): void {
    const pending = this.pending.get(id), selection = this.clients.get(clientId);
    if (!pending || pending.card.workspaceId !== workspaceId || pending.clientId !== clientId || !selection || selection.workspaceId !== pending.card.workspaceId || selection.agentId !== pending.card.agentId
      || selection.epoch !== pending.selectionEpoch || pending.job.signal.aborted || Date.parse(pending.card.expiresAt) <= Date.now()) throw new Error("approval expired or belongs to another view");
    assertWorkspaceRunAdmission(pending.job.permit, pending.job.options!, "pi"); pending.finish(approved);
  }
  private approval(job: LocalJob, draft: LocalWorkspaceApproval["draft"]): Promise<boolean> {
    const selection = this.clients.get(job.clientId);
    if (this.options.interactiveApprovals === false || !selection || selection.workspaceId !== job.workspaceId || selection.agentId !== job.agentId || job.signal.aborted) { job.controller.abort(); return Promise.resolve(false); }
    const card: LocalWorkspaceApproval = { id: randomUUID(), workspaceId: job.workspaceId, agentId: job.agentId,
      resourceGeneration: job.binding.agent.resourceBinding.generation,
      runId: job.binding.runId, kind: "agent_create", expiresAt: new Date(Date.parse(job.value.attempt!.startedAt) + job.binding.budget.timeoutMs).toISOString(), draft: Object.freeze({ ...draft }) };
    return new Promise(resolve => {
      const onAbort = () => finish(false);
      const finish = (approved: boolean) => {
        if (!this.pending.delete(card.id)) return;
        clearTimeout(timer); job.signal.removeEventListener("abort", onAbort); if (!approved) job.controller.abort(); resolve(approved); this.changed(job.workspaceId, job.agentId);
      };
      const timer = setTimeout(() => finish(false), Math.max(1, Date.parse(card.expiresAt) - Date.now())); timer.unref();
      this.pending.set(card.id, { card, clientId: job.clientId, selectionEpoch: selection.epoch, job, finish, timer });
      job.signal.addEventListener("abort", onAbort, { once: true }); this.changed(job.workspaceId, job.agentId);
    });
  }
  private commit(job: LocalJob, task?: TaskExecution): void {
    job.lease.assertCurrent();
    if (job.closed) throw new Error("Workspace job is closed");
    if (task) job.value.task = task;
    const liveHistory = job.value.history;
    job.value = job.store.save(job.value.revision, { ...job.value, history: closedWorkspaceHistory(liveHistory) });
    job.value.history = liveHistory; // governor owns this mutable transcript; persistence returns a redacted copy
    this.changed(job.workspaceId, job.agentId);
  }
  private jobTools(job: LocalJob, agent: WorkspaceAgentView): Tool[] {
    const assertCurrent = () => { assertWorkspaceRunAdmission(job.permit, job.options!, "pi"); };
    const tools = localWorkspaceFileTools(job.context.project, assertCurrent);
    if (agent.kind !== "main") return withWorkspaceToolReceipts(tools);
    tools.push({ name: "agent_list", description: "Read the active colleagues of THIS Workspace only. Check existing names/IDs before creating or delegating; never recreate an already active colleague to repair a completion citation.", kind: "read",
      input_schema: { type: "object", properties: {} }, async run(input) {
        if (!plain(input) || !exact(input, [])) throw new Error("invalid colleague listing");
        assertCurrent(); return JSON.stringify({ agents: job.context.resources.agents.list().agents });
      } });
    tools.push({ name: "agent_create", description: "Create one colleague AFTER a fresh human confirmation. This tool waits while the card is pending; created:true is returned ONLY AFTER the card was approved and the colleague is active. Never ask for confirmation again after success. The internal runtime is pi; call them 同事 in user-facing text.", kind: "edit",
      input_schema: { type: "object", properties: { username: { type: "string" }, displayName: { type: "string" }, title: { type: "string" }, instructions: { type: "string" } }, required: ["username", "displayName", "title", "instructions"] },
      async run(input) {
        if (!plain(input) || !exact(input, ["username", "displayName", "title", "instructions"]) || !text(input.username, 64)
          || !text(input.displayName, 80) || !text(input.title, 180) || typeof input.instructions !== "string" || input.instructions.length > 8000) throw new Error("invalid colleague proposal");
        assertCurrent();
        const approved = await host.approval(job, { username: input.username, displayName: input.displayName, title: input.title, instructions: input.instructions, runtimeId: "pi" });
        if (!approved) throw new Error("同事建立未獲確認；沒有建立 Agent");
        assertCurrent();
        const created = job.context.resources.agents.create({ username: input.username, profile: { displayName: input.displayName, title: input.title }, instructions: input.instructions, runtimeId: "pi" }, job.context.resources.agents.list().revision);
        host.changed(job.workspaceId, job.agentId); return JSON.stringify({ created: true, humanConfirmed: true, approvalState: "consumed", agent: created });
      } });
    const host = this;
    tools.push({ name: "agent_contact", description: "Delegate one bounded same-Workspace file task to an existing colleague by exact agentId and await its actual verified result.", kind: "edit",
      input_schema: { type: "object", properties: { agentId: { type: "string" }, task: { type: "string" } }, required: ["agentId", "task"] },
      async run(input, toolContext) {
        if (!plain(input) || !exact(input, ["agentId", "task"]) || !text(input.agentId) || !messageBody(input.task, 2000)) throw new Error("invalid colleague task");
        assertCurrent();
        const target = job.context.resources.agents.get(input.agentId);
        if (!target || target.kind !== "colleague" || target.state !== "active" || target.runtime.id !== "pi") throw new Error("同空間同事不可用");
        const prior = new WorkspaceConversationStore(job.context.storage, target.agentId).read();
        const sameDelegation = prior.task?.workspaceRunBinding?.lineage.parentRunId === job.id;
        if (sameDelegation && prior.task?.status === "completed" && prior.task.checkpoint?.completion?.state === "verified") {
          return JSON.stringify({ completed: true, agentId: target.agentId, taskId: prior.task.id,
            runId: prior.task.workspaceRunBinding!.runId, completion: prior.task.checkpoint.completion, retainedReceipt: true });
        }
        const receipt = host.start(job.clientId, job.workspaceId, target.agentId, input.task, randomUUID(), sameDelegation, job, toolContext.signal);
        const child = host.jobs.get(receipt.runId)!;
        await child.promise; assertCurrent();
        if (!child.outcome || child.outcome.status !== "completed" || child.value.task?.status !== "completed"
          || child.value.task.checkpoint?.completion?.state !== "verified") throw new Error("同事任務未完成；請查看同事聊天，不重複執行");
        return JSON.stringify({ completed: true, agentId: target.agentId, taskId: child.value.task.id, runId: child.id,
          completion: child.value.task.checkpoint?.completion ?? null });
      } });
    return withWorkspaceToolReceipts(tools);
  }
  start(clientId: string, workspaceId: string, agentId: string, message: string, requestId: string, resume = false, parent?: LocalJob, parentSignal?: AbortSignal) {
    if (this.closing || !messageBody(message) || !UUID.test(requestId)) throw new Error("invalid Workspace message or closing Host");
    const context = this.context(workspaceId), agent = context.resources.agents.get(agentId);
    if (!agent || agent.state !== "active" || agent.runtime.id !== "pi") throw new Error("Agent Runtime unavailable; no fallback selected");
    if (parent && (parent.workspaceId !== workspaceId || parent.binding.lineage.depth !== 0)) throw new Error("delegation is limited to one same-Workspace hop");
    const store = new WorkspaceConversationStore(context.storage, agentId), digest = createHash("sha256").update(canonical([message, resume])).digest("hex");
    const duplicate = store.read().requests.find(request => request.requestId === requestId);
    if (duplicate) {
      if (duplicate.digest !== digest) throw new Error("message id already belongs to another request");
      return { runId: duplicate.runId, duplicate: true };
    }
    if ([...this.jobs.values()].some(job => !job.closed && job.workspaceId === workspaceId && job.agentId === agentId)) throw new Error("Agent is still running or draining");
    const lease = WorkspaceSessionLease.acquire(context.storage, store.sessionId);
    let job: LocalJob | undefined;
    try {
      let value = store.read(); // lock BEFORE loading the resumable state
      if (value.attempt?.state === "running" || value.attempt?.state === "draining") {
        value.attempt = { ...value.attempt, state: "interrupted", endedAt: new Date().toISOString() };
        if (value.task) value.task = finishTaskExecution(value.task, undefined, [], true)!;
        value = store.save(value.revision, value);
      }
      const row = this.catalog.resolve(workspaceId), host = this.catalog.read();
      let task: TaskExecution;
      if (resume) {
        if (!value.task?.workspaceRunBinding || value.task.status === "completed") throw new Error("no interrupted Workspace task to resume");
        if (parent && value.task.workspaceRunBinding.lineage.parentRunId !== parent.id) throw new Error("delegated resume belongs to another parent run");
        const continued = continueTaskExecution(value.task, { kind: "steer", expectedTurnId: value.task.turnId, turnId: randomUUID() });
        if (!continued.ok) throw new Error(continued.reason); task = continued.task;
        context.resources.agents.resolveTask(task.workspaceRunBinding!.agent); context.connections.resolve(task.workspaceRunBinding!.connection);
      } else {
        if (value.task) value.pastTasks.push({ task: value.task, usage: value.runUsage, endedAt: new Date().toISOString() });
        task = context.resources.agents.bindTask(createTaskExecution(message, randomUUID()), agentId, agent.configRevision, agent.agentEpoch);
        const project = lstatSync(context.project);
        task.workspaceRunBinding = freezeWorkspaceRunBinding({ schemaVersion: 1, scope: row.scope, agent: task.workspaceAgentBinding!,
          agentBindingHash: workspaceAgentBindingHash(task.workspaceAgentBinding!), connection: context.connections.capture(), runtimeContract: "hara-governed-pi-v1",
          project: { root: context.project, dev: project.dev, ino: project.ino }, sessionId: store.sessionId, runId: randomUUID(),
          lineage: parent ? { rootRunId: parent.binding.lineage.rootRunId ?? parent.id, parentRunId: parent.id, depth: 1 } : { rootRunId: null, parentRunId: null, depth: 0 },
          createdAt: new Date().toISOString(), host: { hostId: host.hostId, hostEpoch: host.hostEpoch, grantId: row.grantId, grantRevision: row.grantRevision, actorId: row.actorId, policyRevision: row.policyRevision },
          budget: parent ? { ...parent.binding.budget } : { maxRounds: 12, maxToolCalls: 32, maxTokens: this.realKey ? 80000 : 32000, timeoutMs: this.realKey ? 300000 : 120000 } });
        value.runUsage = ZERO_USAGE();
      }
      const binding = task.workspaceRunBinding!, controller = new AbortController();
      if (binding.project.root !== context.project) throw new Error("Workspace project root changed; old task retained read-only, no implicit project migration");
      const connection = context.connections.resolve(binding.connection);
      const provider = this.realKey ? this.realKey.createProvider(connection, binding.connection)
        : (this.options.providerFactory ?? createWorkspaceSyntheticProvider)(connection, binding.connection,
          { agent, objective: task.objective, colleagues: () => context.resources.agents.list().agents });
      const modelHistoryStart = value.history.length;
      value.history.push({ role: "user", content: message }); value.task = task;
      value.attempt = { attemptId: lease.attemptId, fence: (value.attempt?.fence ?? 0) + 1, runId: binding.runId, state: "running", startedAt: new Date().toISOString(), endedAt: null };
      value.requests.push({ requestId, digest, taskId: task.id, runId: binding.runId }); value = store.save(value.revision, value);
      job = { id: binding.runId, workspaceId, agentId, clientId, context, store, value, lease, controller,
        signal: parent ? AbortSignal.any([controller.signal, parent.signal, ...(parentSignal ? [parentSignal] : [])]) : controller.signal, binding, promise: Promise.resolve(), closed: false };
      const owned = job, tree = new WorkspaceTreeBudget(context.storage, binding.lineage.rootRunId ?? binding.runId, binding.budget);
      const tools = this.jobTools(owned, agent);
      owned.permit = createWorkspaceRunPermit({ binding, catalog: this.catalog, resources: context.resources, storage: context.storage, connections: context.connections,
        lease, provider, cwd: context.project, signal: owned.signal, toolNames: ["task_intake", "task_checkpoint", "todo_write", ...tools.map(tool => tool.name)], usage: value.runUsage,
        modelHistory: { history: value.history, start: modelHistoryStart },
        updateUsage: next => {
          const delta = ZERO_USAGE(); for (const key of Object.keys(delta) as (keyof WorkspaceUsage)[]) delta[key] = next[key] - owned.value.runUsage[key];
          owned.lease.assertCurrent(); tree.consume(delta);
          for (const key of Object.keys(delta) as (keyof WorkspaceUsage)[]) owned.value.usage[key] += delta[key];
          owned.value.runUsage = { ...next }; this.commit(owned);
        } });
      const configuration = context.resources.agents.resolveTask(binding.agent);
      owned.options = bindWorkspaceRunOptions(owned.permit, { ctx: { cwd: context.project, sessionId: store.sessionId, todoScope: `workspace-${binding.runId}`, sandbox: "off" },
        signal: owned.signal, approval: "auto-edit", approvalChannel: true, confirm: async () => false, quiet: true, hooks: false, extraTools: tools,
        systemOverride: `You are ${configuration.identity.displayName}, a clearly identified Hara AI colleague. ${configuration.instructions}\nUse only this Workspace's supplied tools. Never claim completion without observed evidence.\n`
          + `Current task objective (user data): ${JSON.stringify(task.objective)}. This attempt's messages are the working context; complete history remains local. On recovery use the checkpoint only as a hint and obtain fresh read-only observations before claiming completion.\n`
          + `Reply naturally in the user's language. Call AI coworkers 同事, not Pi 同事; pi is only an internal runtime. A greeting needs no tools.\n`
          + `For creation use agent_create and wait for the human card; for delegation use agent_contact with an existing exact agentId.\n`
          + `agent_create returns only AFTER the human has approved; created:true/humanConfirmed:true means the card is consumed, not pending. Never ask the human to confirm it again. Check agent_list before creating so an active colleague is not duplicated.\n`
          + `Successful Workspace tool results repeat the exact citation ID in receipt.toolCallId. Copy that exact value for completion.checks; never invent IDs or repeat side effects to fix a rejected citation. After restart, re-observe state with read-only tools and cite the new receipt.\n`
          + `Current authorized colleagues: ${JSON.stringify(context.resources.agents.list().agents.map(item => ({ agentId: item.agentId, name: item.identity.displayName, kind: item.kind })))}.\n`
          + `For file tasks read first; write only if necessary, then workspace_verify. End accepted tasks with task_checkpoint completion and observed tool_call_ids, not a prose-only claim.`,
        continuationSession: resume,
        taskIntake: { task, current: () => owned.value.task!, onUpdate: next => { owned.value.task = next; },
          onCheckpoint: next => this.commit(owned, next), onRoundUsage: next => this.commit(owned, next) } });
      this.jobs.set(owned.id, owned);
      owned.promise = this.run(owned); this.changed(workspaceId, agentId);
      return { runId: owned.id, duplicate: false };
    } catch (error) {
      if (job?.permit) void closeWorkspaceRunPermit(job.permit).catch(() => {}); else lease.release();
      throw error;
    }
  }
  private async run(job: LocalJob): Promise<void> {
    try {
      job.outcome = await job.context.storage.run(() => runConfiguredAgent(job.value.history, job.options!));
      job.value.task = finishTaskExecution(job.value.task!, job.outcome, [], job.signal.aborted)!;
      job.value.attempt = { ...job.value.attempt!, state: job.signal.aborted ? "cancelled" : job.outcome.status === "completed" ? "completed" : "blocked", endedAt: new Date().toISOString() };
      this.commit(job);
    } catch (error) {
      job.error = redactSensitiveText(error instanceof Error ? error.message : "Workspace execution failed").text.replaceAll(this.root, "[Dev state]");
      job.outcome = { status: "error", error: job.error };
      try { job.value.task = finishTaskExecution(job.value.task!, job.outcome, [], job.signal.aborted)!;
        job.value.attempt = { ...job.value.attempt!, state: job.signal.aborted ? "cancelled" : "blocked", endedAt: new Date().toISOString() }; this.commit(job); } catch { /* original checkpoint retained; no stale business authority */ }
    } finally {
      try { await closeWorkspaceRunPermit(job.permit!); } catch { job.error = "原執行鎖的身份無法確認；已保留，請診斷後再恢復。"; }
      job.closed = true; for (const pending of [...this.pending.values()]) if (pending.job === job) pending.finish(false);
      if (this.jobs.get(job.id) === job) this.jobs.delete(job.id);
      this.changed(job.workspaceId, job.agentId);
    }
  }
  cancel(workspaceId: string, agentId: string, runId: string): void {
    const job = this.jobs.get(runId);
    if (!job || job.workspaceId !== workspaceId || job.agentId !== agentId || job.closed) throw new Error("active Workspace run unavailable");
    job.controller.abort(); job.value.attempt = { ...job.value.attempt!, state: "draining" }; this.commit(job);
  }
  async wait(runId: string): Promise<void> { const job = this.jobs.get(runId); if (job) await job.promise; }
  async close(): Promise<void> {
    this.closing = true; for (const pending of [...this.pending.values()]) pending.finish(false);
    for (const job of this.jobs.values()) if (!job.closed) job.controller.abort();
    await Promise.all([...this.jobs.values()].map(job => job.promise));
  }
}
