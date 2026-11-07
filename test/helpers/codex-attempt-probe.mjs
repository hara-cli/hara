// Observe only the owned synthetic driver's real capability. Never change authorization,
// synthesize native responses, log the bearer, or persist it in fixture metadata.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { GovernedCodexSession } from "../../dist/agent-runtime/codex-session.js";

export function observeCodexAttempts(t) {
  const attempts = [];
  const original = GovernedCodexSession.prototype.createEndpoint;
  t.mock.method(GovernedCodexSession.prototype, "createEndpoint", async function (...args) {
    const endpoint = await original.apply(this, args);
    const token = endpoint.env.HARA_WORKSPACE_MCP_TOKEN;
    assert.ok(typeof token === "string" && /^[a-f0-9]{64}$/.test(token), "owned fixture capability exists");
    attempts.push({ token, fingerprint: createHash("sha256").update(token).digest("hex") });
    return endpoint;
  });
  return async (meta, { resident = false } = {}) => {
    const url = new URL(meta.url);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.protocol, "http:");
    const owned = attempts.find(row => row.fingerprint === meta.tokenFingerprint);
    assert.ok(owned, "probe must match this fixture's actual native bearer");
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, { method: "POST",
          headers: { Authorization: "Bearer " + owned.token, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) });
        await response.body?.cancel();
        if (response.status === 403) return "revoked";
        assert.notEqual(response.status, 401, "unauthenticated refusal cannot prove attempt revocation");
      } catch (error) {
        if (!resident && error?.cause?.code === "ECONNREFUSED") return "closed";
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    assert.fail("owned authenticated capability remained live after physical attempt settlement");
  };
}
