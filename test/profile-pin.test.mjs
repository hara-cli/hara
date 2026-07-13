// Profile resolution chain + .hara-profile project pin.
//   1. --profile flag (setFlagOverride)
//   2. HARA_PROFILE env
//   3. .hara-profile pin (walk up cwd → home/root)
//   4. profiles.json `active`
//   5. "personal" fallback
//
// Each test re-redirects $HOME to a fresh tmpdir + seeds a minimal profiles.json so we never
// touch the real ~/.hara. Pin walks stop at $HOME (we set HOME to a tmpdir parent and write
// the pin inside a child) — that's the supported real-world placement.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalTrustProjectConfig = process.env.HARA_TRUST_PROJECT_CONFIG;
delete process.env.HARA_TRUST_PROJECT_CONFIG;
const {
  listProfiles,
  activeId,
  resolveActive,
  setFlagOverride,
  findPinnedProfile,
  writePin,
  removePin,
  removeProfile,
  useProfile,
} = await import("../dist/profile/profile.js");
after(() => {
  if (originalTrustProjectConfig === undefined) delete process.env.HARA_TRUST_PROJECT_CONFIG;
  else process.env.HARA_TRUST_PROJECT_CONFIG = originalTrustProjectConfig;
});

/** Seed $HOME with a profiles.json carrying personal + two orgs. Returns the home path. */
function seedHome() {
  const home = mkdtempSync(join(tmpdir(), "hara-profile-"));
  mkdirSync(join(home, ".hara"), { recursive: true });
  const profiles = {
    active: "personal",
    profiles: [
      { id: "personal", kind: "byok", label: "Personal", provider: "anthropic" },
      { id: "org-x", kind: "gateway", label: "Org X", gatewayUrl: "https://gw-x.example/", deviceId: "dev-x", deviceToken: "tok-x", defaultModel: "glm-5", availableModels: ["glm-5"], enrolledAt: "2026-01-01" },
      { id: "org-y", kind: "gateway", label: "Org Y", gatewayUrl: "https://gw-y.example/", deviceId: "dev-y", deviceToken: "tok-y", defaultModel: "claude-4-opus", availableModels: ["claude-4-opus"], enrolledAt: "2026-01-02" },
    ],
  };
  writeFileSync(join(home, ".hara", "profiles.json"), JSON.stringify(profiles, null, 2) + "\n", { mode: 0o600 });
  return home;
}

function withHome(fn) {
  const prevHome = process.env.HOME;
  const prevEnv = process.env.HARA_PROFILE;
  const prevCwd = process.cwd();
  const home = seedHome();
  process.env.HOME = home;
  delete process.env.HARA_PROFILE;
  setFlagOverride(null);
  try {
    return fn(home);
  } finally {
    process.chdir(prevCwd);
    setFlagOverride(null);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevEnv === undefined) delete process.env.HARA_PROFILE;
    else process.env.HARA_PROFILE = prevEnv;
    rmSync(home, { recursive: true, force: true });
  }
}

async function withHomeAsync(fn) {
  const prevHome = process.env.HOME;
  const prevEnv = process.env.HARA_PROFILE;
  const prevCwd = process.cwd();
  const home = seedHome();
  process.env.HOME = home;
  delete process.env.HARA_PROFILE;
  setFlagOverride(null);
  try {
    return await fn(home);
  } finally {
    process.chdir(prevCwd);
    setFlagOverride(null);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevEnv === undefined) delete process.env.HARA_PROFILE;
    else process.env.HARA_PROFILE = prevEnv;
    rmSync(home, { recursive: true, force: true });
  }
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
}

test("resolveActive: defaults to profiles.json `active` (source=default)", () => {
  withHome((home) => {
    process.chdir(home); // anywhere under home — no pin file there
    const r = resolveActive();
    assert.equal(r.id, "personal");
    assert.equal(r.source, "default");
    assert.equal(activeId(), "personal");
  });
});

test("resolveActive: HARA_PROFILE env overrides default (source=env)", () => {
  withHome((home) => {
    process.chdir(home);
    process.env.HARA_PROFILE = "org-y";
    const r = resolveActive();
    assert.equal(r.id, "org-y");
    assert.equal(r.source, "env");
  });
});

test("resolveActive: --profile flag beats env (source=flag)", () => {
  withHome((home) => {
    process.chdir(home);
    process.env.HARA_PROFILE = "org-y";
    setFlagOverride("org-x");
    const r = resolveActive();
    assert.equal(r.id, "org-x");
    assert.equal(r.source, "flag");
  });
});

