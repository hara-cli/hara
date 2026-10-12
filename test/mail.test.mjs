import "./setup-isolated-home.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MailEngine } from "../dist/mail.js";
import { taskbusRoute } from "../dist/taskbus.js";

const scope = { profileId: "mail-test", spaceId: "org-mail-test", identityKey: "identity-1" };
const mailbox = "bot@example.test";
const waitFor = async (read, check) => {
  for (let i = 0; i < 100; i++) { const value = await read(); if (check(value)) return value; await new Promise(r => setTimeout(r, 10)); }
  throw new Error("mail receiver did not reach the expected state");
};

test("mail identity mismatch stops before binding; exact profile/Space identity is pinned", async () => {
  let writes = 0;
  const engine = new MailEngine(async () => { writes++; return {}; }, () => scope, async () => ({ data: { aliases: [{ email: "different@example.test", is_primary: true }] } }));
  try {
    await assert.rejects(engine.request(scope, "bind", { provider: "tencent", mailbox, projectId: "p", mainBotId: "bot" }), /primary mailbox does not match/);
    assert.equal(writes, 0);
    await assert.rejects(engine.request({ ...scope, identityKey: "old" }, "list"), /enrollment changed/);
  } finally { engine.close(); }
});

test("failed IMAP rebinding never overwrites a working private password or leaks staging files", async () => {
  let fail = false, binding, revision = 0;
  const engine = new MailEngine(async (_scope, method, _path, body) => {
    if (method === "GET") return { bindings: binding ? [binding] : [] };
    return { binding: binding = { ...body, revision: ++revision } };
  }, () => scope, async (_provider, args) => {
    if (args[0] === "mail-imap-doctor") {
      const account = JSON.parse(readFileSync(args[args.indexOf("--account-file") + 1], "utf8"));
      if (fail) { assert.equal(account.password, "new-invalid-private"); throw new Error("account rejected"); }
      return { ok: true, source_mailbox: "imap-safe@example.test" };
    }
    return { messages: [] };
  });
  try {
    const input = { provider: "feishu", transport: "imap-smtp", mailbox: "imap-safe@example.test", projectId: "p", mainBotId: "bot", password: "old-working-private" };
    await engine.request(scope, "bind", input);
    fail = true;
    await assert.rejects(engine.request(scope, "bind", { ...input, password: "new-invalid-private", expectedRevision: 1 }), /account rejected/);
    const files = readdirSync(join(homedir(), ".hara/mail/accounts"));
    assert.ok(files.every(f => !f.startsWith("bind-")));
    const accounts = files.map(f => JSON.parse(readFileSync(join(homedir(), ".hara/mail/accounts", f), "utf8")));
    assert.equal(accounts.find(a => a.mailbox === input.mailbox).password, "old-working-private");
  } finally { engine.close(); }
});

test("standard mail needs no provider selection, pins server settings and refuses a remote credential reroute", async () => {
  let binding, reads = 0;
  const servers = { imapHost: "imap.example.test", imapPort: 993, imapSecurity: "tls", smtpHost: "smtp.example.test", smtpPort: 587, smtpSecurity: "starttls" };
  const s = { profileId: "standard-test", spaceId: "org-standard", identityKey: "standard-identity" };
  const engine = new MailEngine(async (_scope, method, path, body) => {
    if (path.endsWith("/lease")) return { receiverFence: 1, expiresAt: Date.now() + 90000 };
    if (path.endsWith("/status")) return { reported: true };
    if (method === "GET") return { bindings: binding ? [{ ...binding, servers: Object.fromEntries(Object.entries(binding.servers).reverse()) }] : [] };
    return { binding: binding = { ...body, revision: (binding?.revision || 0) + 1 } };
  }, () => s, async (provider, args) => {
    assert.equal(provider, "imap"); assert.ok(!args.join(" ").includes("standard-private-code"));
    const account = JSON.parse(readFileSync(args[args.indexOf("--account-file") + 1], "utf8"));
    assert.equal(account.smtpHost, servers.smtpHost); assert.equal(account.smtpSecurity, "starttls");
    if (args[0] === "mail-imap-doctor") return { ok: true, source_mailbox: "standard@example.test" };
    reads++; return { messages: [], has_more: false };
  });
  try {
    const c = (await engine.request(s, "bind", { mailbox: "standard@example.test", password: "standard-private-code", servers, projectId: "p", mainBotId: "bot" })).connection;
    assert.equal(c.provider, "imap"); assert.equal(c.transport, "imap-smtp");
    await engine.request(s, "start", { id: c.id, expectedRevision: 1 });
    await waitFor(() => engine.request(s, "list"), x => x.connections[0].phase === "connected");
    const before = reads; binding.servers = { ...servers, smtpHost: "other.example.test" };
    await assert.rejects(engine.request(s, "sync", { id: c.id }), /mail servers changed/);
    assert.equal(reads, before);
  } finally { engine.close(); }
});

