import { createHash } from "node:crypto";
import { chmodSync, lstatSync, readdirSync, readFileSync, realpathSync, rmdirSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

import { ensurePrivateStateSubdirectory } from "../security/private-state.js";
import { redactToolSubprocessOutput, toolSubprocessEnv } from "../security/subprocess-env.js";

const MAX_GIT_OUTPUT = 3 * 1024 * 1024;
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_CHANGED_PATHS = 256;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMMIT = /^[0-9a-f]{40,64}$/u;
const WORKSPACE_ID = /^aw_[a-f0-9]{40}$/u;
const MAX_ATTRIBUTE_DIRECTORIES = 100_000;
const MAX_ATTRIBUTE_FILES = 1_024;

export interface AgentWorktreeBinding {
  baseCommit: string;
  /** Cwd corresponding to the source session's original repository-relative directory. */
  cwd: string;
  path: string;
  workspaceId: string;
}

export interface AgentWorktreeDiff {
  baseCommit: string;
  changedPaths: string[];
  ownerAgentId: string;
  patch: string;
  patchBytes: number;
  patchSha256: string;
  workspaceId: string;
}

export interface AgentWorktreeApplyResult extends Omit<AgentWorktreeDiff, "patch"> {
  applied: true;
  reconciled: boolean;
}

type GitResult = Readonly<{ status: number; stdout: Buffer; stderr: Buffer }>;

function safeGitError(stderr: Buffer, fallback: string): Error {
  const detail = redactToolSubprocessOutput(stderr.toString("utf8"))
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 600);
  return new Error(detail || fallback);
}