test("findPinnedProfile: reads first line, trims, returns absolute file path", () => {
  withHome((home) => {
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, ".hara-profile"), "org-x\n", "utf8");
    const p = findPinnedProfile(work);
    assert.ok(p, "pin found");
    assert.equal(p.id, "org-x");
    assert.equal(p.file, join(realpathSync.native(work), ".hara-profile"));
  });
});

test("findPinnedProfile: walks up the directory tree until it finds a pin", () => {
  withHome((home) => {
    const proj = join(home, "proj");
    const deep = join(proj, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(proj, ".hara-profile"), "org-y", "utf8");
    const p = findPinnedProfile(deep);
    assert.ok(p);
    assert.equal(p.id, "org-y");
    assert.equal(p.file, join(realpathSync.native(proj), ".hara-profile"));
  });
});

test("findPinnedProfile: stops at $HOME (does NOT escape into the parent dir)", () => {
  // Use a custom $HOME inside a fake "above-home" pin dir so we can prove the walk
  // terminates at $HOME without polluting the real /tmp.
  const sandbox = mkdtempSync(join(tmpdir(), "hara-pin-walk-"));
  const fakeAbove = join(sandbox, "above");
  const fakeHome = join(sandbox, "above", "home");
  const deep = join(fakeHome, "deep", "nested");
  mkdirSync(deep, { recursive: true });
  mkdirSync(join(fakeHome, ".hara"), { recursive: true });
  writeFileSync(join(fakeHome, ".hara", "profiles.json"), JSON.stringify({
    active: "personal",
    profiles: [{ id: "personal", kind: "byok", label: "Personal", provider: "anthropic" }],
  }) + "\n");
  // A pin file ABOVE $HOME (in the sandbox parent) — must be ignored.
  writeFileSync(join(fakeAbove, ".hara-profile"), "personal\n", "utf8");

  const prev = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const p = findPinnedProfile(deep);
    assert.equal(p, null, "pin above $HOME is ignored");
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("findPinnedProfile: unknown id → returns null (non-fatal; falls through)", () => {
  withHome((home) => {
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, ".hara-profile"), "ghost-org\n", "utf8");
    let warning = "";
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => { warning += String(chunk); return true; };
    try {
      assert.equal(findPinnedProfile(work), null);
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.doesNotMatch(warning, /ghost-org/, "an invalid pin's raw first line is never echoed");
  });
});

test("findPinnedProfile: symlink/hardlink pins cannot read .env or select an identity", () => {
  withHome((home) => {
    const work = join(home, "sk-PATH_SECRET_MUST_NOT_LEAK_123456789");
    mkdirSync(work, { recursive: true });
    const secret = join(work, ".env");
    const original = "org-x\nPIN_SECRET_MUST_NOT_LEAK\n";
    writeFileSync(secret, original);
    const pin = join(work, ".hara-profile");

    let warning = "";
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => { warning += String(chunk); return true; };
    try {
      symlinkSync(secret, pin);
      assert.equal(findPinnedProfile(work), null, "final symlink is rejected even when its first line is a real profile");
      unlinkSync(pin);
      linkSync(secret, pin);
      assert.equal(findPinnedProfile(work), null, "hard-link aliases are rejected");
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.equal(readFileSync(secret, "utf8"), original);
    assert.doesNotMatch(warning, /org-x|PIN_SECRET_MUST_NOT_LEAK|PATH_SECRET_MUST_NOT_LEAK/, "warnings contain no pin contents or untrusted path components");
  });
});

test("findPinnedProfile: oversized pin fails closed without echoing its contents", () => {
  withHome((home) => {
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    writeFileSync(join(work, ".hara-profile"), "OVERSIZED_SECRET_" + "x".repeat(5000));
    let warning = "";
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk) => { warning += String(chunk); return true; };
    try {
      assert.equal(findPinnedProfile(work), null);
    } finally {
      process.stderr.write = originalWrite;
    }
    assert.doesNotMatch(warning, /OVERSIZED_SECRET/);
  });
});

test("findPinnedProfile: a Git-tracked repository pin is ignored by default without echoing its identity", () => {
  withHome((home) => {
    const work = join(home, "tracked-project");
    mkdirSync(work);
    git(["init", "-q"], work);
    writeFileSync(join(work, ".hara-profile"), "org-x\n");
    git(["add", "--", ".hara-profile"], work);

    let warning = "";
    const originalWrite = process.stderr.write;
    const previousTrust = process.env.HARA_TRUST_PROJECT_CONFIG;
    process.stderr.write = (chunk) => { warning += String(chunk); return true; };
    process.env.HARA_TRUST_PROJECT_CONFIG = "1"; // too late: module-level startup snapshot is already false
    try {
      assert.equal(findPinnedProfile(work), null);
    } finally {
      process.stderr.write = originalWrite;
      if (previousTrust === undefined) delete process.env.HARA_TRUST_PROJECT_CONFIG;
      else process.env.HARA_TRUST_PROJECT_CONFIG = previousTrust;
    }
    assert.match(warning, /tracked by Git|HARA_TRUST_PROJECT_CONFIG/);
    assert.doesNotMatch(warning, /org-x|tracked-project/);
  });
});

test("findPinnedProfile: Git lookup failure is fail-closed inside a worktree", () => {
  withHome((home) => {
    const work = join(home, "git-unavailable-project");
    const emptyPath = join(home, "empty-path");
    mkdirSync(work);
    mkdirSync(emptyPath);
    git(["init", "-q"], work);
    writeFileSync(join(work, ".hara-profile"), "org-y\n");
    git(["add", "--", ".hara-profile"], work);

    const originalPath = process.env.PATH;
    let warning = "";
    const originalWrite = process.stderr.write;
    process.env.PATH = emptyPath;
    process.stderr.write = (chunk) => { warning += String(chunk); return true; };
    try {
      assert.equal(findPinnedProfile(work), null);
    } finally {
      process.stderr.write = originalWrite;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
    assert.match(warning, /could not be verified/);
    assert.doesNotMatch(warning, /org-y|git-unavailable-project/);
  });
});

test("findPinnedProfile: an untracked local pin created in a Git worktree remains usable", async () => {
  await withHomeAsync(async (home) => {
    const work = join(home, "local-project");
    mkdirSync(work);
    git(["init", "-q"], work);
    await writePin(work, "org-y");
    const pin = findPinnedProfile(work);
    assert.equal(pin?.id, "org-y");
  });
});

test("findPinnedProfile: launch-time trust explicitly enables a reviewed tracked pin", () => {
  withHome((home) => {
    const work = join(home, "trusted-project");
    mkdirSync(work);
    git(["init", "-q"], work);
    writeFileSync(join(work, ".hara-profile"), "org-x\n");
    git(["add", "--", ".hara-profile"], work);
    const moduleUrl = new URL("../dist/profile/profile.js", import.meta.url).href;
    const script = `
      const { findPinnedProfile } = await import(${JSON.stringify(moduleUrl)});
      process.stdout.write(JSON.stringify(findPinnedProfile(${JSON.stringify(work)})));
    `;
    const childEnv = {
      ...process.env,
      HOME: home,
      HARA_TRUST_PROJECT_CONFIG: "1",
    };
    delete childEnv.HARA_PROFILE;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: work,
      env: childEnv,
      encoding: "utf8",
    });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).id, "org-x");
    assert.doesNotMatch(child.stderr, /org-x/);
  });
});