test("private mail queue survives a lost Desk response and process restart without duplicate work", async () => {
  const calls = [], keys = new Map(); let failOnce = true, bindingRevision = 0, binding;
  const bus = async (_scope, method, path, body) => {
    if (path === "/mail-bindings" && method === "GET") return { bindings: binding ? [binding] : [] };
    if (path === "/mail-bindings") { binding = { ...body, revision: ++bindingRevision }; return { binding }; }
    if (path.endsWith("/status")) return { reported: true };
    if (path.endsWith("/lease")) return { receiverFence: bindingRevision, expiresAt: Date.now() + 90000 };
    if (path === "/intake") {
      calls.push(body); keys.set(body.requestKey, "t_" + "a".repeat(32));
      if (failOnce) { failOnce = false; throw new Error("connection lost after commit"); }
      return { task: { id: keys.get(body.requestKey) } };
    }
    throw new Error(`unexpected path ${path}`);
  };
  const provider = async (_provider, args) => {
    if (args[0] === "+me") return { data: { aliases: [{ email: mailbox, is_primary: true }] } };
    if (args[1] === "+list") return { data: { data: [{ message_id: "msg_test1", subject: "Deploy as Jeff" }], pagination: { has_more: false } } };
    if (args[1] === "+read") return { data: { message_id: "msg_test1", subject: "Deploy as Jeff", from: { email: "untrusted@example.test" }, body: "Full body. password=unsafe-value", attachments: [] } };
    throw new Error("unexpected mail operation");
  };
  const first = new MailEngine(bus, () => scope, provider);
  const bound = (await first.request(scope, "bind", { provider: "tencent", mailbox, projectId: "p", mainBotId: "bot", requestKey: "bind-first" })).connection;
  assert.equal(bound.paused, true);
  assert.equal(statSync(join(homedir(), ".hara/mail/connections.json")).mode & 0o777, 0o600);
  await first.request(scope, "start", { id: bound.id, expectedRevision: bound.revision, requestKey: "start-first" });
  await waitFor(() => first.request(scope, "list"), x => x.connections[0].phase === "error");
  first.close();
  const second = new MailEngine(bus, () => scope, provider);
  try {
    second.start();
    await waitFor(() => second.request(scope, "list"), x => x.connections[0].phase === "connected");
    assert.equal(keys.size, 1); assert.equal(calls.length, 2); assert.equal(calls[0].requestKey, calls[1].requestKey);
    assert.notEqual(calls[0].receiverId, calls[1].receiverId);
    assert.match(calls[1].body, /Untrusted mail/); assert.ok(!calls[1].body.includes("unsafe-value"));
    assert.match(calls[1].body, /Full body/);
    const state = await second.request(scope, "list"); assert.equal(state.connections[0].pendingCount, 0);
    await assert.rejects(second.request({ ...scope, spaceId: "another-space" }, "sync", { id: bound.id }), /missing|rebinding/);
    await second.request(scope, "pause", { id: bound.id, expectedRevision: state.connections[0].revision, requestKey: "pause" });
    await assert.rejects(second.request(scope, "sync", { id: bound.id }), /paused/);
    assert.ok(!readFileSync(join(homedir(), ".hara/mail/connections.json"), "utf8").includes("unsafe-value"));
  } finally { second.close(); }
});

