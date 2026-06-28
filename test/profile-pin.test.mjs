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
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  listProfiles,
  activeId,
  resolveActive,
  setFlagOverride,
  findPinnedProfile,
  writePin,
  removePin,
  removeProfile,
  useProfile,
} from "../dist/profile/profile.js";

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
    assert.equal(p.file, join(work, ".hara-profile"));
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
    assert.equal(p.file, join(proj, ".hara-profile"));
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
    const p = findPinnedProfile(work);
    assert.equal(p, null);
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

test("writePin / removePin: round trip", () => {
  withHome((home) => {
    const work = join(home, "proj");
    mkdirSync(work, { recursive: true });
    const { file } = writePin(work, "org-x");
    assert.equal(file, join(work, ".hara-profile"));
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

test("writePin: rejects unknown profile ids", () => {
  withHome((home) => {
    assert.throws(() => writePin(home, "ghost-org"), /no profile/);
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
