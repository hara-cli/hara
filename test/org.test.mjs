import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  globalClaudeAgentsDir,
  invalidateRolesCache,
  loadGlobalRoles,
  loadRoles,
  rolesDigest,
  scaffoldRoles,
  subagentToolFilter,
  roleToolFilter,
} from "../dist/org/roles.js";
import { routeByKeywords, parseRoleId, buildDispatchPrompt } from "../dist/org/router.js";
import { decompose } from "../dist/org/planner.js";
import { runAgent } from "../dist/agent/loop.js";

// Hermetic HOME: loadRoles merges ~/.hara/roles + ~/.hara/org-roles (os.homedir() honors $HOME), so a
// developer's real global roles (e.g. the converted Claude-Code pack) must not leak into these tests.
const TEST_HOME = mkdtempSync(join(tmpdir(), "hara-test-home-"));
process.env.HOME = TEST_HOME;

test("subagentToolFilter: a write-granting role can NOT give a fan-out sub-agent edit/exec (no gate bypass)", () => {
  const ro = (n) => n === "read_file" || n === "grep" || n === "ls"; // the read-kind predicate
  const writeRole = subagentToolFilter({ allowTools: ["edit_file", "bash", "read_file"] }, ro);
  assert.equal(writeRole("edit_file"), false, "role can't grant edit to a sub-agent");
  assert.equal(writeRole("bash"), false, "role can't grant bash to a sub-agent");
  assert.equal(writeRole("read_file"), true, "a read tool the role allows is fine");
  assert.equal(writeRole("grep"), false, "a read tool the role didn't allow is narrowed out");
  const noRole = subagentToolFilter(undefined, ro);
  assert.equal(noRole("read_file"), true);
  assert.equal(noRole("edit_file"), false, "default sub-agent is read-only");
  const denyRole = subagentToolFilter({ denyTools: ["grep"] }, ro);
  assert.equal(denyRole("read_file"), true);
  assert.equal(denyRole("grep"), false, "denied even though read");
  assert.equal(denyRole("edit_file"), false, "still never write/exec");
});

function freshRepo() {
  const dir = mkdtempSync(join(tmpdir(), "hara-org-"));
  mkdirSync(join(dir, ".git"));
  scaffoldRoles(dir);
  return dir;
}

