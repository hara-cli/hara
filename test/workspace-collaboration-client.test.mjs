import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceCollaborationClient, configuredWorkspaceCollaboration } from "../dist/workspace/collaboration-client.js";

const A = "ws_11111111-1111-4111-8111-111111111111", B = "ws_22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333", M = "44444444-4444-4444-8444-444444444444";
const now = 2_000_000_000_000;
function fixture() {
  let state = { accessToken: "private-account-token", accessTokenExpiresAt: now + 600_000,
    account: { id: "account-a", displayName: "Synthetic", region: "cn" }, desktop: { id: "desktop-a" } };
  const requests = [];
  let handler = null;
  const json = value => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });
  const client = new WorkspaceCollaborationClient({ collabOrigin: "https://collab.example", accountOrigin: "https://account.example",
    loadState: () => state, now: () => now, fetcher: async (url, options) => {
      requests.push({ url, options });
      if (handler) { const override = await handler(url, options); if (override !== undefined) return override; }
      if (url.includes("?limit=50")) return json({ schemaVersion: 1, accountRegion: "CN",
        workspaces: [{ workspaceId: A, membership: { role: "OWNER", membershipVersion: 1, policyVersion: 1 } }], nextCursor: null });
      if (url.endsWith("/context")) return json({ workspaceId: url.includes(B) ? B : A, token: "private-workspace-assertion", tokenType: "Bearer", expiresInSeconds: 300 });
      const data = url.endsWith("/bootstrap") ? { realmId: "internal-realm", displayName: "Nanhara", cursor: "private-cursor", secret: "never-project",
        membership: { principalId: "principal-a", role: "OWNER", epoch: 1 }, channels: [{ id: C, kind: "TEXT", slug: "general", displayName: "General" }] }
        : url.includes("/sync?") ? { realmId: "internal-realm", cursor: "next-cursor", hasMore: false,
          events: [{ id: M, type: "message.created", payload: { private: "omit" },
            message: { id: M, channelId: C, senderPrincipalId: "principal-a", body: "hello", createdAt: "2033-05-18T03:33:20.000Z" } }] }
        : { messageId: M, realmId: "internal-realm", channelId: C, senderPrincipalId: "principal-a", createdAt: "2033-05-18T03:33:20.000Z" };
      return json({ schemaVersion: 1, workspaceId: A, data });
    } });
  return { client, requests, json, setState: next => { state = next; }, getState: () => state, handler: value => { handler = value; },
    async scope() { const result = await client.list(); assert.equal(result.ok, true); return result.value.accountScope; } };
}
test("host feature is default off and never accepts renderer origins or insecure network origins", () => {
  assert.equal(configuredWorkspaceCollaboration({}), undefined);
  assert.equal(configuredWorkspaceCollaboration({ HARA_WORKSPACE_COLLAB_ENABLED: "1", HARA_WORKSPACE_COLLAB_ORIGIN: "http://example.com" }), undefined);
  for (const collabOrigin of ["https://user:pass@x.example", "https://x.example/path", "https://x.example?secret=1", "http://127.0.0.1:1234"]) {
    assert.throws(() => new WorkspaceCollaborationClient({ collabOrigin }));
  }
});
test("directory and collaboration responses contain neither credentials nor Realm/payload internals", async () => {
  const f = fixture(), accountScope = await f.scope();
  assert.match(accountScope, /^[a-f0-9]{64}$/);
  const bootstrap = await f.client.bootstrap({ workspaceId: A, accountScope });
  assert.equal(bootstrap.value.displayName, "Nanhara");
  assert.equal(bootstrap.value.membership.role, "OWNER");
  const sync = await f.client.sync({ workspaceId: A, accountScope, cursor: bootstrap.value.cursor });
  assert.equal(sync.value.events[0].message.body, "hello");
  assert.doesNotMatch(JSON.stringify([bootstrap, sync]), /private-account-token|private-workspace-assertion|internal-realm|never-project|"payload"/);
  const context = f.requests.find(item => item.url.endsWith("/context"));
  assert.equal(context.options.headers.Authorization, "Bearer private-account-token");
  assert.equal(context.options.redirect, "error");
  assert.equal(f.requests.find(item => item.url.endsWith("/bootstrap")).options.headers.Authorization, "Bearer private-workspace-assertion");
});
test("signed-out and expired states produce no requests or account refresh writes", async () => {
  const f = fixture(); f.setState(null);
  assert.equal((await f.client.list()).error.code, "AUTH_REQUIRED");
  f.setState({ accessToken: "expired", accessTokenExpiresAt: now - 1 });
  assert.equal((await f.client.list()).error.code, "AUTH_REQUIRED");
  assert.equal(f.requests.length, 0);
});
test("every selected operation requires a frozen account scope before any network I/O", async () => {
  const f = fixture(), accountScope = await f.scope(), count = f.requests.length;
  f.setState({ ...f.getState(), accessToken: "new-account-token" });
  for (const promise of [
    f.client.bootstrap({ workspaceId: A, accountScope }), f.client.sync({ workspaceId: A, accountScope, cursor: "cursor" }),
    f.client.send({ workspaceId: A, channelId: C, body: "hello", idempotencyKey: "request-1", accountScope }),
    f.client.createChannel({ workspaceId: A, slug: "general", displayName: "General", idempotencyKey: "request-2", accountScope }),
  ]) assert.equal((await promise).error.code, "SCOPE_CHANGED");
  assert.equal(f.requests.length, count);
});
test("sign-out while Account context is pending prevents Collab credential transmission", async () => {
  const f = fixture(), accountScope = await f.scope();
  f.handler(url => { if (url.endsWith("/context")) f.setState(null); });
  assert.equal((await f.client.bootstrap({ workspaceId: A, accountScope })).error.code, "SCOPE_CHANGED");
  assert.equal(f.requests.filter(item => item.url.startsWith("https://collab.example")).length, 0);
});
test("late collaboration responses are not returned after a sign-in switch", async () => {
  const f = fixture(), accountScope = await f.scope();
  f.handler(url => { if (url.endsWith("/bootstrap")) f.setState({ ...f.getState(), account: { ...f.getState().account, id: "account-b" } }); });
  const result = await f.client.bootstrap({ workspaceId: A, accountScope });
  assert.deepEqual(result, { ok: false, error: { code: "SCOPE_CHANGED" } });
});
test("untrusted role, token, endpoint and Realm overrides fail locally", async () => {
  const f = fixture(), accountScope = await f.scope(), before = f.requests.length;
  for (const extra of [{ role: "OWNER" }, { realmId: "other" }, { token: "override" }, { origin: "https://other.example" }]) {
    assert.equal((await f.client.bootstrap({ workspaceId: A, accountScope, ...extra })).error.code, "INVALID_INPUT");
  }
  assert.equal((await f.client.bootstrap({ workspaceId: "personal", accountScope })).error.code, "INVALID_INPUT");
  assert.equal(f.requests.length, before);
});
test("directory region mismatch and cross-Workspace envelopes are refused", async () => {
  const f = fixture();
  f.handler(url => url.includes("?limit=50") ? f.json({ schemaVersion: 1, accountRegion: "GLOBAL", workspaces: [], nextCursor: null }) : undefined);
  assert.equal((await f.client.list()).error.code, "UNAVAILABLE");
  f.handler(null); const accountScope = await f.scope();
  assert.equal((await f.client.bootstrap({ workspaceId: B, accountScope })).error.code, "UNAVAILABLE");
});
test("a lost or malformed send receipt is outcome-unknown and is never retried automatically", async () => {
  const f = fixture(), accountScope = await f.scope();
  f.handler(url => { if (url.endsWith("/messages")) throw new Error("secret raw transport details"); });
  const request = { workspaceId: A, accountScope, channelId: C, body: "private text", idempotencyKey: "same-request" };
  assert.deepEqual(await f.client.send(request), { ok: false, error: { code: "OUTCOME_UNKNOWN" } });
  assert.equal(f.requests.filter(item => item.url.endsWith("/messages")).length, 1);
  f.handler(url => url.endsWith("/messages") ? f.json({ schemaVersion: 1, workspaceId: A, data: null }) : undefined);
  assert.equal((await f.client.send(request)).error.code, "OUTCOME_UNKNOWN");
  assert.equal(f.requests.at(-1).options.headers["Idempotency-Key"], "same-request");
});
test("HTTP errors are redacted, access errors distinct and UTF-8 input is bounded before I/O", async () => {
  const f = fixture(), accountScope = await f.scope();
  for (const [httpCode, code] of [[401, "AUTH_REQUIRED"], [403, "ACCESS_CHANGED"], [409, "ACCESS_CHANGED"], [503, "PROJECTION_PENDING"]]) {
    f.handler(url => url.endsWith("/context") ? new Response("credential=secret", { status: httpCode }) : undefined);
    assert.deepEqual(await f.client.bootstrap({ workspaceId: A, accountScope }), { ok: false, error: { code } });
  }
  const count = f.requests.length;
  assert.equal((await f.client.send({ workspaceId: A, accountScope, channelId: C, body: "字".repeat(3000), idempotencyKey: "k" })).error.code, "INVALID_INPUT");
  assert.equal(f.requests.length, count);
});
test("bounded response reader cancels overlarge streamed responses", async () => {
  const f = fixture(); let cancelled = false;
  f.handler(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(512 * 1024 + 1)); },
    cancel() { cancelled = true; } })));
  assert.equal((await f.client.list()).error.code, "UNAVAILABLE");
  assert.equal(cancelled, true);
});
test("channel-created sync projects only validated public metadata, not arbitrary payload", async () => {
  const f = fixture(), accountScope = await f.scope();
  f.handler(url => url.includes("/sync?") ? f.json({ schemaVersion: 1, workspaceId: A, data: { cursor: "next", hasMore: false, events: [
    { id: "event", type: "channel.created", message: null, payload: { channelId: C, kind: "TEXT", slug: "new-channel", displayName: "New", credential: "omit-me" } },
  ] } }) : undefined);
  const result = await f.client.sync({ workspaceId: A, accountScope, cursor: "cursor" });
  assert.deepEqual(result.value.events[0].channel, { id: C, slug: "new-channel", displayName: "New" });
  assert.doesNotMatch(JSON.stringify(result), /credential|omit-me/);
});
