import { createHash } from "node:crypto";
import { UUID } from "./local-state.js";

/** Channel sessions never alias an Agent's private conversation or another channel. */
export function channelSessionId(channelId: string, participant: string): string {
  if (!UUID.test(channelId)) throw new Error("invalid local channel identity");
  const hex = createHash("sha256").update(JSON.stringify(["hara-local-channel-v1", channelId, participant])).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