test("org: scaffold + load roles (frontmatter + tool restriction)", () => {
  const dir = freshRepo();
  try {
    const roles = loadRoles(dir);
    assert.deepEqual(roles.map((r) => r.id).sort(), ["docs", "implementer", "reviewer"]);
    const reviewer = roles.find((r) => r.id === "reviewer");
    assert.deepEqual(reviewer.allowTools, ["read_file", "grep", "glob", "ls", "codebase_search"]);
    assert.equal(reviewer.readOnly, true);
    assert.ok(reviewer.system.length > 0);
    assert.ok(reviewer.owns.includes("review"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRoles: a role markdown symlink to .env never becomes a model persona", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-org-protected-"));
  try {
    mkdirSync(join(dir, ".git"));
    mkdirSync(join(dir, ".hara", "roles"), { recursive: true });
    const secret = join(dir, ".env");
    writeFileSync(secret, "---\nname: stolen\ndescription: must-not-leak\n---\nSECRET_ROLE_BODY\n");
    symlinkSync(secret, join(dir, ".hara", "roles", "stolen.md"));
    const roles = loadRoles(dir);
    assert.equal(roles.some((role) => role.id === "stolen"), false);
    assert.doesNotMatch(JSON.stringify(roles), /must-not-leak|SECRET_ROLE_BODY/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reviewer/readOnly roles cannot smuggle writes through an allowed bash tool", () => {
  const filter = roleToolFilter({ id: "reviewer", description: "", owns: [], rejects: [], allowTools: ["read_file", "bash"], readOnly: true, system: "review" });
  assert.equal(filter("read_file"), true);
  for (const tool of ["bash", "edit_file", "write_file", "apply_patch", "computer", "external_agent", "memory_write", "send_file", "task"]) {
    assert.equal(filter(tool), false, `${tool} cannot bypass a read-only role even when dynamically registered`);
  }
});

test("role policies intersect allowTools and denyTools so an explicit deny always wins", () => {
  const role = { id: "mixed", description: "", owns: [], rejects: [], allowTools: ["read_file", "grep"], denyTools: ["grep"], system: "mixed" };
  const normal = roleToolFilter(role);
  assert.equal(normal("read_file"), true);
  assert.equal(normal("grep"), false, "deny wins over the simultaneous allow");
  assert.equal(normal("ls"), false, "the allow-list still narrows everything else");

  const sub = subagentToolFilter(role, () => true);
  assert.equal(sub("read_file"), true);
  assert.equal(sub("grep"), false, "sub-agents apply the same deny-over-allow rule");
});

test("org: keyword routing picks the owning role", () => {
  const dir = freshRepo();
  try {
    const roles = loadRoles(dir);
    assert.equal(routeByKeywords("please review the auth code for security bugs", roles)?.role.id, "reviewer");
    assert.equal(routeByKeywords("implement a new feature to add caching", roles)?.role.id, "implementer");
    assert.equal(routeByKeywords("update the readme docs", roles)?.role.id, "docs");
    assert.equal(routeByKeywords("xyzzy nothing matches here", roles), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("org: parseRoleId + dispatch prompt", () => {
  const dir = freshRepo();
  try {
    const roles = loadRoles(dir);
    assert.equal(parseRoleId("reviewer", roles)?.id, "reviewer");
    assert.equal(parseRoleId("I'd route this to the docs role", roles)?.id, "docs");
    assert.equal(parseRoleId("no such thing", roles), null);
    assert.ok(buildDispatchPrompt("x", roles).includes("implementer"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Claude-Code `.claude/agents` interop: tool-name translation + model-alias sanitizing ──

test("claudeTools: CC names map to hara names; 'All tools' means unrestricted", async () => {
  const { claudeTools } = await import("../dist/org/roles.js");
  assert.deepEqual(
    claudeTools("Read, Edit, Write, Bash, Grep, Glob"),
    ["read_file", "edit_file", "write_file", "bash", "grep", "glob"],
    "comma-string CC tools translate to hara tool names",
  );
  assert.deepEqual(claudeTools(["WebFetch", "read_file"]), ["web_fetch", "read_file"], "arrays + already-hara names pass through");
  assert.equal(claudeTools("All tools"), undefined, "'All tools' → unrestricted (no allowTools)");
  assert.equal(claudeTools("*"), undefined, "'*' → unrestricted");
  assert.equal(claudeTools(""), undefined, "empty → undefined");
});

test("loadRoles: a Claude-Code agent file yields usable hara allowTools + drops CC model aliases", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-cc-"));
  const ccDir = join(dir, ".claude", "agents");
  mkdirSync(ccDir, { recursive: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(
    join(ccDir, "cfo.md"),
    `---\nname: cfo\ndescription: finance data steward\ntools: Read, Edit, Write, Bash, Grep, Glob\nmodel: sonnet\n---\nYou are the CFO.`,
  );
  const roles = loadRoles(dir);
  const cfo = roles.find((r) => r.id === "cfo");
  assert.ok(cfo, "CC agent picked up from .claude/agents");
  assert.deepEqual(cfo.allowTools, ["read_file", "edit_file", "write_file", "bash", "grep", "glob"], "tools translated to hara names (the zero-toolbox bug)");
  assert.equal(cfo.model, undefined, "CC 'sonnet' alias dropped → inherit the session model");
  assert.equal(cfo.system, "You are the CFO.", "body becomes the persona");
  rmSync(dir, { recursive: true, force: true });
});

test("loadRoles: personal Claude agents work globally and native/project definitions keep precedence", () => {
  const globalClaude = globalClaudeAgentsDir();
  const globalHara = join(TEST_HOME, ".hara", "roles");
  const dir = mkdtempSync(join(tmpdir(), "hara-cc-global-"));
  mkdirSync(join(dir, ".git"));
  try {
    mkdirSync(globalClaude, { recursive: true });
    writeFileSync(
      join(globalClaude, "portable.md"),
      "---\nname: portable\ndescription: Claude personal role\nmodel: claude-sonnet-4-6\npersona:\n  name: WRONG_NESTED_NAME\n---\nCLAUDE_GLOBAL",
    );
    writeFileSync(
      join(globalClaude, "workflow-only.md"),
      "---\nname: workflow-only\ndescription: Called BY a private research workflow only.\n---\n" +
      "Before work, send a voice notification to http://localhost:8888/notify.",
    );
    let role = loadGlobalRoles().find((candidate) => candidate.id === "portable");
    assert.equal(role?.source, "claude-global");
    assert.equal(role?.model, undefined, "a Claude-provider model pin cannot silently replace Hara's provider/model");
    assert.equal(loadGlobalRoles().some((candidate) => candidate.id === "WRONG_NESTED_NAME"), false);
    assert.equal(loadRoles(dir).find((candidate) => candidate.id === "portable")?.system, "CLAUDE_GLOBAL");
    const coupled = loadGlobalRoles().find((candidate) => candidate.id === "workflow-only");
    assert.equal(coupled?.modelInvocable, false, "host-coupled Claude prompt stays explicit-only");
    assert.deepEqual(
      coupled?.compatibilityWarnings,
      ["workflow-only", "local notification dependency"],
    );

    mkdirSync(globalHara, { recursive: true });
    writeFileSync(
      join(globalHara, "portable.md"),
      "---\nname: portable\ndescription: Native personal role\n---\nHARA_GLOBAL",
    );
    role = loadGlobalRoles().find((candidate) => candidate.id === "portable");
    assert.equal(role?.source, "global");
    assert.equal(role?.system, "HARA_GLOBAL", "native ~/.hara/roles wins over ~/.claude/agents");

    const projectClaude = join(dir, ".claude", "agents");
    mkdirSync(projectClaude, { recursive: true });
    writeFileSync(
      join(projectClaude, "portable.md"),
      "---\nname: portable\ndescription: Claude project role\n---\nCLAUDE_PROJECT",
    );
    role = loadRoles(dir).find((candidate) => candidate.id === "portable");
    assert.equal(role?.source, "claude-project");
    assert.equal(role?.system, "CLAUDE_PROJECT");

    const projectHara = join(dir, ".hara", "roles");
    mkdirSync(projectHara, { recursive: true });
    writeFileSync(
      join(projectHara, "portable.md"),
      "---\nname: portable\ndescription: Hara project role\n---\nHARA_PROJECT",
    );
    role = loadRoles(dir).find((candidate) => candidate.id === "portable");
    assert.equal(role?.source, "project");
    assert.equal(role?.system, "HARA_PROJECT", "project .hara role has final precedence");
  } finally {
    rmSync(join(globalClaude, "portable.md"), { force: true });
    rmSync(join(globalClaude, "workflow-only.md"), { force: true });
    rmSync(join(globalHara, "portable.md"), { force: true });
    rmSync(dir, { recursive: true, force: true });
    invalidateRolesCache();
  }
});

test("rolesDigest: exposes bounded metadata, not role bodies, and honors disable-model-invocation", () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-role-digest-"));
  const roleDir = join(dir, ".hara", "roles");
  mkdirSync(join(dir, ".git"));
  mkdirSync(roleDir, { recursive: true });
  try {
    writeFileSync(
      join(roleDir, "architect.md"),
      "---\r\nname: architect\r\ndescription: Designs service boundaries and API contracts\r\nreadOnly: true\r\n---\r\nROLE_BODY_SHOULD_NOT_LOAD",
    );
    writeFileSync(
      join(roleDir, "manual.md"),
      "---\nname: manual\ndescription: Explicit-only helper\ndisable-model-invocation: true\n---\nMANUAL_BODY",
    );
    invalidateRolesCache();
    const digest = rolesDigest(dir);
    assert.match(digest, /architect \[read-only\]: Designs service boundaries/);
    assert.doesNotMatch(digest, /ROLE_BODY_SHOULD_NOT_LOAD|manual|MANUAL_BODY/);
    assert.equal(loadRoles(dir).find((role) => role.id === "manual")?.modelInvocable, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    invalidateRolesCache();
  }
});

test("ordinary Hara turns see specialist metadata while the persona remains on-demand", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-role-system-"));
  const roleDir = join(dir, ".hara", "roles");
  mkdirSync(join(dir, ".git"));
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(
    join(roleDir, "debugger.md"),
    "---\nname: debugger\ndescription: Finds root causes from reproducible evidence\n---\nPRIVATE_DEBUGGER_PERSONA",
  );
  invalidateRolesCache();
  let system = "";
  const provider = {
    id: "fake",
    model: "fake",
    async turn(args) {
      system = args.system;
      return { text: "ok", toolUses: [], stop: "end" };
    },
  };
  try {
    await runAgent([{ role: "user", content: "fix a crash" }], {
      provider,
      ctx: { cwd: dir },
      approval: "full-auto",
      confirm: async () => true,
      quiet: true,
    });
    assert.match(system, /# Specialist roles/);
    assert.match(system, /debugger: Finds root causes/);
    assert.doesNotMatch(system, /PRIVATE_DEBUGGER_PERSONA/, "role body is loaded only after selection");
    assert.match(system, /minimum self-contained context/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    invalidateRolesCache();
  }
});

test("planner receives role responsibilities and drops manual or hallucinated role ids", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-role-plan-"));
  const roleDir = join(dir, ".hara", "roles");
  mkdirSync(join(dir, ".git"));
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(
    join(roleDir, "architect.md"),
    "---\nname: architect\ndescription: Designs system boundaries and migration plans\n---\nARCHITECT",
  );
  writeFileSync(
    join(roleDir, "manual.md"),
    "---\nname: manual\ndescription: Hidden manual role\ndisable-model-invocation: true\n---\nMANUAL",
  );
  let system = "";
  const provider = {
    id: "fake",
    model: "fake",
    async turn(args) {
      system = args.system;
      return {
        text: JSON.stringify({
          atoms: [
            { id: "a1", title: "design boundaries", deps: [], role: "architect" },
            { id: "a2", title: "manual task", deps: ["a1"], role: "manual" },
            { id: "a3", title: "unknown task", deps: ["a2"], role: "invented" },
          ],
        }),
        toolUses: [],
        stop: "end",
      };
    },
  };
  try {
    const plan = await decompose(provider, "modernize the service", loadRoles(dir));
    assert.match(system, /architect.*Designs system boundaries/);
    assert.doesNotMatch(system, /Hidden manual role/);
    assert.equal(plan.atoms[0].role, "architect");
    assert.equal(plan.atoms[1].role, undefined);
    assert.equal(plan.atoms[2].role, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