test("Feishu bounded catch-up keeps its cursor through restart and stops on a repeated page", async () => {
  const fsScope = { profileId: "feishu-test", spaceId: "org-feishu", identityKey: "feishu-identity" }, email = "feishu@example.test";
  let binding, intake = 0, page = 0;
  const bus = async (_scope, method, path, body) => {
    if (path === "/mail-bindings" && method === "GET") return { bindings: binding ? [binding] : [] };
    if (path === "/mail-bindings") { binding = { ...body, revision: (binding?.revision || 0) + 1 }; return { binding }; }
    if (path.endsWith("/lease")) return { receiverFence: 1, expiresAt: Date.now() + 90000 };
    if (path.endsWith("/status")) return { reported: true };
    if (path === "/intake") { intake++; return { task: { id: "t_" + "b".repeat(32) } }; }
    throw new Error("unexpected route");
  };
  const provider = async (_provider, args) => {
    if (args[0] === "mail-doctor") return { ok: true, source_mailbox: email };
    if (args[0] === "mail-messages" && !args.includes("--pagination")) return { messages: [] };
    if (args[0] === "mail-messages") {
      page++;
      const after = JSON.parse(readFileSync(join(homedir(), ".hara/mail/connections.json"), "utf8")).connections[binding.id].after;
      return { messages: page === 1 ? [{ message_id: "mail_page_1", received_at: after }] : [], has_more: true, next_page_cursor: "private-page-1" };
    }
    if (args[0] === "mail-get-message") return { message: { message_id: "mail_page_1", subject: "Customer request", body: "Please investigate", from: { email: "outside@example.test" } } };
    throw new Error("unexpected provider operation");
  };
  const first = new MailEngine(bus, () => fsScope, provider);
  const c = (await first.request(fsScope, "bind", { provider: "feishu", mailbox: email, projectId: "p", mainBotId: "bot" })).connection;
  await first.request(fsScope, "start", { id: c.id, expectedRevision: 1 });
  await waitFor(() => first.request(fsScope, "list"), x => x.connections[0].phase === "connected"); first.close();
  assert.equal(intake, 1);
  const second = new MailEngine(bus, () => fsScope, provider);
  try {
    await assert.rejects(second.request(fsScope, "sync", { id: c.id }), /pagination repeated/);
    const privateState = JSON.parse(readFileSync(join(homedir(), ".hara/mail/connections.json"), "utf8")).connections[c.id];
    assert.equal(privateState.pageCursor, "private-page-1"); assert.equal(intake, 1);
    assert.ok(!(await second.request(fsScope, "list")).connections[0].pageCursor);
  } finally { second.close(); }
});

test("approved SMTP sends are journaled before the attempt and receipt recovery never resends", async () => {
  const s = { profileId: "smtp-test", spaceId: "org-smtp", identityKey: "smtp-identity" }, email = "smtp@example.test";
  let binding, sends = 0, receiptLost = true;
  const message = { id: "bm_" + "d".repeat(32), state: "queued", revision: 1, contentHash: "e".repeat(64), body: { from: email, to: ["outside@example.test"], subject: "Completed", body: "See the verified Desk result." } };
  const bus = async (_scope, method, path, body) => {
    if (path === "/mail-bindings" && method === "GET") return { bindings: binding ? [binding] : [] };
    if (path === "/mail-bindings") { binding = { ...body, revision: (binding?.revision || 0) + 1 }; return { binding }; }
    if (path.endsWith("/lease")) return { receiverFence: 1, expiresAt: Date.now() + 90000 };
    if (path.endsWith("/status")) return { reported: true };
    if (path.startsWith("/mail-outbox?")) return { messages: [message] };
    if (path.endsWith("/claim")) { message.state = "sending"; message.revision++; return { message }; }
    if (path.endsWith("/receipt")) {
      if (receiptLost) { receiptLost = false; throw new Error("receipt connection lost"); }
      message.state = body.outcome; message.revision++; return { message };
    }
    throw new Error("unexpected SMTP bus route");
  };
  const provider = async (_provider, args) => {
    if (args[0] === "mail-imap-doctor") return { ok: true, source_mailbox: email, smtp_auth: true };
    if (args[0] === "mail-imap-messages") return { messages: [], has_more: false };
    if (args[0] === "mail-smtp-send") { sends++; assert.ok(args.includes("--message-file")); assert.ok(!args.join(" ").includes("client-secret-fixture")); return { ok: true, source_mailbox: email, outcome: "sent", evidence: "SMTP accepted", message_id: "<fixture@example.test>" }; }
    throw new Error("unexpected SMTP provider operation");
  };
  const first = new MailEngine(bus, () => s, provider);
  const c = (await first.request(s, "bind", { provider: "feishu", transport: "imap-smtp", mailbox: email, password: "client-secret-fixture", projectId: "p", mainBotId: "bot", allowReplies: true })).connection;
  await first.request(s, "start", { id: c.id, expectedRevision: 1 });
  await waitFor(() => first.request(s, "list"), x => x.connections[0].phase === "error"); first.close();
  assert.equal(sends, 1);
  const second = new MailEngine(bus, () => s, provider);
  try {
    await second.request(s, "sync", { id: c.id });
    assert.equal(sends, 1); assert.equal(message.state, "sent");
    assert.ok(!JSON.stringify(await second.request(s, "list")).includes("client-secret-fixture"));
    assert.ok(!readFileSync(join(homedir(), ".hara/mail/connections.json"), "utf8").includes("client-secret-fixture"));
  } finally { second.close(); }
});

