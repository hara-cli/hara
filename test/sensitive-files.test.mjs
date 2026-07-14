import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getTool } from "../dist/tools/registry.js";
import { walkFiles, listProjectFiles } from "../dist/fs-walk.js";
import { expandMentions, fileCandidates } from "../dist/context/mentions.js";
import {
  existingSensitiveReadDirectories,
  existingSensitiveReadPaths,
  existingSensitiveSeatbeltMasks,
  isSensitiveFilePath,
  sensitiveFileReason,
  sensitiveShellCommandReason,
  sensitiveStructuredInputReason,
} from "../dist/security/sensitive-files.js";
import {
  createToolOutputLineRedactor,
  isSecretEnvironmentName,
  redactToolSubprocessOutput,
  toolSubprocessEnv,
} from "../dist/security/subprocess-env.js";
import {
  ensurePrivateHaraState,
  resetPrivateHaraStateForTests,
  tightenPrivateHaraState,
} from "../dist/security/private-state.js";
import { isReadOnlyCommand } from "../dist/security/permissions.js";
import { runShell, shellCommand } from "../dist/sandbox.js";
import { startJob } from "../dist/exec/jobs.js";
import "../dist/tools/builtin.js";
import "../dist/tools/search.js";
import "../dist/tools/edit.js";
import "../dist/tools/patch.js";

const SECRET = "opaque-boundary-value-729184";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "hara-sensitive-"));
  mkdirSync(join(dir, "nested"), { recursive: true });
  writeFileSync(join(dir, ".env"), `OPENAI_API_KEY=${SECRET}\n`);
  writeFileSync(join(dir, "nested", ".env.production"), `DATABASE_URL=${SECRET}\n`);
  writeFileSync(join(dir, ".env.example"), "OPENAI_API_KEY=replace-me\n");
  writeFileSync(join(dir, "credentials.json"), JSON.stringify({ token: SECRET }));
  writeFileSync(join(dir, "normal.txt"), "ordinary boundary text\n");
  if (process.platform !== "win32") symlinkSync(join(dir, ".env"), join(dir, "alias.txt"));
  return dir;
}