test("resolveActive priority chain: flag > env > pin > default > fallback", () => {
  withHome((home) => {
    const work = join(home, "work");
    mkdirSync(work, { recursive: true });
    process.chdir(work);

    // (4) default
    {
      const r = resolveActive();
      assert.equal(r.id, "personal");
      assert.equal(r.source, "default");
    }

    // (3) pin overrides default
    writeFileSync(join(work, ".hara-profile"), "org-x\n", "utf8");
    {
      const r = resolveActive();
      assert.equal(r.id, "org-x");
      assert.equal(r.source, "pin");
      // resolveActive uses process.cwd() (which canonicalizes /var→/private/var on macOS),
      // so compare against the canonical form rather than the pre-chdir `work` literal.
      assert.equal(r.pinFile, join(process.cwd(), ".hara-profile"));
    }

    // (2) env overrides pin
    process.env.HARA_PROFILE = "org-y";
    {
      const r = resolveActive();
      assert.equal(r.id, "org-y");
      assert.equal(r.source, "env");
    }

    // (1) flag overrides env
    setFlagOverride("personal");
    {
      const r = resolveActive();
      assert.equal(r.id, "personal");
      assert.equal(r.source, "flag");
    }
  });
});

test("writePin / removePin: round trip", async () => {
  await withHomeAsync(async (home) => {
    const work = join(home, "proj");
    mkdirSync(work, { recursive: true });
    const { file } = await writePin(work, "org-x");
    assert.equal(file, join(realpathSync.native(work), ".hara-profile"));
    assert.ok(existsSync(file));
    // resolveActive should pick it up.
    process.chdir(work);
    assert.equal(resolveActive().source, "pin");
    assert.equal(resolveActive().id, "org-x");
    // unpin
    assert.equal(removePin(work), true);
    assert.equal(existsSync(file), false);
    assert.equal(removePin(work), false, "double-unpin is a no-op");
    assert.equal(resolveActive().source, "default");
  });
});

