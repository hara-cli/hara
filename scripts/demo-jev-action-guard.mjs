#!/usr/bin/env node

// Safe, deterministic local demo for the Hara × Jev Action Guard. It exercises the real built Hara
// classifier, HTTP request path, response parser and mode composition against a loopback System One fixture.
// No provider credential, contact, external message or destructive command is used.
import { createServer } from "node:http";
import { once } from "node:events";
import {
  classifyRisk,
  evaluateActionGuard,
  guardianActionDetail,
} from "../dist/security/guardian.js";

const delayMs = Math.max(0, Number.parseInt(process.env.HARA_DEMO_DELAY_MS ?? "1500", 10) || 0);
const pause = (factor = 1) => new Promise((resolve) => setTimeout(resolve, delayMs * factor));
const ansi = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  green: "\u001b[38;5;78m",
  amber: "\u001b[38;5;214m",
  red: "\u001b[38;5;203m",
  coral: "\u001b[38;5;209m",
  cyan: "\u001b[38;5;117m",
};

function line(value = "") {
  process.stdout.write(`${value}\n`);
}

function badge(color, label) {
  return `${color}${ansi.bold}${label}${ansi.reset}`;
}

function legacyAllowProvider() {
  return {
    id: "demo-legacy-guardian",
    model: "local-fixture",
    calls: 0,
    async turn() {
      this.calls += 1;
      return {
        text: '{"decision":"allow","reason":"in-scope test action"}',
        toolUses: [],
        stop: "end",
      };
    },
  };
}

let responseChoice = "allow";
let responseConfidence = 0.94;
let lastRequest;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  lastRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  await new Promise((resolve) => setTimeout(resolve, 135));
  response.writeHead(200, { "content-type": "application/json", connection: "close" });
  response.end(JSON.stringify({
    model: "jev-local-fixture-1.13.0",
    answers: {
      action_guard: {
        type: "choice",
        choice: responseChoice,
        confidence: responseConfidence,
        probabilities: responseChoice === "allow"
          ? { allow: responseConfidence, review: 0.04, block: 0.02 }
          : { allow: 0.12, review: responseConfidence, block: 0.1 },
      },
    },
    usage: { input_tokens: 286, output_tokens: 31 },
  }));
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("loopback fixture did not start");
const baseURL = `http://127.0.0.1:${address.port}`;

try {
  process.stdout.write("\u001b[2J\u001b[H");
  line(`${ansi.coral}${ansi.bold}HARA × JEV ACTION GUARD${ansi.reset}`);
  line(`${ansi.dim}本机验证 · LOCAL DRY RUN · 不连接真实联系人，不执行真实发送${ansi.reset}`);
  line("────────────────────────────────────────────────────────────────────────");
  await pause();

  line(`${ansi.bold}01  普通读取：确定性快路径${ansi.reset}`);
  const readRisk = classifyRisk("read_file", "read", { path: "README.md" }, process.cwd());
  line(`    ${badge(ansi.green, "LOW")}  read_file → ${readRisk.category}`);
  line(`    ${ansi.green}0 次 Jev 请求 · 0 次 Guardian 模型请求${ansi.reset}`);
  line(`    ${ansi.dim}读取、截图、检索与项目内编辑不增加网络判断。${ansi.reset}`);
  await pause(1.2);

  line();
  line(`${ansi.bold}02  微信测试群外发：shadow 观察${ansi.reset}`);
  const target = "weixin:test-group-private-id";
  const detail = guardianActionDetail("channel_message", {
    action: "send",
    target,
    text: "Jev 联调完成，请只回复收到。",
  });
  const legacy = legacyAllowProvider();
  const shadow = await evaluateActionGuard(
    legacy,
    { engine: "typesafe", config: { mode: "shadow", apiKey: "local-demo", baseURL } },
    {
      tool: "channel_message",
      category: "external_communication",
      classifierReason: "external communication through weixin",
      detail,
    },
    [{ role: "user", content: "给已连接的测试群发一条 Jev 联调完成消息。" }],
  );
  if (JSON.stringify(lastRequest).includes("test-group-private-id")) {
    throw new Error("recipient id entered the Jev state");
  }
  line(`    动作摘要  ${ansi.cyan}${detail}${ansi.reset}`);
  line(`    ${badge(ansi.green, "JEV ALLOW")}  ${Math.round((shadow.confidence ?? 0) * 100)}%  ·  ${shadow.elapsedMs}ms  ·  ${shadow.model}`);
  line(`    生效决定  ${badge(ansi.green, String(shadow.decision).toUpperCase())}  ·  旧 Guardian 调用 ${legacy.calls} 次（仅 shadow 对照）`);
  line(`    ${ansi.dim}收件人/群 ID 已移除；本演示不调用真实 channel_message。${ansi.reset}`);
  await pause(1.4);

  line();
  line(`${ansi.bold}03  含糊动作：advisory 转人工复核${ansi.reset}`);
  responseChoice = "review";
  responseConfidence = 0.78;
  const advisoryProvider = legacyAllowProvider();
  const advisory = await evaluateActionGuard(
    advisoryProvider,
    { engine: "typesafe", config: { mode: "advisory", apiKey: "local-demo", baseURL } },
    {
      tool: "computer",
      category: "computer_action",
      classifierReason: "computer click affects another application",
      detail: "operation=click app=browser target=Submit",
    },
    [{ role: "user", content: "先检查表单，暂时不要提交。" }],
  );
  line(`    ${badge(ansi.amber, "JEV REVIEW")}  ${Math.round((advisory.confidence ?? 0) * 100)}%  ·  ${advisory.elapsedMs}ms`);
  line(`    生效决定  ${badge(ansi.amber, String(advisory.decision).toUpperCase())}  ·  需要真人确认`);
  line(`    ${ansi.green}旧 Guardian 调用 ${advisoryProvider.calls} 次 · active 模式少一次通用模型回合${ansi.reset}`);
  await pause(1.4);

  line();
  line(`${ansi.bold}04  Jev 不可用：enforce 安全降级${ansi.reset}`);
  await new Promise((resolve) => server.close(resolve));
  const unavailableProvider = legacyAllowProvider();
  const unavailable = await evaluateActionGuard(
    unavailableProvider,
    { engine: "typesafe", config: { mode: "enforce", apiKey: "local-demo", baseURL } },
    {
      tool: "channel_message",
      category: "external_communication",
      classifierReason: "external communication through weixin",
      detail: "operation=send channel=weixin message=test",
    },
    [{ role: "user", content: "发送测试消息。" }],
    { timeoutMs: 500 },
  );
  line(`    ${badge(ansi.red, "JEV UNAVAILABLE")}  →  ${badge(ansi.amber, String(unavailable.decision).toUpperCase())}`);
  line(`    ${ansi.amber}无人值守时不执行；有审批通道时交给真人。${ansi.reset}`);
  line(`    旧 Guardian 调用 ${unavailableProvider.calls} 次 · enforce 不静默放行`);
  await pause(1.3);

  line();
  line("────────────────────────────────────────────────────────────────────────");
  line(`${badge(ansi.green, "PASS")}  本机 Action Guard 链路通过`);
  line(`${ansi.dim}真实 TypeSafe 服务上线前，先用 shadow 收集准确率、延迟与成本。${ansi.reset}`);
  await pause(1.5);
} finally {
  if (server.listening) await new Promise((resolve) => server.close(resolve));
}