test("mail list access never substitutes for body permission when binding", async () => {
  let mutations = 0;
  const s = { profileId: "body-test", spaceId: "org-body", identityKey: "body-identity" };
  const engine = new MailEngine(async () => { mutations++; return {}; }, () => s, async (_provider, args) => {
    if (args[0] === "mail-doctor") return { ok: true, source_mailbox: "body@example.test" };
    if (args[0] === "mail-messages") return { messages: [{ message_id: "mail_body_denied" }] };
    throw new Error("mail body permission denied");
  });
  try { await assert.rejects(engine.request(s, "bind", { provider: "feishu", mailbox: "body@example.test" }), /body permission denied/); assert.equal(mutations, 0); }
  finally { engine.close(); }
});

test("fixed taskbus operation mapping rejects path injection and requires stable mutation keys", () => {
  const taskId = "t_" + "a".repeat(32);
  assert.equal(taskbusRoute("tasks.claim", { taskId, requestKey: "claim-1" }).runtime, true);
  assert.equal(taskbusRoute("projects.save", { requestKey: "project-1" }).runtime, false);
  assert.throws(() => taskbusRoute("tasks.claim", { taskId }), /requestKey/);
  assert.throws(() => taskbusRoute("tasks.get", { taskId: "../agents" }), /taskId/);
  assert.throws(() => taskbusRoute("https://other.example"), /unsupported/);
  assert.throws(() => taskbusRoute("tasks.create", { requestKey: "x", body: "x".repeat(65000) }), /64 KB/);
});

test("saved mailbox passwords are reused only for the same enrolled host and verified servers", async () => {
  let current = { profileId: "reuse-test", spaceId: "org-reuse", identityKey: "reuse-original" };
  const email = "reuse@example.test";
  const servers = { imapHost: "imap.example.test", imapPort: 993, imapSecurity: "tls", smtpHost: "smtp.example.test", smtpPort: 465, smtpSecurity: "tls" };
  let binding, providerCalls = 0;
  const engine = new MailEngine(async (_scope, method, _path, body) => {
    if (method === "GET") return { bindings: binding ? [binding] : [] };
    return { binding: binding = { ...body, revision: (binding?.revision || 0) + 1 } };
  }, () => current, async (_provider, args) => {
    providerCalls++;
    if (args[0] === "mail-imap-doctor") return { ok: true, source_mailbox: email };
    return { messages: [] };
  });
  try {
    const input = { mailbox: email, servers, projectId: "p", mainBotId: "bot", password: "reuse-private-fixture" };
    await engine.request(current, "bind", input);
    const verifiedCalls = providerCalls;
    await assert.rejects(engine.request(current, "bind", { ...input, password: "", servers: { ...servers, smtpHost: "changed.example.test" }, expectedRevision: 1 }), /explicit.*password|password.*again/i);
    assert.equal(providerCalls, verifiedCalls, "no saved password reaches changed endpoints");
    assert.equal(binding.revision, 1);
    await engine.request(current, "bind", { ...input, password: "", expectedRevision: 1 });
    assert.equal(binding.revision, 2, "unchanged verified account remains convenient to reuse");
    current = { ...current, identityKey: "reuse-new-enrollment" };
    const beforeIdentityChange = providerCalls;
    await assert.rejects(engine.request(current, "bind", { ...input, password: "", expectedRevision: 2 }), /explicit.*password|password.*again/i);
    assert.equal(providerCalls, beforeIdentityChange);
  } finally { engine.close(); }
});