test("sensitive path policy denies real secret files and symlink aliases but permits templates", () => {
  const dir = fixture();
  try {
    assert.match(sensitiveFileReason(join(dir, ".env")), /environment/i);
    assert.match(sensitiveFileReason(join(dir, "nested", ".env.production")), /environment/i);
    assert.match(sensitiveFileReason(join(dir, "credentials.json")), /credential/i);
    assert.equal(isSensitiveFilePath(join(dir, ".env.example")), false);
    if (process.platform !== "win32") assert.match(sensitiveFileReason(join(dir, "alias.txt")), /environment/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sensitive path policy covers Hara control-plane state, NTFS aliases, and nested safe templates", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-private-policy-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    const state = join(home, ".hara");
    const protectedPaths = [
      "config.json",
      "config.json::$DATA",
      "qwen-oauth.json",
      "profiles.json",
      "serve.json",
      "desk.json",
      "desk-collector.json",
      "org.json",
      "org.json.legacy",
      "flows.json",
      "flows-pending.json",
      "flows-log.jsonl",
      "permissions.json",
      "permissions.json:alt",
      "sessions:stream/missing.json",
      "sessions/session.json",
      "checkpoints/project/git/objects/aa/blob",
      "index/project/chunks.json",
      "gateway/routes.json",
      "cron/jobs.json",
      "weixin/creds.json",
      "weixin/account.cursor",
      "weixin/account.context-tokens.json",
      "desk-enroll-key-test",
      "future-runtime-secret.json",
    ];
    for (const path of protectedPaths) {
      assert.match(sensitiveFileReason(join(state, path)) ?? "", /private Hara|credential/i, path);
    }

    assert.equal(sensitiveFileReason(join(home, "project", ".env::$DATA")), "environment file");
    assert.equal(sensitiveFileReason(join(home, "project", ".env:stream")), "environment file");
    assert.equal(sensitiveFileReason(join(home, "project", ".env. ")), "environment file");
    assert.match(sensitiveFileReason(join(home, "project", ".env", "child.txt")) ?? "", /environment file state/i);
    assert.equal(sensitiveFileReason(join(home, "project", ".env.local.example")), null);
    assert.equal(sensitiveFileReason(join(home, "project", ".env.production.sample::$DATA")), null);

    // Windows strips trailing dots/spaces and resolves ADS on every component, not only the basename.
    // Keep these lexical assertions platform-independent so a Linux/macOS CI run protects Windows builds.
    for (const [path, expected] of [
      [join(home, ".aws. ", "credentials::$DATA"), /credential/i],
      [join(home, ".docker.", "config.json:stream"), /Docker credential/i],
      [join(home, ".kube:metadata", "config. "), /Kubernetes credential/i],
      [join(home, ".ssh. ", "id_release:stream"), /SSH private key/i],
      [join(home, ".hara. ", "sessions. ", "run.json"), /private Hara/i],
      [join(home, "project", ".direnv. ", "secret"), /credential|direnv/i],
    ]) assert.match(sensitiveFileReason(path) ?? "", expected, path);
    assert.equal(sensitiveFileReason(join(home, ".ssh. ", "known_hosts. ")), null, "normalized public SSH metadata stays readable");
    assert.equal(sensitiveFileReason(join(home, ".docker-safe", "config.json")), null, "lookalike directories are not overblocked");
    assert.match(sensitiveFileReason(join(home, "project", ".hara", "permissions.json")) ?? "", /private Hara/i);
    assert.match(sensitiveFileReason(join(home, "project", ".hara. ", "sessions", "missing.json")) ?? "", /private Hara/i);

    // Explicit agent-authored surfaces remain usable even though the rest of ~/.hara defaults private.
    assert.equal(sensitiveFileReason(join(state, "workspace", "notes.md")), null);
    assert.equal(sensitiveFileReason(join(state, "skills", "review", "SKILL.md")), null);
    assert.equal(sensitiveFileReason(join(state, "weixin", "media", "incoming.png")), null);

    for (const path of [
      ".netrc",
      ".npmrc",
      ".pypirc",
      ".git-credentials",
      ".aws/credentials",
      ".aws/sso/cache/session.json",
      ".docker/config.json",
      ".kube/config",
      ".ssh/id_custom_deploy",
    ]) {
      assert.match(sensitiveFileReason(join(home, path)) ?? "", /credential|private key/i, path);
    }
    assert.equal(sensitiveFileReason(join(home, ".ssh", "id_custom_deploy.pub")), null, "public SSH keys stay readable");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("prospective writes reject a protected parent symlink with a multi-level missing tail", { skip: process.platform === "win32" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "hara-prospective-home-"));
  const project = mkdtempSync(join(tmpdir(), "hara-prospective-project-"));
  const previousHome = process.env.HOME;
  const previousAllow = process.env.HARA_ALLOW_SENSITIVE_FILES;
  process.env.HOME = home;
  delete process.env.HARA_ALLOW_SENSITIVE_FILES;
  try {
    const sessions = join(home, ".hara", "sessions");
    mkdirSync(sessions, { recursive: true });
    const alias = join(project, "innocent");
    symlinkSync(sessions, alias);
    const requested = join(alias, "missing", "deep", "note.txt");
    const actual = join(sessions, "missing", "deep", "note.txt");

    assert.match(sensitiveFileReason(requested) ?? "", /private Hara/i);
    for (const result of [
      await getTool("write_file").run({ path: requested, content: "blocked\n" }, { cwd: project }),
      await getTool("edit_file").run({ path: requested, old_string: "x", new_string: "y" }, { cwd: project }),
      await getTool("apply_patch").run({ changes: [{ path: requested, type: "create", content: "blocked\n" }] }, { cwd: project }),
    ]) assert.match(result, /Blocked:|private Hara/i);
    assert.equal(existsSync(actual), false, "no protected tail directory or file is created");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAllow === undefined) delete process.env.HARA_ALLOW_SENSITIVE_FILES;
    else process.env.HARA_ALLOW_SENSITIVE_FILES = previousAllow;
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("coding tools stay bound to the canonical parent when its symlink alias is retargeted before commit", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "hara-write-parent-retarget-"));
  const first = join(dir, "first");
  const second = join(dir, "second");
  const alias = join(dir, "alias");
  mkdirSync(first);
  mkdirSync(second);
  const pointAlias = (target) => {
    if (existsSync(alias)) unlinkSync(alias);
    symlinkSync(target, alias);
  };
  try {
    pointAlias("first");
    const write = getTool("write_file").run({ path: join(alias, "write.txt"), content: "written\n" }, { cwd: dir });
    pointAlias("second");
    assert.match(await write, /Wrote/);
    assert.equal(readFileSync(join(first, "write.txt"), "utf8"), "written\n");
    assert.equal(existsSync(join(second, "write.txt")), false);

    writeFileSync(join(first, "edit.txt"), "old\n");
    writeFileSync(join(second, "edit.txt"), "decoy\n");
    pointAlias("first");
    const edit = getTool("edit_file").run({ path: join(alias, "edit.txt"), old_string: "old", new_string: "new" }, { cwd: dir });
    pointAlias("second");
    assert.match(await edit, /Edited/);
    assert.equal(readFileSync(join(first, "edit.txt"), "utf8"), "new\n");
    assert.equal(readFileSync(join(second, "edit.txt"), "utf8"), "decoy\n");

    pointAlias("first");
    const patch = getTool("apply_patch").run(
      { changes: [{ path: join(alias, "patch.txt"), type: "create", content: "patched\n" }] },
      { cwd: dir },
    );
    pointAlias("second");
    assert.match(await patch, /created/);
    assert.equal(readFileSync(join(first, "patch.txt"), "utf8"), "patched\n");
    assert.equal(existsSync(join(second, "patch.txt")), false);
    assert.equal(readlinkSync(alias), "second");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hard-link aliases inherit protected inode identity and are included in every file boundary", { skip: process.platform === "win32" }, async () => {
  const dir = fixture();
  const aliasParent = mkdtempSync(join(tmpdir(), "hara-sensitive-root-alias-"));
  const alias = join(dir, "innocent-looking.txt");
  try {
    mkdirSync(join(dir, ".git"));
    linkSync(join(dir, ".env"), alias);
    assert.match(sensitiveFileReason(alias) ?? "", /hard link to protected/i);
    const mask = existingSensitiveReadPaths(join(dir, "nested"));
    assert.ok(mask.includes(join(dir, ".env")), "nested cwd still scans the project/ancestor root");
    assert.ok(mask.includes(alias), "Seatbelt masks every hard-link pathname, not only the .env name");

    for (const result of [
      await getTool("read_file").run({ path: alias }, { cwd: dir }),
      await getTool("write_file").run({ path: alias, content: "changed\n" }, { cwd: dir }),
      await getTool("edit_file").run({ path: alias, old_string: SECRET, new_string: "changed" }, { cwd: dir }),
      await getTool("apply_patch").run({ changes: [{ path: alias, type: "update", content: "changed\n" }] }, { cwd: dir }),
    ]) {
      assert.match(result, /Blocked:|hard link/i);
      assert.ok(!result.includes(SECRET));
    }
    assert.ok(readFileSync(join(dir, ".env"), "utf8").includes(SECRET));
    assert.ok(!walkFiles(dir).includes("innocent-looking.txt"));

    const safeLink = join(dir, "safe-link.txt");
    symlinkSync(join(dir, "normal.txt"), safeLink);
    assert.match(await getTool("read_file").run({ path: safeLink }, { cwd: dir }), /ordinary boundary text/);

    const linkedRoot = join(aliasParent, "linked-project");
    symlinkSync(dir, linkedRoot);
    const linkedMask = existingSensitiveReadPaths(linkedRoot);
    assert.ok(linkedMask.includes(join(linkedRoot, ".env")), "the lexical symlink-root path is masked");
    assert.ok(linkedMask.includes(realpathSync(join(dir, ".env"))), "the canonical project-root path is masked too");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(aliasParent, { recursive: true, force: true });
  }
});

test("private-state migration repairs legacy modes without following symlinks", { skip: process.platform === "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "hara-private-modes-"));
  const state = join(home, ".hara");
  const sessionDir = join(state, "sessions", "nested");
  const external = join(home, "outside.txt");
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(join(state, "workspace"), { recursive: true });
  writeFileSync(join(state, "config.json"), "{}\n");
  writeFileSync(join(sessionDir, "legacy.json"), "{}\n");
  writeFileSync(join(state, "workspace", "notes.md"), "notes\n");
  writeFileSync(external, "outside\n");
  symlinkSync(external, join(sessionDir, "outside-link"));
  for (const path of [state, join(state, "sessions"), sessionDir]) chmodSync(path, 0o777);
  for (const path of [join(state, "config.json"), join(sessionDir, "legacy.json"), external]) chmodSync(path, 0o666);
  chmodSync(join(state, "workspace", "notes.md"), 0o644);

  try {
    tightenPrivateHaraState(home);
    assert.equal(statSync(state).mode & 0o777, 0o700);
    assert.equal(statSync(join(state, "config.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(state, "sessions")).mode & 0o777, 0o700);
    assert.equal(statSync(sessionDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(sessionDir, "legacy.json")).mode & 0o777, 0o600);
    assert.equal(statSync(external).mode & 0o777, 0o666, "migration must not chmod a symlink target");
    assert.equal(statSync(join(state, "workspace", "notes.md")).mode & 0o777, 0o644, "agent-authored trees stay untouched");

    // The startup wrapper is process-once per injected home, but remains safe to call repeatedly.
    resetPrivateHaraStateForTests();
    chmodSync(join(state, "config.json"), 0o666);
    ensurePrivateHaraState(home);
    assert.equal(statSync(join(state, "config.json")).mode & 0o777, 0o600);
    chmodSync(join(state, "config.json"), 0o666);
    ensurePrivateHaraState(home);
    assert.equal(statSync(join(state, "config.json")).mode & 0o777, 0o666, "second startup call is intentionally cheap");
  } finally {
    resetPrivateHaraStateForTests();
    rmSync(home, { recursive: true, force: true });
  }
});

test("Seatbelt discovery fails closed on scan overflow and masks private state directories as subpaths", () => {
  const home = mkdtempSync(join(tmpdir(), "hara-sensitive-mask-home-"));
  const project = mkdtempSync(join(tmpdir(), "hara-sensitive-mask-project-"));
  const previousHome = process.env.HOME;
  const previousAllow = process.env.HARA_ALLOW_SENSITIVE_FILES;
  process.env.HOME = home;
  delete process.env.HARA_ALLOW_SENSITIVE_FILES;
  try {
    mkdirSync(join(project, "a"));
    mkdirSync(join(project, "b"));
    writeFileSync(join(project, "a", ".env"), "A=secret\n");
    writeFileSync(join(project, "b", ".env.production"), "B=secret\n");
    assert.throws(
      () => existingSensitiveReadPaths(project, 1),
      /protected-file scan exceeded 1 files/,
      "a truncated deny mask must abort instead of silently omitting a later secret",
    );

    const homeSessions = join(home, ".hara", "sessions");
    const homeCheckpoints = join(home, ".hara", "checkpoints");
    const projectIndex = join(project, ".hara", "index");
    const sshKey = join(home, ".ssh", "deploy-production");
    mkdirSync(homeSessions, { recursive: true });
    mkdirSync(homeCheckpoints, { recursive: true });
    mkdirSync(projectIndex, { recursive: true });
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(sshKey, "private-key-material\n");
    const directories = existingSensitiveReadDirectories(project);
    assert.ok(directories.includes(homeSessions));
    assert.ok(directories.includes(homeCheckpoints));
    assert.ok(directories.includes(projectIndex));
    const masks = existingSensitiveSeatbeltMasks(project);
    assert.ok(masks.writeContainers.includes(join(project, ".hara")), "renaming the project .hara container is denied");
    assert.ok(masks.files.includes(sshKey), "custom SSH key names are concretely masked");
    assert.ok(masks.writeContainers.includes(join(home, ".ssh")), "renaming .ssh cannot relocate a key outside the mask");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousAllow === undefined) delete process.env.HARA_ALLOW_SENSITIVE_FILES;
    else process.env.HARA_ALLOW_SENSITIVE_FILES = previousAllow;
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});

test("file, edit, patch, mention, completion, glob, and ls boundaries fail closed", async () => {
  const dir = fixture();
  try {
    const read = await getTool("read_file").run({ path: ".env" }, { cwd: dir });
    assert.match(read, /Blocked: refusing to read protected environment file/);
    assert.ok(!read.includes(SECRET));

    const alias = process.platform === "win32" ? "(skipped)" : await getTool("read_file").run({ path: "alias.txt" }, { cwd: dir });
    if (process.platform !== "win32") assert.match(alias, /Blocked:/);

    const template = await getTool("read_file").run({ path: ".env.example" }, { cwd: dir });
    assert.match(template, /replace-me/);

    const write = await getTool("write_file").run({ path: ".env", content: "OPENAI_API_KEY=changed\n" }, { cwd: dir });
    assert.match(write, /Blocked:/);
    const edit = await getTool("edit_file").run({ path: ".env", old_string: SECRET, new_string: "changed" }, { cwd: dir });
    assert.match(edit, /Blocked:/);
    const patch = await getTool("apply_patch").run({ changes: [{ path: ".env", type: "update", content: "changed\n" }] }, { cwd: dir });
    assert.match(patch, /Blocked:/);
    assert.ok(readFileSync(join(dir, ".env"), "utf8").includes(SECRET));

    const mention = expandMentions("inspect @.env now", dir);
    assert.match(mention, /Protected file/);
    assert.ok(!mention.includes(SECRET));
    assert.match(expandMentions("inspect @.env.example", dir), /replace-me/);

    const walked = walkFiles(dir);
    assert.ok(!walked.includes(".env"));
    assert.ok(!walked.includes("nested/.env.production"));
    assert.ok(!walked.includes("credentials.json"));
    assert.ok(walked.includes(".env.example"));
    assert.ok(!listProjectFiles(dir).includes(".env"));
    assert.ok(!fileCandidates(dir, "env").some((path) => path === ".env" || path.includes(".env.production")));

    const glob = await getTool("glob").run({ pattern: "**/*" }, { cwd: dir });
    assert.ok(!glob.includes(".env.production"));
    assert.ok(!glob.includes("credentials.json"));
    const ls = await getTool("ls").run({}, { cwd: dir });
    assert.ok(!ls.includes("credentials.json"));
    assert.match(ls, /protected file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ripgrep and dependency-free fallback never return protected content", async () => {
  const dir = fixture();
  const oldPath = process.env.PATH;
  try {
    const pattern = "OPENAI_API_KEY|DATABASE_URL|opaque-boundary";
    const normal = await getTool("grep").run({ pattern }, { cwd: dir });
    assert.match(normal, /No matches/);
    assert.ok(!normal.includes(SECRET));
    const direct = await getTool("grep").run({ pattern, path: ".env" }, { cwd: dir });
    assert.match(direct, /Blocked:/);

    process.env.PATH = "";
    const fallback = await getTool("grep").run({ pattern }, { cwd: dir });
    assert.ok(!fallback.includes(SECRET));
    assert.ok(!fallback.includes(".env.production"));
    assert.ok(!fallback.includes("credentials.json"));
    assert.ok(/No matches|\.env\.example/.test(fallback), "only an explicitly safe template may match");
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shell boundary blocks secret paths/environment dumps and scrubs inherited secret env", async () => {
  const dir = fixture();
  const oldSecret = process.env.HARA_BOUNDARY_TOKEN;
  const oldAllow = process.env.HARA_SUBPROCESS_ENV_ALLOW;
  const oldSensitiveAllow = process.env.HARA_ALLOW_SENSITIVE_FILES;
  try {
    process.env.HARA_BOUNDARY_TOKEN = SECRET;
    delete process.env.HARA_SUBPROCESS_ENV_ALLOW;

    assert.match(sensitiveShellCommandReason("cat .env", dir), /environment file/);
    assert.match(sensitiveShellCommandReason("env | sort", dir), /exposes the process environment/);
    assert.match(sensitiveShellCommandReason("printenv PATH", dir), /exposes the process environment/);
    assert.match(sensitiveShellCommandReason("command printenv PATH", dir), /exposes the process environment/);
    assert.match(sensitiveShellCommandReason("nohup env", dir), /exposes the process environment/);
    assert.match(sensitiveShellCommandReason("env FOO=ok printenv PATH", dir), /exposes the process environment/);
    assert.match(sensitiveShellCommandReason("export", dir), /exposes the process environment/);
    assert.match(sensitiveShellCommandReason("builtin export -p", dir), /exposes the process environment/);
    assert.match(sensitiveShellCommandReason("typeset -x", dir), /exported shell variables/);
    assert.match(sensitiveShellCommandReason("command declare -rx", dir), /exported shell variables/);
    for (const command of ["ps e", "ps eww", "ps auxe", "ps -E", "command ps -AE"]) {
      assert.match(sensitiveShellCommandReason(command, dir), /process environments/, command);
      assert.equal(isReadOnlyCommand(command), false, `${command} must not inherit readonly auto-approval`);
    }
    assert.equal(sensitiveShellCommandReason("ps -e", dir), null, "POSIX -e selects processes; it does not print environments");
    assert.equal(isReadOnlyCommand("ps -e"), true);
    assert.equal(sensitiveShellCommandReason("export SAFE_NAME=value", dir), null);
    assert.match(sensitiveShellCommandReason("git show HEAD:.env", dir), /revision path/);
    assert.equal(sensitiveShellCommandReason("env FOO=ok node --version", dir), null);
    assert.equal(isReadOnlyCommand("env"), false);
    assert.equal(isReadOnlyCommand("echo $HARA_BOUNDARY_TOKEN"), false);

    const cat = await getTool("bash").run({ command: "cat .env" }, { cwd: dir, sandbox: "off" });
    assert.match(cat, /Blocked:/);
    const envDump = await getTool("bash").run({ command: "env" }, { cwd: dir, sandbox: "off" });
    assert.match(envDump, /Blocked:/);

    const scrubbed = toolSubprocessEnv();
    assert.equal(scrubbed.HARA_BOUNDARY_TOKEN, undefined);
    assert.equal(isSecretEnvironmentName("HARA_BOUNDARY_TOKEN"), true);
    for (const name of [
      "GIT_ASKPASS",
      "SSH_ASKPASS",
      "SUDO_ASKPASS",
      "GIT_SSH_COMMAND",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_EXEC_PATH",
      "LESSOPEN",
      "KUBECONFIG",
      "DOCKER_CONFIG",
      "AWS_SHARED_CREDENTIALS_FILE",
      "NPM_CONFIG_USERCONFIG",
    ]) assert.equal(isSecretEnvironmentName(name), true, `${name} is an executable/config injection surface`);
    const injected = toolSubprocessEnv({
      PATH: "/safe",
      git_askpass: "/tmp/evil",
      Git_Config_Count: "1",
      LESSOPEN: "|/tmp/evil %s",
      HARA_SUBPROCESS_ENV_ALLOW: "git_askpass",
    });
    assert.equal(injected.git_askpass, "/tmp/evil", "allow names are case-insensitive like Windows env names");
    assert.equal(injected.Git_Config_Count, undefined);
    assert.equal(injected.LESSOPEN, undefined);
    // This assertion is about child environment scrubbing, not Seatbelt. Bypass the macOS read profile so
    // the test also runs inside CI/agent sandboxes that forbid nesting another sandbox-exec instance.
    process.env.HARA_ALLOW_SENSITIVE_FILES = "1";
    const child = await getTool("bash").run(
      { command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write(process.env.HARA_BOUNDARY_TOKEN || "missing")'` },
      { cwd: dir, sandbox: "off" },
    );
    assert.equal(child, "missing");

    process.env.HARA_SUBPROCESS_ENV_ALLOW = "HARA_BOUNDARY_TOKEN";
    const explicitlyPassed = await getTool("bash").run(
      { command: `${JSON.stringify(process.execPath)} -e 'process.stdout.write(process.env.HARA_BOUNDARY_TOKEN || "missing")'` },
      { cwd: dir, sandbox: "off" },
    );
    assert.equal(explicitlyPassed, "***", "explicit child grant does not make tool output expose the value");
    assert.equal(redactToolSubprocessOutput(`value=${SECRET}`), "value=***");
  } finally {
    if (oldSecret === undefined) delete process.env.HARA_BOUNDARY_TOKEN;
    else process.env.HARA_BOUNDARY_TOKEN = oldSecret;
    if (oldAllow === undefined) delete process.env.HARA_SUBPROCESS_ENV_ALLOW;
    else process.env.HARA_SUBPROCESS_ENV_ALLOW = oldAllow;
    if (oldSensitiveAllow === undefined) delete process.env.HARA_ALLOW_SENSITIVE_FILES;
    else process.env.HARA_ALLOW_SENSITIVE_FILES = oldSensitiveAllow;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runShell applies the protected-file preflight for every shell entry point", () => {
  const dir = fixture();
  try {
    assert.throws(
      () => runShell("cat .env", dir, "off", { timeout: 5000, maxBuffer: 64_000 }),
      /protected secret boundary.*environment file/i,
    );
    assert.throws(() => startJob("cat .env", dir, "off"), /protected secret boundary.*environment file/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("canonical Home rejects executable tools before recursive mask discovery; child projects retain secret masks", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-shell-home-boundary-"));
  const home = join(root, "home");
  const alias = join(root, "home-alias");
  const project = join(home, "project");
  mkdirSync(project, { recursive: true });
  symlinkSync(home, alias, process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(project, ".env"), `API_KEY=${SECRET}\n`);
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    assert.throws(() => shellCommand("printf safe", alias, "off"), /Refusing.*home directory.*cd \/path\/to\/project/i);
    assert.match(
      await getTool("bash").run({ command: "printf safe" }, { cwd: home, sandbox: "off" }),
      /Refusing.*home directory.*cd \/path\/to\/project/i,
      "the shared exec-tool boundary rejects before bash can inspect Home",
    );
    assert.doesNotThrow(() => shellCommand("printf safe", project, "off"), "an explicit child project remains executable");
    assert.throws(
      () => shellCommand("cat .env", project, "off"),
      /protected secret boundary.*environment file/i,
      "moving into a child project does not weaken protected-file masks",
    );
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    rmSync(root, { recursive: true, force: true });
  }
});

test("structured extension inputs reject protected path fields but not ordinary text", () => {
  const dir = fixture();
  try {
    assert.match(sensitiveStructuredInputReason({ path: ".env" }, dir) ?? "", /environment file/i);
    assert.match(sensitiveStructuredInputReason({ options: { fileUri: `file://${join(dir, ".env")}` } }, dir) ?? "", /environment file/i);
    assert.match(sensitiveStructuredInputReason({ roots: [{ location: join(dir, "credentials.json") }] }, dir) ?? "", /credential/i);
    assert.equal(sensitiveStructuredInputReason({ text: "please discuss .env without opening it" }, dir), null);
    assert.equal(sensitiveStructuredInputReason({ path: ".env.local.example" }, dir), null);
    let nested = { path: "normal.txt" };
    for (let i = 0; i < 10; i++) nested = { child: nested };
    assert.match(sensitiveStructuredInputReason(nested, dir) ?? "", /inspection depth/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("streaming subprocess redaction holds partial lines so secrets cannot cross chunk boundaries", () => {
  const emitted = [];
  const source = { HARA_BOUNDARY_TOKEN: SECRET };
  const redactor = createToolOutputLineRedactor((line) => emitted.push(line), source);
  const splitAt = Math.floor(SECRET.length / 2);
  redactor.push(`prefix=${SECRET.slice(0, splitAt)}`);
  assert.deepEqual(emitted, [], "an incomplete line must not be exposed");
  redactor.push(`${SECRET.slice(splitAt)} suffix\nordinary`);
  assert.deepEqual(emitted, ["prefix=*** suffix\n"]);
  redactor.flush();
  assert.deepEqual(emitted, ["prefix=*** suffix\n", "ordinary"]);
  assert.ok(!emitted.join("").includes(SECRET));
});

test("streaming subprocess redaction drops an overlong no-newline record with bounded memory", () => {
  const emitted = [];
  const redactor = createToolOutputLineRedactor((line) => emitted.push(line), {}, {}, 1024);
  redactor.push("x".repeat(800));
  redactor.push("y".repeat(800));
  redactor.push("still-dropped");
  redactor.push("\nnext\n");
  redactor.flush();
  assert.deepEqual(emitted, ["[output line omitted — exceeded 1024 characters]\n", "next\n"]);
  assert.ok(!emitted.join("").includes("still-dropped"));
});

test("macOS Seatbelt retains deny-read even when ordinary shell sandbox mode is off", { skip: process.platform !== "darwin" }, async (t) => {
  const dir = fixture();
  try {
    const dynamic = 'suffix=env; name=".$suffix"; cat "$name"';
    const planned = shellCommand(dynamic, dir, "off");
    assert.equal(planned.cmd, "sandbox-exec");
    assert.equal(planned.args[0], "-p");
    assert.match(planned.args[1], /deny file-read/);
    assert.match(planned.args[1], /deny file-write/);
    assert.ok(planned.args[1].includes(join(dir, ".env")), "profile masks the concrete protected file");

    try {
      const safe = await runShell("cat .env.example", dir, "off", { timeout: 5000, maxBuffer: 64_000 });
      assert.match(safe.stdout, /replace-me/);
    } catch (error) {
      if (/sandbox_apply: Operation not permitted/i.test(String(error?.stderr ?? error))) {
        t.skip("the outer test sandbox does not permit nested sandbox-exec; generated deny profile was verified");
        return;
      }
      throw error;
    }
    await assert.rejects(
      runShell(dynamic, dir, "off", { timeout: 5000, maxBuffer: 64_000 }),
      /exit code|Operation not permitted|denied/i,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("launch-time opt-in is explicit and restores direct access only for that process", async () => {
  const dir = fixture();
  const old = process.env.HARA_ALLOW_SENSITIVE_FILES;
  try {
    process.env.HARA_ALLOW_SENSITIVE_FILES = "1";
    const read = await getTool("read_file").run({ path: ".env" }, { cwd: dir });
    assert.ok(read.includes(SECRET));
  } finally {
    if (old === undefined) delete process.env.HARA_ALLOW_SENSITIVE_FILES;
    else process.env.HARA_ALLOW_SENSITIVE_FILES = old;
    rmSync(dir, { recursive: true, force: true });
  }
});
