// Self-contained: fixtures embed this function in an executable, with no dependency on Hara code.
export async function fakeCodexMain() {
  const fs = await import("node:fs"), readline = await import("node:readline"), crypto = await import("node:crypto");
  const args = process.argv.slice(2), command = process.argv[1];
  const mode = () => JSON.parse(fs.readFileSync(command + ".mode.json", "utf8"));
  const send = value => console.log(JSON.stringify(value));
  const note = (method, params) => send({ method, params });
  const reply = (message, result) => send({ id: message.id, result });
  const error = message => { const failure = mode().failure; send({ id: message.id, error: { code: -32000,
    message: String(failure).startsWith("runtime_auth") ? "401 Unauthorized PRIVATE_ACCOUNT_DETAIL" : failure === "project_not_trusted" ? "Not inside a trusted directory PRIVATE_ACCOUNT_DETAIL" : "PRIVATE_ACCOUNT_DETAIL" } }); };
  if (args[0] === "--version") { console.log("codex 1.2.3"); return; }
  if (args[0] === "debug") { send({ models: [{ slug: "fixture-model" }] }); return; }
  if (args[0] !== "app-server") { process.exitCode = 2; return; }
  if (mode().startupStderr) { process.stderr.write(mode().startupStderr); process.exitCode = 1; return; }
  let thread, config, cwd, turnId, total = { inputTokens: 0, outputTokens: 0 }, meta, stopped = false;
  const save = () => { fs.writeFileSync(command + ".meta.next", JSON.stringify(meta)); fs.renameSync(command + ".meta.next", command + ".meta.json"); };
  async function execute(params) {
    const currentTurn = turnId, selected = mode().mode;
    const bridge = Object.values(config?.mcp_servers ?? {}).find(row => row.url && row.required), url = bridge?.url, token = process.env.HARA_WORKSPACE_MCP_TOKEN;
    meta = { pid: process.pid, url, mode: selected, tokenPresent: Boolean(token), tokenInArgv: args.some(value => token && value.includes(token)),
      readOnly: false, onRequest: false, nativeSandboxDisabled: true, nativeApprovalDisabled: true, haraOnlyTrust: bridge?.default_tools_approval_mode === "approve",
      tokenFingerprint: crypto.createHash("sha256").update(token ?? "").digest("hex") };
    const boundary = (paths, write) => Array.isArray(paths) ? paths.map(path => {
      let allowed = false;
      try { if (write) fs.writeFileSync(path, "unexpected native boundary write"); else fs.readFileSync(path); allowed = true; } catch {}
      return { path, allowed };
    }) : [];
    meta.boundaryWrites = boundary(mode().boundaryWriteProbes, true);
    meta.boundaryReads = boundary(mode().boundaryReadProbes, false);
    save();
    const rpc = (method, data) => note(method, { threadId: thread, turnId: currentTurn, ...data });
    if (selected === "hang") return;
    if (selected === "native-write" || selected === "native-claim") {
      rpc("item/started", { item: { type: "fileChange", changes: [{ path: "native-result.txt", kind: { type: "add" } }] } });
      if (selected === "native-write") {
        try { fs.writeFileSync(cwd + "/native-result.txt", mode().content ?? "native file result"); }
        catch { meta.writeDenied = true; save(); }
      }
      rpc("item/completed", { item: { type: "fileChange", changes: [{ path: "native-result.txt", kind: { type: "add" } }] } });
    }
    if (selected === "background") {
      const {spawn}=await import("node:child_process");
      const child=spawn("/bin/sh",["-c","trap '' TERM; /bin/sleep 300 & echo $!; wait"],{detached:true,stdio:["ignore","pipe","ignore"]});
      const id=await new Promise(resolve=>child.stdout.once("data",chunk=>resolve(Number(chunk.toString().trim()))));
      meta.backgroundPid=id;meta.toolPid=child.pid;save();child.stdout.destroy();
      rpc("item/completed",{item:{type:"commandExecution",command:"sleep 300"}});
    }
    if (selected === "risk") rpc("item/started", { item: { type: "commandExecution", command: "git push PRIVATE_ARGUMENT" } });
    if (selected === "crash") { process.exit(7); }
    if (selected === "wrong-events") {
      note("item/completed", { threadId: "foreign", turnId: currentTurn, item: { type: "agentMessage", text: "FOREIGN_THREAD" } });
      note("turn/completed", { threadId: thread, turn: { id: "old-turn", status: "completed" } });
      const tokenUsage = { total: { inputTokens: 500000, cachedInputTokens: 0, outputTokens: 20 }, last: { inputTokens: 500000, cachedInputTokens: 0, outputTokens: 20 } };
      note("thread/tokenUsage/updated", { threadId: "foreign", turnId: currentTurn, tokenUsage });
      note("thread/tokenUsage/updated", { threadId: thread, turnId: "old-turn", tokenUsage });
    }
    let serial = 0, session;
    async function request(method, parameters) {
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream",
        Authorization: "Bearer " + token, ...(session ? { "Mcp-Session-Id": session } : {}) },
        body: JSON.stringify({ jsonrpc: "2.0", ...(method.startsWith("notifications/") ? {} : { id: ++serial }), method, params: parameters }) });
      session = response.headers.get("mcp-session-id") ?? session;
      if (response.status === 202) return {};
      const body = await response.json();
      if (!response.ok || body.error) throw new Error("fixture MCP request refused");
      return body.result;
    }
    async function call(name, input) {
      const result = await request("tools/call", { name, arguments: input });
      return { isError: Boolean(result.isError), text: result.content?.[0]?.text ?? "" };
    }
    function receiptText(text) { return text.split("\n\n<system-reminder>")[0]; }
    if (!["reply", "over-budget", "native-write", "native-claim", "risk"].includes(selected)) {
      await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fake-codex", version: "1" } });
      await request("notifications/initialized", {});
      meta.tools = (await request("tools/list", {})).tools.map(tool => tool.name); save();
      if (selected === "create") {
        meta.intake = await call("task_intake", { intent: "change", goal: "Create one test colleague after confirmation",
          constraints: ["Only this Workspace"], acceptance: ["The colleague is active after human confirmation"],
          steps: ["Check colleagues", "Wait for the human card", "Verify creation"] }); save();
      }
      meta.listed = await call("agent_list", {}); save();
      if (selected === "create") {
        meta.created = await call("agent_create", { username: "fixture-colleague", displayName: "Fixture Colleague", title: "Test", instructions: "Only the assigned Workspace task." }); save();
        const value = JSON.parse(receiptText(meta.created.text));
        if (value.created) {
          meta.second = await call("agent_create", { username: "second", displayName: "Second", title: "Test", instructions: "Stay scoped." }); save();
          await call("task_checkpoint", { completion: { state: "verified", checks: [{ acceptance_index: 0,
            evidence: "Human confirmed and the tool observed the active colleague", tool_call_ids: [value.receipt.toolCallId] }],
            final_answer: "The test colleague was created after confirmation." } });
        }
      }
    }
    if (stopped || turnId !== currentTurn) return;
    const inputTokens = selected === "over-budget" ? 300000 : 100;
    const samples = mode().telemetry ?? [{ total: { inputTokens: total.inputTokens + inputTokens, outputTokens: total.outputTokens + 20 }, last: { inputTokens, outputTokens: 20 } }];
    for (const sample of samples) {
      total = sample.total;
      const state = JSON.parse(fs.readFileSync(command + ".native.json", "utf8")); state.total = total; fs.writeFileSync(command + ".native.json", JSON.stringify(state));
      rpc("thread/tokenUsage/updated", { tokenUsage: sample });
    }
    rpc("item/completed", { item: { type: "agentMessage", text: ["native-write", "native-claim"].includes(selected) ? "The file change is ready." : selected === "leak" ? token : ["reply", "usage-reset"].includes(selected) ? "registered codex reply" : "Scoped CLI reply" } });
    note("turn/completed", { threadId: thread, turn: { id: currentTurn, status: "completed" } });
  }
  for await (const line of readline.createInterface({ input: process.stdin })) {
    const message = JSON.parse(line), p = message.params ?? {};
    if (message.id === undefined) continue;
    fs.appendFileSync(command + ".rpc.jsonl", JSON.stringify({ pid: process.pid, method: message.method, params: p }) + "\n");
    if (message.method === "model/list" && mode().inventory) { reply(message, mode().inventory); continue; }
    if (message.method === "model/list") { reply(message, { data: ["fixture-model", "fixture-model-2"].map(id => ({ id, displayName: id,
      supportedReasoningEfforts: ["low", "high"].map(reasoningEffort => ({ reasoningEffort, description: reasoningEffort })), isDefault: id === "fixture-model" })) }); continue; }
    if (["thread/start", "thread/resume"].includes(message.method)) {
      if (mode().recordHome) {
        fs.writeFileSync(command + ".home", process.env.HOME + "\nlogin=" + (fs.existsSync(process.env.HOME + "/.codex/auth.json") ? "present" : "missing") + "\n");
        fs.writeFileSync(command + ".codexhome", (process.env.CODEX_HOME ?? "unset") + "\n");
      }
      if (mode().failure && mode().failure !== "runtime_auth_recovered" || mode().mode === "resume-fail" && message.method === "thread/resume") { error(message); continue; }
      if (message.method === "thread/resume") {
        const state = JSON.parse(fs.readFileSync(command + ".native.json", "utf8"));
        if (state.thread !== p.threadId) { error(message); continue; }
        thread = p.threadId; total = mode().mode === "usage-reset" ? { inputTokens: 1, outputTokens: 1 } : state.total;
      } else { thread = crypto.randomUUID(); fs.writeFileSync(command + ".native.json", JSON.stringify({ thread, total })); }
      cwd = p.cwd; config = p.config;
      reply(message, { thread: { id: thread, cwd, status: { type: mode().threadStatus ?? "idle" } }, approvalPolicy: p.approvalPolicy, approvalsReviewer: "user",
        sandbox: { type: p.sandbox === "danger-full-access" ? "dangerFullAccess" : "readOnly", networkAccess: false }, model: p.model, reasoningEffort: p.config?.model_reasoning_effort ?? null }); continue;
    }
    if (message.method === "turn/start") {
      turnId = crypto.randomUUID(); stopped = false; reply(message, { turn: { id: turnId } });
      void execute(p).catch(() => { if (!stopped) note("turn/completed", { threadId: thread, turn: { id: turnId, status: "failed" } }); }); continue;
    }
    if (message.method === "turn/interrupt") {
      stopped = true; reply(message, {}); note("turn/completed", { threadId: thread, turn: { id: turnId, status: "interrupted" } }); continue;
    }
    if (message.method === "thread/unsubscribe") { reply(message, { status: "unsubscribed" }); note("thread/closed", { threadId: thread }); continue; }
    reply(message, {});
  }
}