test("an empty-inbox body check becomes verified only after a matching body is received", async () => {
  const s = { profileId: "first-body", spaceId: "org-first-body", identityKey: "first-body" };
  const email = "first-body@example.test";
  let binding, available = false;
  const engine = new MailEngine(async (_scope, method, path, body) => {
    if (path === "/mail-bindings" && method === "GET") return { bindings: binding ? [binding] : [] };
    if (path === "/mail-bindings") return { binding: binding = { ...body, revision: (binding?.revision || 0) + 1 } };
    if (path.endsWith("/lease")) return { receiverFence: 1, expiresAt: Date.now() + 90000 };
    if (path.endsWith("/status")) return { reported: true };
    if (path === "/intake") return { task: { id: "t_" + "f".repeat(32) } };
    throw new Error("unexpected first-body route");
  }, () => s, async (_provider, args) => {
    if (args[0] === "mail-doctor") return { ok: true, source_mailbox: email };
    if (args[0] === "mail-messages") return { messages: available ? [{ message_id: "first-body-message", received_at: new Date().toISOString() }] : [], has_more: false };
    if (args[0] === "mail-get-message") return { message: { message_id: "first-body-message", body: "A real body fixture" } };
    throw new Error("unexpected first-body provider call");
  });
  try {
    const c = (await engine.request(s, "bind", { provider: "feishu", mailbox: email, projectId: "p", mainBotId: "bot" })).connection;
    assert.equal(c.checks.body, "empty-inbox");
    available = true;
    await engine.request(s, "start", { id: c.id, expectedRevision: 1 });
    const state = await waitFor(() => engine.request(s, "list"), x => x.connections[0].phase === "connected");
    assert.equal(state.connections[0].checks.body, "verified");
  } finally { engine.close(); }
});

test("pausing while an outgoing claim is in flight prevents a new SMTP attempt", async () => {
  const s = { profileId: "pause-send", spaceId: "org-pause-send", identityKey: "pause-send" };
  const email = "pause-send@example.test";
  let binding, sends = 0, engine;
  const outgoing = { id: "bm_" + "9".repeat(32), state: "queued", revision: 1, contentHash: "8".repeat(64), body: { from: email, to: ["recipient@example.test"], subject: "Fixture", body: "Do not send after pause" } };
  engine = new MailEngine(async (_scope, method, path, body) => {
    if (path === "/mail-bindings" && method === "GET") return { bindings: binding ? [binding] : [] };
    if (path === "/mail-bindings") return { binding: binding = { ...body, revision: (binding?.revision || 0) + 1 } };
    if (path.endsWith("/lease")) return { receiverFence: 1, expiresAt: Date.now() + 90000 };
    if (path.endsWith("/status")) return { reported: true };
    if (path.startsWith("/mail-outbox?")) return { messages: [outgoing] };
    if (path.endsWith("/claim")) {
      await engine.request(s, "pause", { id: binding.id, expectedRevision: binding.revision });
      outgoing.state = "sending"; outgoing.revision++;
      return { message: outgoing };
    }
    if (path.endsWith("/receipt")) return { message: outgoing };
    throw new Error("unexpected paused-send route");
  }, () => s, async (_provider, args) => {
    if (args[0] === "mail-imap-doctor") return { ok: true, source_mailbox: email };
    if (args[0] === "mail-imap-messages") return { messages: [], has_more: false };
    if (args[0] === "mail-smtp-send") { sends++; return { ok: true, source_mailbox: email, outcome: "sent" }; }
    throw new Error("unexpected paused-send provider call");
  });
  try {
    const c = (await engine.request(s, "bind", { provider: "feishu", transport: "imap-smtp", mailbox: email, password: "paused-send-private", projectId: "p", mainBotId: "bot", allowReplies: true })).connection;
    await engine.request(s, "start", { id: c.id, expectedRevision: 1 });
    await waitFor(() => engine.request(s, "list"), x => x.connections[0].paused && ["connected", "error"].includes(x.connections[0].phase));
    assert.equal(sends, 0);
  } finally { engine.close(); }
});
