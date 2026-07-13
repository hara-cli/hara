import { registerTool } from "./registry.js";
import { resolve } from "node:path";
import { queueOutboundSnapshot } from "../gateway/outbound-files.js";

// `send_file` — the agent's ONLY way to push a file/image to the user when running inside `hara gateway`
// (Telegram / WeChat). The gateway sets HARA_GATEWAY_OUTBOX to a per-message temp file; this tool appends the
// path there, and after the headless run ends the daemon delivers each queued file to the chat via the platform
// adapter (images inline, everything else as an attachment). It does NOT touch the desktop client — driving the
// WeChat/desktop app with the `computer` tool targets a different surface and never reaches this chat peer.
//
// Self-gated on HARA_GATEWAY: registered only in the gateway subprocess, so it never clutters normal CLI/TUI runs.
if (process.env.HARA_GATEWAY) {
  registerTool({
    name: "send_file",
    description:
      "Send a local file (image, document, audio, zip, …) to the user in the CURRENT chat. Use this whenever the " +
      "user asks you to send/share/发 a file or image. Pass an absolute path to a file that already exists (generate " +
      "it first if needed). Images are delivered inline; other files as attachments. This is the only channel that " +
      "reaches the user — do NOT use the computer tool or desktop automation to deliver files.",
    kind: "exec",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute path to the file to send." } },
      required: ["path"],
    },
    async run(input, ctx): Promise<string> {
      const outbox = process.env.HARA_GATEWAY_OUTBOX;
      if (!outbox) return "send_file only works inside `hara gateway` — there is no chat to send to here.";
      const p = resolve(ctx.cwd, String(input.path ?? ""));
      try {
        await queueOutboundSnapshot(p, outbox);
        return `Queued a private snapshot for delivery to the user in this chat: ${p}`;
      } catch (error: any) {
        if (error?.code === "ENOENT") {
          return `No such file: ${p || "(none)"} — create the file first, then call send_file with its absolute path.`;
        }
        return error instanceof Error ? error.message : `Unable to queue ${p} for delivery.`;
      }
    },
  });
}
