// hara gateway flows — user-configured rules that intercept inbound gateway messages and route matching
// ones to an agent task + a delivery target, instead of the gateway's default DM-driver reply. This turns
// any chat gateway (Telegram / WeChat / Feishu / Slack / …) into an automation trigger: "when a message
// matching <trigger> arrives, run <agent task> and deliver the result to <target>".
//
// Opt-in: config lives in the user's ~/.hara/flows.json — no file, no flows (zero behaviour change).
// Platform-agnostic: matching only reads the generic InboundMsg fields each adapter populates (chatType,
// mentions), so a flow works on whatever platform surfaces the data it asks for.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { InboundMsg } from "./telegram.js";
import { deliverResult } from "../cron/deliver.js";

export interface FlowRule {
  name: string;
  enabled?: boolean;
  /** Trigger predicate — every present field must match (AND). Omit a field to leave it unconstrained. */
  on?: {
    platform?: string; // "feishu" | "telegram" | … — omit for any platform
    chat?: string | string[]; // chatId allowlist — omit for any chat
    chatType?: "p2p" | "group" | "any"; // require a DM or a group
    mention?: "self" | "any" | string | string[]; // "self" = the bot was @-mentioned; or specific user id(s)
    keyword?: string | string[]; // message text must contain one of these
  };
  do: string; // the agent task (prompt) to run on a match
  guard?: string; // optional constraint appended to the prompt (e.g. "propose only, don't act")
  deliver?: string; // where to send the agent's output: telegram:<id> | feishu:<id> | weixin:owner | webhook:<url>
  reply?: boolean; // also reply in the originating chat (default false)
}

const asArray = (v?: string | string[]): string[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

/** Load ~/.hara/flows.json — accepts a bare array or `{ "flows": [...] }`. Missing/malformed → [] (never throws). */
export function loadFlows(): FlowRule[] {
  try {
    const parsed = JSON.parse(readFileSync(join(homedir(), ".hara", "flows.json"), "utf8"));
    const flows = Array.isArray(parsed) ? parsed : parsed?.flows;
    return Array.isArray(flows) ? flows.filter((f: any) => f && f.enabled !== false && f.name && f.do) : [];
  } catch {
    return [];
  }
}

/** Pure predicate: does message `m` on `platform` satisfy rule `r`'s trigger? */
export function matchFlow(r: FlowRule, m: InboundMsg, platform: string): boolean {
  const on = r.on ?? {};
  if (on.platform && on.platform.toLowerCase() !== platform.toLowerCase()) return false;
  const chats = asArray(on.chat);
  if (chats.length && !chats.includes(String(m.chatId))) return false;
  if (on.chatType && on.chatType !== "any") {
    if (!m.chatType || m.chatType !== on.chatType) return false; // rule wants a specific kind the adapter didn't confirm
  }
  if (on.mention && on.mention !== "any") {
    const ms = m.mentions ?? [];
    if (on.mention === "self") {
      if (!ms.some((x) => x.isSelf)) return false;
    } else {
      const want = asArray(on.mention);
      if (!ms.some((x) => x.id && want.includes(x.id))) return false;
    }
  }
  const kws = asArray(on.keyword);
  if (kws.length && !kws.some((k) => (m.text ?? "").includes(k))) return false;
  return true;
}

/** Compose the agent prompt for a matched flow (English scaffolding; the user's do/guard carry the intent). */
export function buildFlowPrompt(r: FlowRule, m: InboundMsg): string {
  return (
    r.do +
    (r.guard ? `\n\nConstraint: ${r.guard}` : "") +
    `\n\n--- Triggering message ---\nchat ${m.chatId}${m.chatType ? ` (${m.chatType})` : ""} · from ${m.userName || m.userId}\n${m.text}`
  );
}

/** Try to handle `m` via configured flows. Returns true if ≥1 rule matched (caller should STOP default routing).
 *  The agent run + delivery are fire-and-forget so a slow LLM call never blocks the gateway's event loop.
 *  `runAgent` runs the prompt (injected by the gateway so we reuse its session/env plumbing); `reply` (optional)
 *  sends text back to the originating chat. */
export async function dispatchFlows(
  m: InboundMsg,
  platform: string,
  runAgent: (prompt: string) => Promise<string>,
  reply?: (text: string) => Promise<void>,
): Promise<boolean> {
  const matched = loadFlows().filter((r) => matchFlow(r, m, platform));
  if (!matched.length) return false;
  for (const r of matched) {
    console.error(`hara flow: "${r.name}" matched · ${platform} ${m.chatType ?? "?"} ${m.chatId}`);
    void (async () => {
      try {
        const output = (await runAgent(buildFlowPrompt(r, m))).trim();
        if (!output) return;
        if (r.deliver) {
          const err = await deliverResult(r.deliver, output);
          if (err) console.error(`hara flow "${r.name}": deliver failed — ${err}`);
        }
        if (r.reply && reply) await reply(output).catch(() => {});
      } catch (e) {
        console.error(`hara flow "${r.name}": ${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }
  return true;
}
