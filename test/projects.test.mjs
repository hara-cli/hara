import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addProject,
  buildAgentsIndex,
  canonicalProjectName,
  canonicalProjectPath,
  loadProjects,
  removeProject,
  resolveAgent,
} from "../dist/org/projects.js";

function writeRole(dir, name, description, system, options = {}) {
  mkdirSync(dir, { recursive: true });
  const extra = [
    options.model ? `model: ${options.model}` : "",
    options.allowTools ? `allowTools: [${options.allowTools.join(", ")}]` : "",
    options.denyTools ? `denyTools: [${options.denyTools.join(", ")}]` : "",
    options.owns ? `owns: [${options.owns.join(", ")}]` : "",
  ].filter(Boolean).join("\n");
  writeFileSync(
    join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}${extra ? `\n${extra}` : ""}\n---\n${system}\n`,
    "utf8",
  );
}

function child(script, home) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, HOME: home },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`project child exited ${code}: ${stderr}`)));
  });
}

test("projects registry canonicalizes homes and indexes every material role override", () => {
  const root = mkdtempSync(join(tmpdir(), "hara-project-index-"));
  const home = join(root, "home");
  const alpha = join(root, "alpha");
  const alphaAlias = join(root, "alpha-alias");
  const beta = join(root, "beta");
  const notDirectory = join(root, "file.txt");
  const previousHome = process.env.HOME;

  try {
    process.env.HOME = home;
    mkdirSync(alpha, { recursive: true });
    mkdirSync(beta, { recursive: true });
    symlinkSync(alpha, alphaAlias);
    writeFileSync(notDirectory, "x");
    writeFileSync(join(alpha, "package.json"), "{}\n");
    writeFileSync(join(beta, "package.json"), "{}\n");
    const alphaReal = realpathSync(alpha);
    const betaReal = realpathSync(beta);

    writeRole(join(home, ".hara", "roles"), "shared", "global shared", "global shared persona");
    writeRole(join(home, ".hara", "roles"), "global-only", "global only", "global only persona");
    writeRole(join(home, ".hara", "roles"), "description-only", "global description", "identical persona");
    writeRole(join(home, ".hara", "roles"), "model-only", "same description", "identical persona", { model: "model-a" });
    writeRole(join(home, ".hara", "roles"), "tools-only", "same description", "identical persona", { allowTools: ["read_file"] });
    writeRole(join(alpha, ".hara", "roles"), "shared", "alpha override", "alpha shared persona");
    writeRole(join(alpha, ".hara", "roles"), "description-only", "alpha description", "identical persona");
    writeRole(join(alpha, ".hara", "roles"), "model-only", "same description", "identical persona", { model: "model-b" });
    writeRole(join(alpha, ".hara", "roles"), "tools-only", "same description", "identical persona", { allowTools: ["read_file", "bash"] });
    writeRole(join(alpha, ".hara", "roles"), "reviewer", "alpha reviewer", "alpha review persona");
    writeRole(join(beta, ".hara", "roles"), "reviewer", "beta reviewer", "beta review persona");

    assert.equal(canonicalProjectName(" Alpha "), "alpha");
    assert.equal(canonicalProjectName("bad:name"), null);
    assert.equal(canonicalProjectPath(alphaAlias, true), alphaReal);
    assert.match(addProject("missing", join(root, "does-not-exist")), /path does not exist/);
    assert.match(addProject("bad:name", alpha), /invalid project name/);
    assert.match(addProject("file", notDirectory), /not a directory/);
    assert.equal(addProject(" Alpha ", alphaAlias), null);
    assert.equal(addProject("beta", beta), null);
    assert.match(addProject("alpha-alias", alpha), /already registered as 'alpha'/);
    assert.deepEqual(loadProjects(), [
      { name: "alpha", path: alphaReal },
      { name: "beta", path: betaReal },
    ]);

    const index = buildAgentsIndex();
    assert.ok(index.some((entry) => entry.name === "global-only" && entry.home === "" && !entry.project));
    assert.equal(index.filter((entry) => entry.name === "global-only").length, 1, "fully inherited globals are not duplicated");
    for (const name of ["description-only", "model-only", "tools-only"]) {
      assert.equal(index.filter((entry) => entry.name === name).length, 2, `${name} project policy is a material override`);
      assert.ok(index.some((entry) => entry.name === name && entry.project === "alpha" && entry.home === alphaReal));
    }
    assert.ok(index.some((entry) => entry.name === "shared" && entry.home === ""));
    assert.ok(index.some((entry) => entry.name === "shared" && entry.project === "alpha" && entry.home === alphaReal));

    assert.deepEqual(resolveAgent("shared"), {
      name: "shared",
      description: "global shared",
      home: "",
    }, "a global role wins an unqualified collision");
    assert.deepEqual(resolveAgent("global:shared"), {
      name: "shared",
      description: "global shared",
      home: "",
    }, "the explicit global namespace resolves the same canonical role gateway sessions persist");
    assert.deepEqual(resolveAgent(" GLOBAL : shared "), {
      name: "shared",
      description: "global shared",
      home: "",
    }, "qualified namespaces are case/whitespace friendly");
    assert.deepEqual(resolveAgent("shared", alphaAlias), {
      name: "shared",
      description: "alpha override",
      home: alphaReal,
      project: "alpha",
    }, "a caller with a current home prefers that project's override before the global fallback");
    assert.deepEqual(resolveAgent("ALPHA:shared"), {
      name: "shared",
      description: "alpha override",
      home: alphaReal,
      project: "alpha",
    });
    assert.equal(resolveAgent("bad:name:extra"), null);
    assert.equal(resolveAgent("no-such-role"), null);

    const ambiguous = resolveAgent("reviewer");
    assert.ok(ambiguous && "ambiguous" in ambiguous);
    assert.deepEqual(ambiguous.ambiguous.map((entry) => entry.project).sort(), ["alpha", "beta"]);
    assert.equal(resolveAgent("reviewer", alphaAlias).project, "alpha", "the current home removes needless gateway ambiguity");
    assert.equal(resolveAgent("beta:reviewer").home, betaReal);

    const file = join(home, ".hara", "projects.json");
    assert.equal(statSync(join(home, ".hara")).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(join(home, ".hara")).filter((name) => name.includes(".tmp") || name.endsWith(".lock") || name.endsWith(".reclaim")), []);

    assert.equal(removeProject("BETA"), true);
    assert.equal(removeProject("beta"), false);
    assert.equal(resolveAgent("reviewer").home, alphaReal, "a formerly ambiguous bare role becomes unique");

    assert.equal(addProject("alpha", beta), null, "adding the same handle replaces its path");
    assert.deepEqual(loadProjects(), [{ name: "alpha", path: betaReal }]);
    assert.equal(removeProject("alpha"), true);
    assert.deepEqual(loadProjects(), []);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});

test("projects read-modify-write preserves concurrent registrations and fails closed on corruption", async () => {
  const root = mkdtempSync(join(tmpdir(), "hara-project-concurrent-"));
  const home = join(root, "home");
  const previousHome = process.env.HOME;
  const projects = Array.from({ length: 16 }, (_, i) => ({ name: `p-${i}`, path: join(root, `project-${i}`) }));
  for (const project of projects) mkdirSync(project.path, { recursive: true });

  try {
    process.env.HOME = home;
    await Promise.all(projects.map((project) => {
      const script = `import { addProject } from "./dist/org/projects.js"; const error = addProject(${JSON.stringify(project.name)}, ${JSON.stringify(project.path)}); if (error) throw new Error(error);`;
      return child(script, home);
    }));
    const stored = loadProjects();
    assert.equal(stored.length, projects.length);
    assert.deepEqual(stored.map((project) => project.name).sort(), projects.map((project) => project.name).sort());
    assert.equal(new Set(stored.map((project) => project.path)).size, projects.length);

    const dir = join(home, ".hara");
    const file = join(dir, "projects.json");
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".tmp") || name.endsWith(".lock") || name.endsWith(".reclaim")), []);

    writeFileSync(file, "{broken", "utf8");
    const before = readFileSync(file, "utf8");
    assert.match(addProject("later", projects[0].path), /projects registry:/);
    assert.equal(readFileSync(file, "utf8"), before, "a corrupt registry is not silently replaced with an empty list");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(root, { recursive: true, force: true });
  }
});
