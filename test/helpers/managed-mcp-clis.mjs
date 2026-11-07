// Synthetic CLI executables exercise the real registered drivers and attempt bridge. No vendor API.
import fs from "node:fs";
import { dirname } from "node:path";
import { fakeCodexMain } from "./fake-codex-app-server.mjs";
async function fakeClaudeMain(input) {
  const fs = await import("node:fs"); const args = process.argv.slice(2), command = process.argv[1];
  const index = args.indexOf("--mcp-config");
  if (index < 0) { console.log("Claude Code 2.1.316"); return; }
  const { Client } = await import(input.clientModule), { StreamableHTTPClientTransport } = await import(input.transportModule);
  const cfg = JSON.parse(args[index + 1]), url = cfg.mcpServers.hara.url, token = process.env.HARA_WORKSPACE_MCP_TOKEN;
  const client = new Client({ name: "synthetic-claude-cli", version: "1" }, { capabilities: {} });
  const meta = { runtime: "claude", tokenPresent: Boolean(token), tokenInArgv: args.some(value => token && value.includes(token)), url };
  const save = () => fs.writeFileSync(command + ".meta.json", JSON.stringify(meta)); save();
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: "Bearer " + token } } }));
    meta.tools = (await client.listTools()).tools.map(tool => tool.name); save();
    await client.callTool({ name: "task_intake", arguments: { intent: "investigate", goal: "Read the fixed synthetic MCP data", constraints: ["Only the reviewed synthetic server"], acceptance: ["Observe the synthetic result"], steps: ["Read the fixture"] } });
    meta.plugin = await client.callTool({ name: input.toolName, arguments: { key: "one" } }); save();
    const observed = JSON.parse(meta.plugin.content[0].text.split("\n\n<system-reminder>")[0]);
    await client.callTool({ name: "task_checkpoint", arguments: { completion: { state: "verified", checks: [{ acceptance_index: 0, evidence: "Observed the synthetic server result only", tool_call_ids: [observed.receipt.toolCallId] }], final_answer: "Synthetic MCP result observed." } } });
  } finally { await client.close(); }
  console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Synthetic MCP result observed.", session_id: "synthetic-session", usage: { input_tokens: 10, output_tokens: 4 } }));
}
export function writeManagedMcpCli(command, runtime, toolName) {
  fs.mkdirSync(dirname(command), { recursive: true, mode: 0o700 });
  let code;
  if (runtime === "codex") {
    code = fakeCodexMain.toString();
    const anchor = 'meta.listed = await call("agent_list", {}); save();';
    if (!code.includes(anchor)) throw Error("Synthetic Codex fixture contract changed");
    code = code.replace(anchor, anchor + '\nif(selected === "managed") { meta.intake = await call("task_intake", {intent:"investigate",goal:"Read the fixed synthetic MCP data",constraints:["Only the reviewed synthetic server"],acceptance:["Observe the synthetic result"],steps:["Read the fixture"]}); meta.plugin = await call(mode().managedTool,{key:"one"}); save(); const observed=JSON.parse(receiptText(meta.plugin.text)); await call("task_checkpoint",{completion:{state:"verified",checks:[{acceptance_index:0,evidence:"Observed the synthetic server result only",tool_call_ids:[observed.receipt.toolCallId]}],final_answer:"Synthetic MCP result observed."}}); }');
    fs.writeFileSync(command + ".mode.json", JSON.stringify({ mode: "managed", managedTool: toolName, debugMcp: true }));
    code = "(" + code + ")().catch(error=>{const known=['EACCES','EPERM','ENOENT','SyntaxError','ReferenceError','TypeError'];const kind=[error.code,error.name].find(value=>known.includes(value))??'unknown';console.error('Synthetic fixture startup: '+kind);process.exitCode=7;});";
  } else {
    const input = { toolName, clientModule: import.meta.resolve("@modelcontextprotocol/sdk/client/index.js"), transportModule: import.meta.resolve("@modelcontextprotocol/sdk/client/streamableHttp.js") };
    code = "(" + fakeClaudeMain.toString() + ")(" + JSON.stringify(input) + ").catch(()=>process.exitCode=7);";
  }
  fs.writeFileSync(command, "#!" + process.execPath + "\n" + code + "\n", { mode: 0o700 });
}
