// Session-scoped "host unreachable" memory (network fault tolerance). Pure classification is unit-tested
// here; the bash tool wires it into pre-check short-circuit + post-failure recording.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  markHostUnreachable,
  isHostUnreachable,
  unreachableHostsSnapshot,
  resetReachability,
  hostsInCommand,
  isNetworkGitOp,
  hostFromConnectError,
  isConnectFailure,
} from "../dist/tools/net-reachability.js";

test("mark/is/snapshot/reset roundtrip (case-insensitive)", () => {
  resetReachability();
  assert.equal(isHostUnreachable("github.com"), false);
  markHostUnreachable("GitHub.com");
  assert.equal(isHostUnreachable("github.com"), true, "lookup is case-insensitive");
  assert.deepEqual(unreachableHostsSnapshot(), ["github.com"]);
  resetReachability();
  assert.deepEqual(unreachableHostsSnapshot(), [], "reset clears (as /reset does)");
  assert.equal(isHostUnreachable(""), false, "empty host is never unreachable");
});

test("hostsInCommand: URLs + scp/ssh specs; bare git pull → []", () => {
  assert.deepEqual(hostsInCommand("git clone https://github.com/owner/repo.git"), ["github.com"]);
  assert.deepEqual(hostsInCommand("git clone git@github.com:owner/repo.git"), ["github.com"]);
  assert.deepEqual(hostsInCommand("git clone ssh://git@gitlab.example.com:22/x/y.git"), ["gitlab.example.com"]);
  assert.deepEqual(hostsInCommand("curl -sSL https://api.deepseek.com/v1/models"), ["api.deepseek.com"]);
  assert.deepEqual(hostsInCommand("git pull origin main"), [], "no URL → host lives in remote config");
  assert.deepEqual(hostsInCommand("ls -la && echo hi"), [], "no network → []");
});

test("isNetworkGitOp: bare pull/fetch/push/clone/ls-remote are network ops; status/log are not", () => {
  for (const c of ["git pull origin main", "git fetch", "git push", "git clone https://x/y", "git ls-remote origin", "git submodule update --init"]) {
    assert.equal(isNetworkGitOp(c), true, c);
  }
  for (const c of ["git status", "git log --oneline", "git add .", "git commit -m x", "npm test"]) {
    assert.equal(isNetworkGitOp(c), false, c);
  }
});

test("hostFromConnectError: pulls the host out of git/curl connectivity errors", () => {
  assert.equal(hostFromConnectError("fatal: unable to access 'https://github.com/o/r.git/': Failed to connect to github.com port 443 after 75009 ms: Couldn't connect to server"), "github.com");
  assert.equal(hostFromConnectError("fatal: unable to access 'https://gitlab.com/o/r.git/': Could not resolve host: gitlab.com"), "gitlab.com");
  assert.equal(hostFromConnectError("curl: (28) Resolving timed out after 5005 milliseconds"), "", "no host named → empty");
  assert.equal(hostFromConnectError("curl: (6) Could not resolve host: api.deepseek.com"), "api.deepseek.com");
  assert.equal(hostFromConnectError("fatal: Authentication failed for 'https://github.com/o/r.git/'"), "", "auth error names no connect-host");
});

test("isConnectFailure: true for timeout/DNS; FALSE for auth/404 AND for connection-refused (host is up)", () => {
  assert.equal(isConnectFailure("Failed to connect to github.com port 443 after 75009 ms: Couldn't connect to server"), true, "connect timeout");
  assert.equal(isConnectFailure("Could not resolve host: github.com"), true, "DNS");
  assert.equal(isConnectFailure("curl: (28) Resolving timed out after 5005 milliseconds"), true, "curl resolve timeout");
  assert.equal(isConnectFailure("connect ETIMEDOUT 140.82.112.3:443"), true, "ETIMEDOUT");
  assert.equal(isConnectFailure("fatal: Authentication failed for 'https://github.com/o/r.git/'"), false, "auth is not unreachability");
  assert.equal(isConnectFailure("remote: Repository not found. 404"), false, "404 is not unreachability");
  assert.equal(isConnectFailure("Failed to connect to localhost port 3000 after 1 ms: Connection refused"), false, "refused = host up, fast fail — never cache");
});