test("writePin/removePin: symlink and hard-link aliases are refused and targets are preserved", async () => {
  await withHomeAsync(async (home) => {
    const work = join(home, "proj");
    mkdirSync(work, { recursive: true });
    const pin = join(work, ".hara-profile");
    const secret = join(work, ".env");
    const original = "PROFILE_TARGET_SECRET=preserve-me\n";
    writeFileSync(secret, original);

    symlinkSync(secret, pin);
    await assert.rejects(writePin(work, "org-x"), /unsafe profile pin/i);
    assert.equal(removePin(work), false, "unpin also refuses an untrusted symlink entry");
    assert.equal(readFileSync(secret, "utf8"), original);

    unlinkSync(pin);
    linkSync(secret, pin);
    await assert.rejects(writePin(work, "org-x"), /unsafe profile pin/i);
    assert.equal(removePin(work), false, "unpin refuses a hard-linked entry");
    assert.equal(readFileSync(secret, "utf8"), original);
  });
});

test("writePin: CAS refuses a concurrent target replacement and preserves the newer entry", async () => {
  await withHomeAsync(async (home) => {
    const work = join(home, "proj");
    mkdirSync(work, { recursive: true });
    const pin = join(work, ".hara-profile");
    writeFileSync(pin, "org-x\n");

    const pending = writePin(work, "personal");
    writeFileSync(pin, "org-y\n");
    await assert.rejects(pending, /changed|another entry|retained/i);
    assert.equal(readFileSync(pin, "utf8"), "org-y\n", "the concurrently replaced target is not overwritten");
  });
});

test("writePin: parent symlink retarget remains bound to the original canonical directory", async () => {
  await withHomeAsync(async (home) => {
    const first = join(home, "first");
    const second = join(home, "second");
    const alias = join(home, "project-link");
    mkdirSync(first);
    mkdirSync(second);
    symlinkSync(first, alias);

    const pending = writePin(alias, "org-x");
    unlinkSync(alias);
    symlinkSync(second, alias);
    const { file } = await pending;

    assert.equal(file, join(realpathSync.native(first), ".hara-profile"));
    assert.equal(readFileSync(join(first, ".hara-profile"), "utf8"), "org-x\n");
    assert.equal(existsSync(join(second, ".hara-profile")), false);
  });
});

test("writePin: rejects unknown profile ids", async () => {
  await withHomeAsync(async (home) => {
    await assert.rejects(writePin(home, "ghost-org"), /no profile/);
  });
});

test("removeProfile: refusing to delete personal carries the new switch-away message", () => {
  withHome(() => {
    const r = removeProfile("personal");
    assert.equal(r.ok, false);
    assert.match(r.reason, /personal is your base profile/);
    assert.match(r.reason, /switch away with/);
  });
});

test("removeProfile: gateway profile → activeChanged + removedKind=gateway", () => {
  withHome(() => {
    // Promote org-x to active first (so the removal triggers the activeChanged path).
    const u = useProfile("org-x");
    assert.equal(u.ok, true);
    const r = removeProfile("org-x");
    assert.equal(r.ok, true);
    assert.equal(r.activeChanged, true);
    assert.equal(r.removedKind, "gateway");
    assert.equal(r.removed.gatewayUrl, "https://gw-x.example/");
    // active fell back to personal.
    assert.equal(activeId(), "personal");
    // org-x is gone.
    assert.equal(listProfiles().some((p) => p.id === "org-x"), false);
  });
});

test("removeProfile: unknown id → ok=false with friendly message", () => {
  withHome(() => {
    const r = removeProfile("does-not-exist");
    assert.equal(r.ok, false);
    assert.match(r.reason, /no profile 'does-not-exist'/);
  });
});