function git(
  cwd: string,
  args: readonly string[],
  options: Readonly<{ allowStatusOne?: boolean; input?: Buffer | string }> = {},
): GitResult {
  const result = spawnSync("git", [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false",
    "-c", "advice.detachedHead=false",
    ...args,
  ], {
    cwd,
    env: toolSubprocessEnv(process.env, {
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: undefined,
      GIT_CONFIG_KEY_0: undefined,
      GIT_CONFIG_VALUE_0: undefined,
      GIT_LITERAL_PATHSPECS: "1",
    }),
    input: options.input,
    maxBuffer: MAX_GIT_OUTPUT,
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error) throw safeGitError(Buffer.from(String(result.stderr ?? "")), result.error.message);
  const status = result.status ?? -1;
  if (status !== 0 && !(options.allowStatusOne && status === 1)) {
    throw safeGitError(Buffer.from(result.stderr ?? ""), `git ${args[0] ?? "command"} failed`);
  }
  return {
    status,
    stdout: Buffer.from(result.stdout ?? ""),
    stderr: Buffer.from(result.stderr ?? ""),
  };
}

function outputText(result: GitResult): string {
  return result.stdout.toString("utf8").trim();
}

function pathWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeRelativePath(value: string): boolean {
  return value.length > 0
    && Buffer.byteLength(value, "utf8") <= 4_096
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && !value.split(/[\\/]/u).some((part) => part === "" || part === "." || part === "..");
}

function nulStrings(buffer: Buffer): string[] {
  if (buffer.length === 0) return [];
  const values = buffer.toString("utf8").split("\0");
  if (values.at(-1) === "") values.pop();
  return values;
}

function trackedTreeEntries(result: GitResult): Map<string, string> {
  const entries = new Map<string, string>();
  for (const record of nulStrings(result.stdout)) {
    const tab = record.indexOf("\t");
    const metadata = tab >= 0 ? record.slice(0, tab) : "";
    const path = tab >= 0 ? record.slice(tab + 1) : "";
    const fields = metadata.split(" ");
    const objectId = fields[2] ?? "";
    if (!safeRelativePath(path) || !COMMIT.test(objectId)) {
      throw new Error("isolated writable Agents require safe tracked Git paths and object ids");
    }
    entries.set(path, objectId);
  }
  return entries;
}

/** A provider-neutral writable child boundary. Model/account choice remains owned by the normal provider
 * resolver; this class only materializes a Git-isolated filesystem and owns its exact patch. */
export class AgentWorktreeManager {
  readonly repositoryRoot: string;
  readonly sourceCwd: string;
  private readonly sourceRelativeCwd: string;
  private readonly managedRoot: string;

  constructor(
    sourceCwd: string,
    private readonly home: string,
    private readonly sessionId: string,
  ) {
    if (!sessionId || sessionId.length > 220 || /[\u0000\r\n]/u.test(sessionId)) {
      throw new Error("Agent worktree session id is invalid");
    }
    this.sourceCwd = realpathSync.native(resolve(sourceCwd));
    const root = outputText(git(this.sourceCwd, ["rev-parse", "--show-toplevel"]));
    if (!root) throw new Error("isolated writable Agents require a Git worktree");
    this.repositoryRoot = realpathSync.native(resolve(root));
    if (!pathWithin(this.repositoryRoot, this.sourceCwd)) {
      throw new Error("Agent source cwd is outside its Git repository");
    }
    this.sourceRelativeCwd = relative(this.repositoryRoot, this.sourceCwd);
    const sessionScope = "s_" + createHash("sha256")
      .update(this.repositoryRoot, "utf8")
      .update("\0", "utf8")
      .update(sessionId, "utf8")
      .digest("hex")
      .slice(0, 32);
    this.managedRoot = ensurePrivateStateSubdirectory(
      home,
      [".hara", "workspace", "agent-worktrees", sessionScope],
    ).path;
    if (pathWithin(this.repositoryRoot, this.managedRoot) || pathWithin(this.managedRoot, this.repositoryRoot)) {
      throw new Error("Agent worktree storage must be outside the source repository");
    }
  }

  private workspaceId(agentId: string): string {
    if (!UUID.test(agentId)) throw new Error("Agent worktree owner id is invalid");
    return "aw_" + createHash("sha256")
      .update(this.repositoryRoot, "utf8")
      .update("\0", "utf8")
      .update(this.sessionId, "utf8")
      .update("\0", "utf8")
      .update(agentId, "utf8")
      .digest("hex")
      .slice(0, 40);
  }

  private path(agentId: string): string {
    this.workspaceId(agentId);
    return resolve(this.managedRoot, agentId.toLowerCase());
  }

  private assertSafeRepository(): string {
    const bare = outputText(git(this.repositoryRoot, ["rev-parse", "--is-bare-repository"]));
    if (bare !== "false") throw new Error("isolated writable Agents require a non-bare Git repository");
    const baseCommit = outputText(git(this.repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"]));
    if (!COMMIT.test(baseCommit)) throw new Error("Git HEAD did not resolve to a commit");
    const tracked = trackedTreeEntries(git(this.repositoryRoot, ["ls-tree", "-r", "-z", baseCommit]));
    this.assertNoExecutableFilters(this.repositoryRoot, [...tracked.keys()], baseCommit);
    return baseCommit;
  }

  private configuredExecutableFilterDrivers(path: string): Set<string> {
    const configured = git(
      path,
      ["config", "--null", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"],
      { allowStatusOne: true },
    );
    const drivers = new Set<string>();
    if (configured.status === 1) return drivers;
    for (const record of nulStrings(configured.stdout)) {
      const newline = record.indexOf("\n");
      const key = newline >= 0 ? record.slice(0, newline) : record;
      const match = /^filter\.(.+)\.(?:clean|smudge|process)$/iu.exec(key);
      if (match?.[1]) drivers.add(match[1].toLowerCase());
    }
    return drivers;
  }

  private assertNoExecutableFilters(path: string, paths: readonly string[], source?: string): void {
    if (!paths.length) return;
    const drivers = this.configuredExecutableFilterDrivers(path);
    if (!drivers.size) return;
    const checked = git(path, [
      "check-attr",
      "-z",
      ...(source ? [`--source=${source}`] : ["--cached"]),
      "--stdin",
      "filter",
    ], { input: Buffer.from(`${paths.join("\0")}\0`, "utf8") });
    const values = nulStrings(checked.stdout);
    if (values.length % 3 !== 0) throw new Error("Git returned malformed content-filter attributes");
    for (let index = 2; index < values.length; index += 3) {
      const driver = values[index]!.toLowerCase();
      if (driver !== "unspecified" && driver !== "unset" && drivers.has(driver)) {
        throw new Error("isolated writable Agents are disabled for paths with executable Git clean/smudge/process filters");
      }
    }
  }

  private assertAttributesUnchanged(binding: AgentWorktreeBinding): void {
    const tracked = trackedTreeEntries(git(binding.path, ["ls-tree", "-r", "-z", binding.baseCommit]));
    const expected = new Map([...tracked].filter(([path]) => basename(path) === ".gitattributes"));
    const actual = new Map<string, string>();
    const queue = [binding.path];
    let visited = 0;
    while (queue.length) {
      const directory = queue.shift()!;
      visited += 1;
      if (visited > MAX_ATTRIBUTE_DIRECTORIES) {
        throw new Error("Agent worktree is too large to validate Git attributes safely");
      }
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === ".git") continue;
        const absolute = resolve(directory, entry.name);
        if (entry.isSymbolicLink()) {
          if (entry.name === ".gitattributes") throw new Error("Agent Diff may not link Git attribute files");
          continue;
        }
        if (entry.isDirectory()) {
          queue.push(absolute);
          continue;
        }
        if (entry.name !== ".gitattributes") continue;
        if (actual.size >= MAX_ATTRIBUTE_FILES) {
          throw new Error("Agent worktree contains too many Git attribute files");
        }
        const path = relative(binding.path, absolute);
        actual.set(path, outputText(git(binding.path, ["hash-object", "--no-filters", "--stdin"], {
          input: readFileSync(absolute),
        })));
      }
    }
    if (actual.size !== expected.size || [...expected].some(([path, objectId]) => actual.get(path) !== objectId)) {
      throw new Error("isolated Agents may not add, remove, or modify .gitattributes files");
    }
  }

  private validateExisting(
    agentId: string,
    expectedBaseCommit?: string,
    requireSourceCwd = true,
  ): AgentWorktreeBinding {
    const target = this.path(agentId);
    const info = lstatSync(target);
    if (!info.isDirectory() || info.isSymbolicLink() || realpathSync.native(target) !== target) {
      throw new Error("managed Agent worktree was replaced or linked");
    }
    const top = realpathSync.native(resolve(outputText(git(target, ["rev-parse", "--show-toplevel"]))));
    if (top !== target) throw new Error("managed Agent worktree identity changed");
    const baseCommit = outputText(git(target, ["rev-parse", "--verify", "HEAD^{commit}"]));
    if (!COMMIT.test(baseCommit) || (expectedBaseCommit && baseCommit !== expectedBaseCommit)) {
      throw new Error("managed Agent worktree base commit changed");
    }
    const listed = outputText(git(this.repositoryRoot, ["worktree", "list", "--porcelain"]));
    if (!listed.split(/\r?\n/u).includes(`worktree ${target}`)) {
      throw new Error("managed Agent directory is not registered to the source repository");
    }
    const cwd = resolve(target, this.sourceRelativeCwd);
    if (!pathWithin(target, cwd)) throw new Error("managed Agent cwd escaped its worktree");
    if (requireSourceCwd) {
      const cwdInfo = lstatSync(cwd);
      if (!cwdInfo.isDirectory() || cwdInfo.isSymbolicLink() || realpathSync.native(cwd) !== cwd) {
        throw new Error("the source session cwd is not a tracked directory in the managed Agent worktree");
      }
    }
    return { baseCommit, cwd, path: target, workspaceId: this.workspaceId(agentId) };
  }

  prepare(agentId: string, expectedBaseCommit?: string): AgentWorktreeBinding {
    if (expectedBaseCommit !== undefined && !COMMIT.test(expectedBaseCommit)) {
      throw new Error("Agent worktree base commit is invalid");
    }
    this.assertSafeRepository();
    const target = this.path(agentId);
    try {
      return this.validateExisting(agentId, expectedBaseCommit);
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    const baseCommit = expectedBaseCommit ?? this.assertSafeRepository();
    // Active configured filters were revalidated immediately before checkout. Git hooks are disabled independently
    // on the command line, so checkout cannot execute repository-controlled hooks or content-filter commands.
    git(this.repositoryRoot, ["worktree", "add", "--detach", target, baseCommit]);
    chmodSync(target, 0o700);
    return this.validateExisting(agentId, baseCommit);
  }

  private rejectUnsafeModes(path: string, changedPaths: readonly string[]): void {
    if (!changedPaths.length) return;
    const listings = [
      git(path, ["ls-tree", "-r", "-z", "HEAD", "--", ...changedPaths]),
      git(path, ["ls-files", "--stage", "-z", "--", ...changedPaths]),
    ];
    for (const result of listings) {
      for (const entry of nulStrings(result.stdout)) {
        const mode = entry.slice(0, entry.indexOf(" "));
        if (mode === "120000" || mode === "160000") {
          throw new Error("Agent Diff may not create/change symlinks or Git submodules");
        }
      }
    }
  }

  capture(agentId: string, expectedBaseCommit?: string): AgentWorktreeDiff {
    this.assertSafeRepository();
    const binding = this.validateExisting(agentId, expectedBaseCommit);
    this.assertAttributesUnchanged(binding);
    const candidatePaths = nulStrings(git(binding.path, [
      "ls-files", "-z", "--cached", "--others", "--exclude-standard",
    ]).stdout);
    if (candidatePaths.some((path) => !safeRelativePath(path))) {
      throw new Error("Agent worktree contains an unsafe Git path");
    }
    this.assertNoExecutableFilters(binding.path, candidatePaths);
    git(binding.path, ["add", "-A", "--"]);
    const names = nulStrings(git(binding.path, [
      "diff", "--cached", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "HEAD", "--",
    ]).stdout);
    if (names.length > MAX_CHANGED_PATHS || names.some((name) => !safeRelativePath(name))) {
      throw new Error(`Agent Diff exceeds the safe path limit (${MAX_CHANGED_PATHS}) or contains an unsafe path`);
    }
    this.rejectUnsafeModes(binding.path, names);
    const patch = git(binding.path, [
      "diff", "--cached", "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", "HEAD", "--",
    ]).stdout;
    if (patch.length > MAX_PATCH_BYTES) throw new Error("Agent Diff exceeds the 2 MiB review limit");
    return {
      baseCommit: binding.baseCommit,
      changedPaths: names,
      ownerAgentId: agentId,
      patch: patch.toString("utf8"),
      patchBytes: patch.length,
      patchSha256: createHash("sha256").update(patch).digest("hex"),
      workspaceId: binding.workspaceId,
    };
  }

  apply(agentId: string, expectedBaseCommit: string, expectedPatchSha256: string): AgentWorktreeApplyResult {
    if (!COMMIT.test(expectedBaseCommit) || !/^[a-f0-9]{64}$/u.test(expectedPatchSha256)) {
      throw new Error("Agent Diff ownership receipt is invalid");
    }
    const diff = this.capture(agentId, expectedBaseCommit);
    if (diff.patchSha256 !== expectedPatchSha256) {
      throw new Error("Agent Diff changed after review; inspect the new Diff before applying it");
    }
    if (!diff.changedPaths.length || diff.patchBytes === 0) throw new Error("Agent has no changes to apply");
    const sourceHead = outputText(git(this.repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"]));
    if (sourceHead !== expectedBaseCommit) {
      throw new Error("source HEAD changed after the Agent worktree was created; manual rebase/review is required");
    }
    const patch = Buffer.from(diff.patch, "utf8");
    try {
      git(this.repositoryRoot, ["apply", "--reverse", "--check", "--binary", "--whitespace=nowarn", "-"], { input: patch });
      return {
        applied: true,
        reconciled: true,
        baseCommit: diff.baseCommit,
        changedPaths: diff.changedPaths,
        ownerAgentId: diff.ownerAgentId,
        patchBytes: diff.patchBytes,
        patchSha256: diff.patchSha256,
        workspaceId: diff.workspaceId,
      };
    } catch {
      // Normal first application: the reverse check must fail because the source does not contain the Diff.
    }
    const overlap = git(this.repositoryRoot, [
      "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", ...diff.changedPaths,
    ]).stdout;
    if (overlap.length > 0) {
      throw new Error("source checkout has overlapping changes; Hara will not overwrite or auto-merge them");
    }
    git(this.repositoryRoot, ["apply", "--check", "--binary", "--whitespace=nowarn", "-"], { input: patch });
    git(this.repositoryRoot, ["apply", "--binary", "--whitespace=nowarn", "-"], { input: patch });
    return {
      applied: true,
      reconciled: false,
      baseCommit: diff.baseCommit,
      changedPaths: diff.changedPaths,
      ownerAgentId: diff.ownerAgentId,
      patchBytes: diff.patchBytes,
      patchSha256: diff.patchSha256,
      workspaceId: diff.workspaceId,
    };
  }

  assertWorkspaceId(agentId: string, value: string): void {
    if (!WORKSPACE_ID.test(value) || value !== this.workspaceId(agentId)) {
      throw new Error("Agent Diff belongs to another workspace");
    }
  }

  /** Permanently remove one Hara-owned worktree. The derived UUID path and optional ownership receipt are
   * revalidated before Git is allowed to delete anything; arbitrary filesystem paths are never accepted. */
  remove(agentId: string, expectedWorkspaceId?: string): boolean {
    if (expectedWorkspaceId !== undefined) this.assertWorkspaceId(agentId, expectedWorkspaceId);
    const target = this.path(agentId);
    try {
      this.validateExisting(agentId, undefined, false);
    } catch (error: any) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
    git(this.repositoryRoot, ["worktree", "remove", "--force", target]);
    try {
      lstatSync(target);
      throw new Error("Git did not remove the managed Agent worktree");
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    try {
      if (readdirSync(this.managedRoot).length === 0) rmdirSync(this.managedRoot);
    } catch (error: any) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTEMPTY") throw error;
    }
    return true;
  }
}
