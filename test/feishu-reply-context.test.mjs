import test from "node:test";
import assert from "node:assert/strict";
import { feishuEventToInbound, feishuReplyContext } from "../dist/gateway/feishu.js";

test("Feishu reply ancestry preserves exact parent, root and thread without treating text as routing", () => {
  assert.equal(feishuReplyContext({ text: "reply to om_other" }), undefined);
  assert.equal(feishuReplyContext({ parent_id: "", root_id: null }), undefined);
  assert.deepEqual(feishuReplyContext({ parent_id: "om_parent", root_id: "om_root", thread_id: "omt_thread" }), {
    valid: true, parentMessageId: "om_parent", rootMessageId: "om_root", threadId: "omt_thread",
  });
  for (const bad of [123, {}, ["om_other"], "om_other\n", " ../other", "x".repeat(257)]) {
    assert.deepEqual(feishuReplyContext({ parent_id: bad, root_id: "om_root" }), { valid: false, rootMessageId: "om_root" });
  }
});

test("actual event conversion retains ancestry and app/user provenance through a private spool-shaped payload", async () => {
  for (const senderType of ["user", "app", "unknown"]) {
    const payload = JSON.parse(JSON.stringify({
      sender: { sender_id: { open_id: "ou_sender" }, sender_type: senderType },
      message: { chat_id: "oc_chat", chat_type: "group", message_id: "om_new", parent_id: "om_parent",
        root_id: "om_root", thread_id: "omt_thread", create_time: "1800000000000", message_type: "text", content: JSON.stringify({ text: "follow up" }) },
    }));
    const message = await feishuEventToInbound(async () => { throw new Error("no media fetch authorized"); },
      payload, "ou_bot", new AbortController().signal);
    assert.equal(message.senderType, senderType);
    assert.equal(message.messageId, "om_new");
    assert.equal(message.durablyQueued, true);
    assert.deepEqual(message.replyContext, { valid: true, parentMessageId: "om_parent", rootMessageId: "om_root", threadId: "omt_thread" });
    assert.equal(message.text, "follow up");
  }
});
