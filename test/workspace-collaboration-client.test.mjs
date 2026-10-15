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
const memberPage = (members, nextCursor = null) => ({ schemaVersion: 1, workspaceId: A, accountRegion: "CN", members, nextCursor });
const rosterMember = (principalId = "person-a", extra = {}) => ({ principalId, kind: "human", displayName: "Synthetic person", role: "MEMBER", ...extra });
test("member directory uses private Account auth and projects only human public identity", async () => {
  const f = fixture(), accountScope = await f.scope();
  f.handler(url => url.includes("/members?") ? f.json(memberPage([rosterMember("person-a", { email: "private@example.invalid", accountId: "private-account", token: "private-token" })], "page+two")) : undefined);
  const result = await f.client.members({ workspaceId: A, accountScope });
  assert.deepEqual(result.value.members, [rosterMember()]);
  assert.equal(result.value.nextCursor, "page+two");
  assert.doesNotMatch(JSON.stringify(result), /email|accountId|token|private-account/);
  assert.equal(f.requests.at(-1).url, "https://account.example/v1/workspaces/" + A + "/members?limit=50");
  assert.equal(f.requests.at(-1).options.method, "GET");
  assert.equal(f.requests.at(-1).options.headers.Authorization, "Bearer private-account-token");
  assert.equal(f.requests.some(item => item.url.startsWith("https://collab.example")), false);
  await f.client.members({ workspaceId: A, accountScope, cursor: "page+two" });
  assert.match(f.requests.at(-1).url, /cursor=page%2Btwo$/);
});
test("member pages reject foreign scope/region, forged kinds, duplicates and unbounded data", async () => {
  const f = fixture(), accountScope = await f.scope();
  for (const page of [
    { ...memberPage([rosterMember()]), workspaceId: B }, { ...memberPage([rosterMember()]), accountRegion: "GLOBAL" },
    memberPage([rosterMember("p", { kind: "agent" })]), memberPage([rosterMember("p", { role: "OWNER_FROM_CLIENT" })]),
    memberPage([rosterMember("p", { displayName: "x".repeat(121) })]), memberPage([rosterMember("p", { displayName: "  " })]),
    memberPage([rosterMember("person@example.invalid")]), memberPage([rosterMember("p\nsecret")]),
    memberPage([rosterMember("p", { displayName: "聯繫名@example.invalid" })]), memberPage([rosterMember("p", { displayName: "name\nprivate" })]),
    memberPage([rosterMember("internal@mailbox")]), memberPage([rosterMember("p\u202esecret")]),
    memberPage([rosterMember("p", { displayName: "名@邮箱" })]), memberPage([rosterMember("p", { displayName: "name\u2028private" })]),
    memberPage([rosterMember(), rosterMember()]), memberPage(Array.from({ length: 51 }, (_, i) => rosterMember("p" + i))),
    memberPage([], "empty-continuation"),
  ]) {
    f.handler(url => url.includes("/members?") ? f.json(page) : undefined);
    assert.equal((await f.client.members({ workspaceId: A, accountScope })).error.code, "UNAVAILABLE");
  }
});
test("roster cursor errors preserve authority while account denial and sign-in drift stay distinct", async () => {
  const f = fixture(), accountScope = await f.scope();
  for (const [httpCode, upstream, expected] of [[400, "WORKSPACE_MEMBERS_CURSOR_INVALID", "MEMBERS_STALE"],
    [409, "WORKSPACE_MEMBERS_CURSOR_STALE", "MEMBERS_STALE"], [403, "WORKSPACE_MEMBERSHIP_INACTIVE", "ACCESS_CHANGED"],
    [401, "AUTH_REQUIRED", "AUTH_REQUIRED"], [404, "NOT_FOUND", "UNAVAILABLE"], [503, "UNAVAILABLE", "UNAVAILABLE"]]) {
    f.handler(url => url.includes("/members?") ? new Response(JSON.stringify({ error: { code: upstream, message: "private detail" } }), { status: httpCode }) : undefined);
    assert.deepEqual(await f.client.members({ workspaceId: A, accountScope, cursor: "opaque" }), { ok: false, error: { code: expected } });
  }
  f.handler(url => { if (url.includes("/members?")) { f.setState({ ...f.getState(), accessToken: "other-login" });
    return new Response(JSON.stringify({ error: { code: "WORKSPACE_MEMBERS_CURSOR_INVALID" } }), { status: 400 }); } });
  assert.equal((await f.client.members({ workspaceId: A, accountScope })).error.code, "SCOPE_CHANGED");
  const before = f.requests.length;
  assert.equal((await f.client.members({ workspaceId: A, accountScope })).error.code, "SCOPE_CHANGED");
  assert.equal(f.requests.length, before);
});
test("member caller cannot override identity, endpoint, role, Realm or page size", async () => {
  const f = fixture(), accountScope = await f.scope(), before = f.requests.length;
  for (const extra of [{ principalId: "forged" }, { kind: "agent" }, { role: "OWNER" }, { realmId: "private" },
    { origin: "https://other.example" }, { accessToken: "forged" }, { limit: 1000 }]) {
    assert.equal((await f.client.members({ workspaceId: A, accountScope, ...extra })).error.code, "INVALID_INPUT");
  }
  assert.equal(f.requests.length, before);
});
const target = principalId => ({ kind: "human", principalId });
test("typed mentions use a distinct route and canonical IDs; no name, role or private fields escape", async () => {
  const f = fixture(), accountScope = await f.scope();
  f.handler((url, options) => url.endsWith("/messages/with-mentions") ? f.json({ schemaVersion: 1, workspaceId: A, data: {
    messageId: M, channelId: C, senderPrincipalId: "principal-a", createdAt: "2033-05-18T03:33:20.000Z", realmSeq: "12",
    mentions: JSON.parse(options.body).mentions.map(item => ({ ...item, displayName: "private name", email: "private@example.invalid", role: "OWNER" })), token: "private-token",
  } }) : undefined);
  const input = { workspaceId: A, channelId: C, accountScope, body: "ordinary text", idempotencyKey: "frozen-mention-1", mentions: [target("z"), target("A"), target("人")] };
  const result = await f.client.sendWithMentions(input);
  assert.equal(result.ok, true); assert.deepEqual(result.value.mentions, [target("A"), target("z"), target("人")]);
  assert.doesNotMatch(JSON.stringify(result), /email|displayName|role|token|private/);
  const request = f.requests.at(-1); assert.equal(request.url, "https://collab.example/v1/workspaces/" + A + "/channels/" + C + "/messages/with-mentions");
  assert.equal(request.options.headers["Idempotency-Key"], "frozen-mention-1");
  assert.deepEqual(JSON.parse(request.options.body), { body: "ordinary text", mentions: result.value.mentions });
  const plain = await f.client.send({ workspaceId: A, channelId: C, accountScope, body: "@A is just text", idempotencyKey: "plain-1" });
  assert.equal(plain.ok, true); assert.equal(Object.hasOwn(plain.value, "mentions"), false);
  assert.deepEqual(JSON.parse(f.requests.at(-1).options.body), { body: "@A is just text" });
});
test("malformed mention identities and routing overrides are rejected before any I/O", async () => {
  const f = fixture(), accountScope = await f.scope(), before = f.requests.length;
  const input = { workspaceId: A, channelId: C, accountScope, body: "text", idempotencyKey: "key" };
  for (const mentions of [[], [target("same"), target("same")], [target(" bad ")], [target("a\nb")], [target("person@example.invalid")], [target("person@mailbox")], [target("a\u202eb")],
    [{ kind: "agent", principalId: "p" }], [{ kind: "all", principalId: "p" }], [{ ...target("p"), role: "OWNER" }],
    [{ kind: "human", displayName: "Person" }], Array.from({ length: 11 }, (_, i) => target("p" + i))]) {
    assert.equal((await f.client.sendWithMentions({ ...input, mentions })).error.code, "INVALID_INPUT");
  }
  assert.equal((await f.client.sendWithMentions({ ...input, mentions: [target("p")], origin: "https://other.example" })).error.code, "INVALID_INPUT");
  assert.equal((await f.client.send({ ...input, mentions: [target("p")] })).error.code, "INVALID_INPUT");
  assert.equal(f.requests.length, before);
});
test("a missing route or unconfirmed mention receipt never downgrades or confirms a possibly accepted send", async () => {
  const f = fixture(), accountScope = await f.scope();
  const input = { workspaceId: A, channelId: C, accountScope, body: "text", idempotencyKey: "frozen", mentions: [target("p")] };
  for (const mentions of [undefined, [], [target("wrong")], [target("p"), target("p")]]) {
    f.handler(url => url.endsWith("/messages/with-mentions") ? f.json({ schemaVersion: 1, workspaceId: A, data: {
      messageId: M, channelId: C, senderPrincipalId: "principal-a", createdAt: "2033-05-18T03:33:20.000Z", mentions,
    } }) : undefined);
    assert.equal((await f.client.sendWithMentions(input)).error.code, "OUTCOME_UNKNOWN");
  }
  for (const [httpCode, code, expected] of [[404, "NOT_FOUND", "OUTCOME_UNKNOWN"], [400, "MENTION_TARGET_UNAVAILABLE", "MENTION_TARGET_UNAVAILABLE"],
    [400, "INVALID_MENTIONS", "INVALID_INPUT"], [503, "UNAVAILABLE", "OUTCOME_UNKNOWN"], [403, "ACCESS_CHANGED", "ACCESS_CHANGED"]]) {
    f.handler(url => url.endsWith("/messages/with-mentions") ? new Response(JSON.stringify({ error: { code, message: "private" } }), { status: httpCode }) : undefined);
    assert.deepEqual(await f.client.sendWithMentions(input), { ok: false, error: { code: expected } });
  }
  assert.equal(f.requests.filter(item => item.url.endsWith("/messages")).length, 0);
  assert.ok(f.requests.filter(item => item.url.endsWith("/messages/with-mentions")).every(item => item.options.headers["Idempotency-Key"] === "frozen"));
});
test("typed mention reads are projected in sync and history without adding metadata to legacy messages", async () => {
  const f = fixture(), accountScope = await f.scope();
  const row = { id: M, channelId: C, senderPrincipalId: "principal-a", body: "text", createdAt: "2033-05-18T03:33:20.000Z" };
  f.handler(url => url.includes("/messages?") ? f.json({ schemaVersion: 1, workspaceId: A, data: { channelId: C,
    messages: [{ ...row, sequence: "12", mentions: [{ ...target("p"), private: "omit" }] }], nextBefore: null } }) : undefined);
  assert.deepEqual((await f.client.history({ workspaceId: A, channelId: C, accountScope })).value.messages[0].mentions, [target("p")]);
  f.handler(url => url.includes("/sync?") ? f.json({ schemaVersion: 1, workspaceId: A, data: { cursor: "next", hasMore: false, events: [
    { id: M, type: "message.created", realmSeq: "12", message: { ...row, mentions: [target("p")] } },
    { id: C, type: "message.created", realmSeq: "13", message: { ...row, id: C } },
  ] } }) : undefined);
  const sync = await f.client.sync({ workspaceId: A, accountScope, cursor: "start" });
  assert.deepEqual(sync.value.events[0].message.mentions, [target("p")]); assert.equal(Object.hasOwn(sync.value.events[1].message, "mentions"), false);
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
test("sign-in drift outranks HTTP and transport failures on Account and Collab responses", async () => {
  for (const endpoint of ["/context", "/messages?"]) for (const outcome of ["http", "network", "stream", "oversized", "error-stream"]) {
    const f = fixture(), accountScope = await f.scope();
    const drift = () => f.setState({ ...f.getState(), account: { ...f.getState().account, id: "account-b" } });
    f.handler(url => {
      if (!url.includes(endpoint)) return;
      if (outcome === "http") {
        drift(); return new Response(JSON.stringify({ error: { code: "HISTORY_CURSOR_INVALID" } }), { status: 400 });
      }
      if (outcome === "network") { drift(); throw new Error("synthetic transport failure"); }
      return new Response(new ReadableStream({ pull(controller) {
        drift();
        if (outcome === "oversized") controller.enqueue(new Uint8Array(6 * 1024 * 1024 + 1));
        else controller.error(new Error("synthetic interrupted body"));
      } }), { status: outcome === "error-stream" ? 400 : 200 });
    });
    assert.deepEqual(await f.client.history({ workspaceId: A, channelId: C, accountScope }),
      { ok: false, error: { code: "SCOPE_CHANGED" } }, endpoint + " " + outcome);
    if (endpoint === "/context") assert.equal(f.requests.some(item => item.url.startsWith("https://collab.example")), false);
  }
});
test("sign-out after a mutation response is lost clears account authority without retrying", async () => {
  const f = fixture(), accountScope = await f.scope();
  f.handler(url => { if (url.endsWith("/messages")) { f.setState(null); throw new Error("synthetic lost receipt"); } });
  assert.deepEqual(await f.client.send({ workspaceId: A, channelId: C, accountScope, body: "synthetic", idempotencyKey: "frozen" }),
    { ok: false, error: { code: "SCOPE_CHANGED" } });
  assert.equal(f.requests.filter(item => item.url.endsWith("/messages")).length, 1);
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
  for (const [httpCode, code] of [[401, "AUTH_REQUIRED"], [403, "ACCESS_CHANGED"], [409, "ACCESS_CHANGED"], [503, "UNAVAILABLE"]]) {
    f.handler(url => url.endsWith("/context") ? new Response("credential=secret", { status: httpCode }) : undefined);
    assert.deepEqual(await f.client.bootstrap({ workspaceId: A, accountScope }), { ok: false, error: { code } });
  }
  const count = f.requests.length;
  assert.equal((await f.client.send({ workspaceId: A, accountScope, channelId: C, body: "字".repeat(3000), idempotencyKey: "k" })).error.code, "INVALID_INPUT");
  assert.equal(f.requests.length, count);
});
test("bounded response reader cancels overlarge streamed responses", async () => {
  const f = fixture(); let cancelled = false;
  f.handler(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(6 * 1024 * 1024 + 1)); },
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
test("directory cursor errors are not authority revocation; unavailable features are not membership denial", async () => {
  const f = fixture();
  for (const httpCode of [400, 409]) {
    f.handler(() => new Response("no upstream text exposed", { status: httpCode }));
    assert.deepEqual(await f.client.list({ cursor: "stale" }), { ok: false, error: { code: "DIRECTORY_STALE" } });
  }
  f.handler(() => new Response("", { status: 404 }));
  assert.equal((await f.client.list()).error.code, "UNAVAILABLE");
});
test("maximum legal message page survives JSON control-character expansion", async () => {
  const f = fixture(), accountScope = await f.scope();
  f.handler(url => url.includes("/sync?") ? f.json({ schemaVersion: 1, workspaceId: A, data: { cursor: "next", hasMore: false,
    events: Array.from({ length: 100 }, (_, i) => ({ id: "event-" + i, type: "message.created",
      message: { id: M, channelId: C, senderPrincipalId: "principal-a", body: "\u0001".repeat(8192), createdAt: "2033-05-18T03:33:20.000Z" } })) } }) : undefined);
  const result = await f.client.sync({ workspaceId: A, accountScope, cursor: "cursor" });
  assert.equal(result.ok, true); assert.equal(result.value.events.length, 100);
});
const historyPage = (messages, nextBefore = null) => ({ schemaVersion: 1, workspaceId: A, data: { channelId: C, messages, nextBefore } });
const historicalMessage = (index, extra = {}) => ({ id: "44444444-4444-4444-8444-" + String(index).padStart(12, "0"),
  channelId: C, senderPrincipalId: "principal-a", body: "record " + index, createdAt: "2033-05-18T03:33:20.000Z", sequence: String(index), ...extra });
test("history is channel-scoped, chronological by sequence and projects no arbitrary fields", async () => {
  const f = fixture(), accountScope = await f.scope();
  f.handler(url => url.includes("/messages?") ? f.json(historyPage([historicalMessage(1, { private: "omit" }), historicalMessage(2)], "older-cursor")) : undefined);
  const result = await f.client.history({ workspaceId: A, accountScope, channelId: C });
  assert.equal(result.ok, true); assert.deepEqual(result.value.messages.map(item => item.sequence), ["1", "2"]);
  assert.equal(result.value.nextBefore, "older-cursor"); assert.doesNotMatch(JSON.stringify(result), /private|omit|realmId|token/);
  assert.equal(f.requests.at(-1).options.method, "GET");
  assert.equal(f.requests.at(-1).url, "https://collab.example/v1/workspaces/" + A + "/channels/" + C + "/messages?limit=50");
  await f.client.history({ workspaceId: A, accountScope, channelId: C, before: "signed+older" });
  assert.match(f.requests.at(-1).url, /before=signed%2Bolder$/);
});
test("malformed history, mismatched channel, repeated IDs and unsafe sequences fail closed", async () => {
  const f = fixture(), accountScope = await f.scope();
  const first = historicalMessage(1), second = historicalMessage(2);
  for (const messages of [[second, first], [first, first], [first, { ...second, channelId: M }],
    [{ ...first, sequence: undefined }], [{ ...first, sequence: "9223372036854775808" }], [{ ...first, sequence: "01" }]]) {
    f.handler(url => url.includes("/messages?") ? f.json(historyPage(messages)) : undefined);
    assert.equal((await f.client.history({ workspaceId: A, accountScope, channelId: C })).error.code, "UNAVAILABLE");
  }
  f.handler(url => url.includes("/messages?") ? f.json(historyPage([first], "same")) : undefined);
  assert.equal((await f.client.history({ workspaceId: A, accountScope, channelId: C, before: "same" })).error.code, "UNAVAILABLE");
});
test("history pagination errors preserve authority; real context/access errors stay distinct", async () => {
  const f = fixture(), accountScope = await f.scope();
  for (const [httpCode, code] of [[400, "HISTORY_STALE"], [409, "HISTORY_STALE"], [404, "UNAVAILABLE"], [401, "AUTH_REQUIRED"], [403, "ACCESS_CHANGED"]]) {
    f.handler(url => url.includes("/messages?") ? new Response(JSON.stringify({ error: {
      code: httpCode === 400 ? "HISTORY_CURSOR_INVALID" : httpCode === 409 ? "HISTORY_CURSOR_STALE" : "OTHER",
      message: "never reflect upstream body",
    } }), { status: httpCode }) : undefined);
    assert.deepEqual(await f.client.history({ workspaceId: A, accountScope, channelId: C, before: "old" }), { ok: false, error: { code } });
  }
  f.handler(url => url.endsWith("/context") ? new Response("", { status: 409 }) : undefined);
  assert.equal((await f.client.history({ workspaceId: A, accountScope, channelId: C })).error.code, "ACCESS_CHANGED");
});
test("history AUTH_CONTEXT_STALE is real access loss, not an ordinary cursor restart", async () => {
  const f = fixture(), accountScope = await f.scope();
  f.handler(url => url.includes("/messages?") ? new Response(JSON.stringify({ error: { code: "AUTH_CONTEXT_STALE" } }), { status: 409 }) : undefined);
  assert.equal((await f.client.history({ workspaceId: A, accountScope, channelId: C, before: "cursor" })).error.code, "ACCESS_CHANGED");
  for (const [code, expected] of [["AUTH_PROJECTION_LAG", "PROJECTION_PENDING"], ["DATABASE_UNAVAILABLE", "UNAVAILABLE"]]) {
    f.handler(url => url.endsWith("/bootstrap") ? new Response(JSON.stringify({ error: { code } }), { status: 503 }) : undefined);
    assert.equal((await f.client.bootstrap({ workspaceId: A, accountScope })).error.code, expected);
  }
});
test("history overrides and stale account scope are refused before I/O", async () => {
  const f = fixture(), accountScope = await f.scope(), before = f.requests.length;
  for (const extra of [{ role: "OWNER" }, { realmId: "other" }, { origin: "https://other.example" }, { limit: 1000 }, { before: "" }]) {
    assert.equal((await f.client.history({ workspaceId: A, channelId: C, accountScope, ...extra })).error.code, "INVALID_INPUT");
  }
  assert.equal(f.requests.length, before);
  f.setState({ ...f.getState(), accessToken: "new-sign-in" });
  assert.equal((await f.client.history({ workspaceId: A, channelId: C, accountScope })).error.code, "SCOPE_CHANGED");
  assert.equal(f.requests.length, before);
});
