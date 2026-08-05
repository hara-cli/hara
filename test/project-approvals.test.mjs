import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  projectApprovalPolicy,
  projectApprovalScope,
} from "../dist/security/project-approvals.js";
import { runAgent } from "../dist/agent/loop.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hara-project-approval-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const nested = join(project, "packages", "app");
  mkdirSync(home);
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(project, "package.json"), "{}\n");
  return { root, home, project, nested };
}

test("project approval scopes are narrow, stable and credential-free", () => {
  const { root, project, nested } = fixture();
  try {
    const bashA = projectApprovalScope("bash", { command: "npm test" }, nested);
    const bashB = projectApprovalScope("bash", { command: "npm test" }, project);
    const bashOther = projectApprovalScope("bash", { command: "npm run build" }, project);
    const bashEnvironment = projectApprovalScope("bash", { command: "NODE_ENV=test npm test" }, project);
    assert.equal(bashA.key, bashB.key, "subdirectory cwd preserves the exact project command scope");
    assert.notEqual(bashA.key, bashOther.key, "another command needs another explicit grant");
    assert.notEqual(bashA.key, bashEnvironment.key, "environment assignments never inherit a plain command grant");
    assert.match(bashA.summary, /exact Bash command/);

    const pythonA = projectApprovalScope("python", { code: "print('one')" }, project);
    const pythonB = projectApprovalScope("python", { code: "print('two')" }, nested);
    assert.equal(pythonA.key, pythonB.key, "the UI explicitly grants the project's Python operation family");
    assert.match(pythonA.summary, /Python execution for this project/);

    const tempA = projectApprovalScope("write_file", { path: ".tmp/a.txt", content: "a" }, project);
    const tempB = projectApprovalScope("edit_file", { path: ".tmp/b.txt", old_string: "b", new_string: "c" }, project);
    const log = projectApprovalScope("write_file", { path: "logs/a.txt", content: "a" }, project);
    assert.equal(tempA.key, tempB.key, "write and edit share the reviewed .tmp directory scope");
    assert.notEqual(tempA.key, log.key, "each reviewed scratch directory remains separate");

    const sourceA = projectApprovalScope("write_file", { path: "src/a.ts", content: "SECRET_A" }, project);
    const sourceB = projectApprovalScope("edit_file", { path: "src/b.ts", old_string: "x", new_string: "SECRET_B" }, project);
    assert.notEqual(sourceA.key, sourceB.key, "ordinary source changes bind to one exact file");
    const manyFieldsA = Object.fromEntries(Array.from({ length: 1_001 }, (_, index) => [`field${index}`, index]));
    const manyFieldsB = { ...manyFieldsA, field1000: "changed" };
    assert.notEqual(
      projectApprovalScope("scoped_exec", manyFieldsA, project).key,
      projectApprovalScope("scoped_exec", manyFieldsB, project).key,
      "large exact inputs never collide through truncation",
    );
    for (const scope of [bashA, bashOther, bashEnvironment, pythonA, tempA, log, sourceA, sourceB]) {
      assert.match(scope.key, /^v1:[a-f0-9]{64}$/);
      assert.doesNotMatch(scope.key, /npm|SECRET|src|project/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project approvals persist privately and never store commands or tool input", () => {
  const { root, home, project } = fixture();
  try {
    const scope = projectApprovalScope("bash", {
      command: "deploy --token DO_NOT_PERSIST_THIS_SECRET",
    }, project);
    const first = projectApprovalPolicy(project, home);
    assert.equal(first.has(scope.key), false);
    first.remember(scope.key);
    assert.equal(first.has(scope.key), true);
    assert.equal(projectApprovalPolicy(project, home).has(scope.key), true, "a new session inherits the project grant");

    const store = join(home, ".hara", "project-approvals.json");
    const text = readFileSync(store, "utf8");
    assert.doesNotMatch(text, /deploy|token|DO_NOT_PERSIST_THIS_SECRET/);
    assert.equal(text.includes(project), false, "the store keeps an opaque project identity, not its path");
    if (process.platform !== "win32") assert.equal(statSync(store).mode & 0o777, 0o600);

    const unsafeHomePolicy = projectApprovalPolicy(home, home);
    assert.equal(unsafeHomePolicy.has(scope.key), false);
    assert.throws(
      () => unsafeHomePolicy.remember(scope.key),
      /unavailable|allowed once/,
      "Home itself can never become a remembered project-execution scope",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a replaced project directory cannot inherit the previous inode's grants", () => {
  const { root, home, project } = fixture();
  try {
    const scope = projectApprovalScope("python", { code: "print('safe')" }, project);
    projectApprovalPolicy(project, home).remember(scope.key);
    const retired = `${project}-retired`;
    renameSync(project, retired);
    mkdirSync(project);
    writeFileSync(join(project, "package.json"), "{}\n");
    const replacementScope = projectApprovalScope("python", { code: "print('safe')" }, project);
    assert.notEqual(replacementScope.key, scope.key, "a live session also observes the replaced directory identity");
    assert.equal(
      projectApprovalPolicy(project, home).has(scope.key),
      false,
      "the private store additionally binds the directory identity",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupt approval store fails closed and is never silently overwritten", () => {
  const { root, home, project } = fixture();
  try {
    mkdirSync(join(home, ".hara"));
    const store = join(home, ".hara", "project-approvals.json");
    writeFileSync(store, "{not-json", { mode: 0o600 });
    const scope = projectApprovalScope("python", { code: "print('safe')" }, project);
    const policy = projectApprovalPolicy(project, home);
    assert.equal(policy.has(scope.key), false);
    assert.throws(() => policy.remember(scope.key), /unavailable|allowed once/);
    assert.equal(readFileSync(store, "utf8"), "{not-json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the agent reuses only the accepted project scope and asks again for different input", async () => {
  const { root, project } = fixture();
  const accepted = new Set();
  const policy = {
    has: (key) => accepted.has(key),
    remember: (key) => accepted.add(key),
  };
  const inputs = [{ target: "one" }, { target: "one" }, { target: "two" }];
  let providerTurn = 0;
  let executions = 0;
  let confirmations = 0;
  const provider = {
    id: "approval-scope-provider",
    model: "approval-scope-model",
    async turn() {
      if (providerTurn < inputs.length) {
        const input = inputs[providerTurn];
        providerTurn += 1;
        return {
          text: "",
          toolUses: [{ id: `tool-${providerTurn}`, name: "scoped_exec", input }],
          stop: "tool_use",
        };
      }
      return { text: "done", toolUses: [], stop: "end" };
    },
  };
  try {
    const outcome = await runAgent([{ role: "user", content: "run scoped actions" }], {
      provider,
      ctx: { cwd: project },
      approval: "suggest",
      confirm: async () => {
        confirmations += 1;
        return "always";
      },
      autoApprove: new Set(),
      projectApprovals: policy,
      extraTools: [{
        name: "scoped_exec",
        description: "test-only scoped execution",
        input_schema: {
          type: "object",
          properties: { target: { type: "string" } },
          required: ["target"],
        },
        kind: "exec",
        async run() {
          executions += 1;
          return "ok";
        },
      }],
      quiet: true,
    });
    assert.equal(outcome.status, "completed");
    assert.equal(executions, 3);
    assert.equal(confirmations, 2, "same input reuses the scope; different input prompts again");
    assert.equal(accepted.size, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
