import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function writeSse(response, chunks) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  response.end("data: [DONE]\n\n");
}

function finishChunk(reason = "stop") {
  return {
    id: "chatcmpl-interactive-agent-host",
    object: "chat.completion.chunk",
    created: 1,
    model: "mock-model",
    choices: [{ index: 0, delta: {}, finish_reason: reason }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  };
}

function respondText(response, text) {
  writeSse(response, [{
    id: "chatcmpl-interactive-agent-host",
    object: "chat.completion.chunk",
    created: 1,
    model: "mock-model",
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  }, finishChunk()]);
}

function respondTool(response, id, name, args) {
  writeSse(response, [{
    id: "chatcmpl-interactive-agent-host",
    object: "chat.completion.chunk",
    created: 1,
    model: "mock-model",
    choices: [{
      index: 0,
      delta: {
        role: "assistant",
        tool_calls: [{
          index: 0,
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: null,
    }],
  }, finishChunk("tool_calls")]);
}

function openCli(cwd, home, args = []) {
  const child = spawn(process.execPath, [join(process.cwd(), "dist", "index.js"), ...args], {
    cwd,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      HARA_QUIET: "1",
      HARA_TUI: "0",
      HARA_UPDATE_CHECK: "0",
      HARA_GUARDIAN: "0",
      HARA_AUTO_COMPACT: "0",
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  const listeners = new Set();
  const append = (chunk) => {
    output += String(chunk);
    for (const listener of listeners) listener();
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return {
    child,
    output: () => output,
    write: (line) => child.stdin.write(`${line}\n`),
    waitFor(pattern, timeoutMs = 15_000) {
      return new Promise((resolve, reject) => {
        let timer;
        const check = () => {
          if (!pattern.test(output)) return;
          clearTimeout(timer);
          listeners.delete(check);
          resolve(output);
        };
        timer = setTimeout(() => {
          listeners.delete(check);
          reject(new Error(`timed out waiting for ${pattern}:\n${output}`));
        }, timeoutMs);
        listeners.add(check);
        check();
      });
    },
    close(timeoutMs = 10_000) {
      if (child.exitCode !== null) return Promise.resolve(child.exitCode);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`timed out waiting for interactive CLI exit:\n${output}`));
        }, timeoutMs);
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
    },
  };
}

function taskIntake(goal, intent = "change") {
  return {
    intent,
    goal,
    constraints: ["keep the durable Agent tree bound to this session"],
    acceptance: ["the requested Agent state is observed"],
    steps: ["use the durable Agent tools", "verify the result"],
  };
}

test("interactive CLI hosts and cold-restores the durable Agent tree", { timeout: 45_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-interactive-agent-host-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const requests = [];
  let initialRound = 0;
  let restoreRound = 0;
  const server = createServer((request, response) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      const transcript = JSON.stringify(body.messages ?? []);
      if (transcript.includes("Initial assignment:\\nInspect the fixture and return a concise conclusion.")) {
        respondText(response, "child conclusion");
        return;
      }
      const restoring = transcript.includes("List the prior durable agents from this session");
      if (restoring) {
        restoreRound += 1;
        if (restoreRound === 1) {
          respondTool(response, "restore-intake", "task_intake", taskIntake("inspect the restored durable Agent tree", "answer"));
        } else if (restoreRound === 2) {
          respondTool(response, "restore-list", "list_agents", {});
        } else {
          respondText(response, "RESTORED_AGENT_TREE");
        }
        return;
      }
      initialRound += 1;
      if (initialRound === 1) {
        respondTool(response, "initial-intake", "task_intake", taskIntake("delegate one bounded inspection"));
      } else if (initialRound === 2) {
        respondTool(response, "initial-spawn", "spawn_agent", {
          task_name: "research",
          message: "Inspect the fixture and return a concise conclusion.",
        });
      } else if (initialRound === 3) {
        respondTool(response, "initial-wait", "wait_agent", {
          target: "/root/research",
          timeout_ms: 5_000,
        });
      } else if (initialRound === 4) {
        respondTool(response, "initial-receipt", "task_checkpoint", {
          completion: {
            state: "verified",
            evidence: ["wait_agent returned the child conclusion"],
          },
        });
      } else {
        respondText(response, "INITIAL_AGENT_TREE_COMPLETE");
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  let first;
  let second;
  try {
    mkdirSync(join(home, ".hara"), { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "AGENTS.md"), "# Fixture\n");
    writeFileSync(join(project, "package.json"), "{}\n");
    writeFileSync(join(home, ".hara", "config.json"), JSON.stringify({
      provider: "openai",
      apiKey: "fixture-key",
      model: "mock-model",
      baseURL: `http://127.0.0.1:${address.port}/v1`,
      guardian: "off",
      updateCheck: false,
      maxAgentRounds: 12,
    }));

    first = openCli(project, home);
    await first.waitFor(/Type a task\./u);
    first.write("Delegate one inspection through a durable Agent");
    await first.waitFor(/INITIAL_AGENT_TREE_COMPLETE[\s\S]*mock-model[\s\S]*›/u);
    first.write("/exit");
    assert.equal(await first.close(), 0, first.output());

    const sessionsDir = join(home, ".hara", "sessions");
    const sessionFile = readdirSync(sessionsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => join(sessionsDir, name))
      .find((filename) => Boolean(JSON.parse(readFileSync(filename, "utf8")).meta?.id));
    assert.ok(sessionFile, "interactive session was persisted");
    const session = JSON.parse(readFileSync(sessionFile, "utf8"));
    const sessionId = session.meta.id;
    const teamPath = join(home, ".hara", "agent-teams", `${sessionId}.json`);
    assert.equal(existsSync(teamPath), true);
    const team = JSON.parse(readFileSync(teamPath, "utf8"));
    assert.equal(team.agents.length, 1);
    assert.equal(team.agents[0].path, "/root/research");
    assert.equal(team.agents[0].status, "completed");
    assert.equal(team.agents[0].result, "child conclusion");
    const journal = readFileSync(join(sessionsDir, `${sessionId}.journal`), "utf8");
    assert.match(journal, /"kind":"agent"/u);
    assert.doesNotMatch(journal, /child conclusion|Inspect the fixture/u);

    second = openCli(project, home, ["--resume", sessionId]);
    await second.waitFor(/Type a task\./u);
    second.write("List the prior durable agents from this session");
    await second.waitFor(/RESTORED_AGENT_TREE[\s\S]*mock-model[\s\S]*›/u);
    second.write("/exit");
    assert.equal(await second.close(), 0, second.output());

    const restoreListRequest = requests.find((body) => {
      const transcript = JSON.stringify(body.messages ?? []);
      return transcript.includes("List the prior durable agents from this session")
        && transcript.includes("/root/research")
        && transcript.includes("completed");
    });
    assert.ok(restoreListRequest, "the resumed root turn observed the prior completed Agent metadata");
    assert.ok(
      requests.some((body) => body.tools?.some((tool) => tool.function?.name === "spawn_agent")),
      "interactive root prompts advertise durable collaboration tools",
    );
  } finally {
    for (const cli of [first, second]) {
      if (cli?.child.exitCode === null) cli.child.kill("SIGKILL");
    }
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
