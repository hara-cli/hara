import { exact, hubAssert, plain } from "./errors.js";
import { HUB_LIMITS, sha256, type HubAttachment } from "./attachments.js";
import type { AgentHubBoundaryContract, HubStoredAttachment, HubStoredMessage } from "./contracts.js";
export const HUB_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HEX = /^[a-f0-9]{64}$/;
const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", md: "text/markdown", txt: "text/plain", pdf: "application/pdf" };
export const textPreview = (text: string) => Array.from(text.replace(/\s+/gu, " ")).slice(0, 160).join("");
export function attachmentFacts(value: Omit<HubAttachment, "base64">): Omit<HubAttachment, "base64"> {
  return { name: value.name, mime: value.mime, bytes: value.bytes, sha256: value.sha256, preview: value.preview,
    ...(value.width !== undefined ? { width: value.width, height: value.height } : {}) };
}
export const payloadDigest = (textHash: string, attachments: Omit<HubAttachment, "base64">[]) => sha256(JSON.stringify({ textSha256: textHash, attachments: attachments.map(attachmentFacts) }));
export function storedAttachments(key: string, values: HubAttachment[]): HubStoredAttachment[] {
  return values.map((value, index) => ({ ...attachmentFacts(value), attachmentId: sha256(`${key}:${index}:${value.sha256}`),
    fileId: `attachment-${key}-${index}.bin`, state: "available" }));
}
/** Bounded metadata parser. It never opens a text body or attachment, nor decodes base64. */
export function parseHubMetadata<S>(text: string, key: string, boundary: Pick<AgentHubBoundaryContract<S, unknown>, "isExternalSource">): HubStoredMessage<S> {
  hubAssert(Buffer.byteLength(text) <= HUB_LIMITS.metadataBytes, "store_unavailable");
  const value: unknown = JSON.parse(text);
  hubAssert(plain(value) && exact(value, ["schema", "messageId", "requestId", "connectionId", "digest", "source", "receivedAt", "text", "attachments"])
    && value.schema === 2 && typeof value.messageId === "string" && HUB_UUID.test(value.messageId)
    && typeof value.connectionId === "string" && HUB_UUID.test(value.connectionId) && typeof value.requestId === "string" && HUB_UUID.test(value.requestId)
    && typeof value.digest === "string" && HEX.test(value.digest) && boundary.isExternalSource(value.source)
    && typeof value.receivedAt === "string" && Number.isFinite(Date.parse(value.receivedAt))
    && plain(value.text) && exact(value.text, ["fileId", "bytes", "sha256", "preview"])
    && value.text.fileId === `body-${key}.bin` && Number.isSafeInteger(value.text.bytes) && Number(value.text.bytes) >= 0 && Number(value.text.bytes) <= HUB_LIMITS.textBytes
    && typeof value.text.sha256 === "string" && HEX.test(value.text.sha256) && typeof value.text.preview === "string"
    && Array.from(value.text.preview).length <= 160 && Buffer.from(value.text.preview).toString("utf8") === value.text.preview
    && Array.isArray(value.attachments) && value.attachments.length <= HUB_LIMITS.files
    && key === sha256(`${value.connectionId}:${value.requestId}`), "store_unavailable");
  let total = 0;
  for (let index = 0; index < value.attachments.length; index++) {
    const row = value.attachments[index];
    hubAssert(plain(row) && typeof row.name === "string" && row.name.length > 0 && row.name.length <= 160
      && !row.name.startsWith(".") && !/[\\/:\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(row.name)
      && MIME[row.name.split(".").at(-1)!.toLowerCase()] === row.mime
      && Number.isSafeInteger(row.bytes) && Number(row.bytes) > 0 && Number(row.bytes) <= HUB_LIMITS.fileBytes
      && typeof row.sha256 === "string" && HEX.test(row.sha256)
      && row.attachmentId === sha256(`${key}:${index}:${row.sha256}`) && row.fileId === `attachment-${key}-${index}.bin`
      && ["available", "expired"].includes(row.state as string), "store_unavailable");
    const image = String(row.mime).startsWith("image/");
    hubAssert(exact(row, ["name", "mime", "bytes", "sha256", "preview", ...(image ? ["width", "height"] : []), "attachmentId", "fileId", "state"])
      && row.preview === (image ? "quarantined" : "none"), "store_unavailable");
    if (image) hubAssert(Number.isSafeInteger(row.width) && Number.isSafeInteger(row.height) && Number(row.width) > 0 && Number(row.height) > 0
      && Number(row.width) <= HUB_LIMITS.dimension && Number(row.height) <= HUB_LIMITS.dimension && Number(row.width) * Number(row.height) <= HUB_LIMITS.pixels, "store_unavailable");
    total += Number(row.bytes);
  }
  hubAssert(total <= HUB_LIMITS.attachmentBytes && payloadDigest(value.text.sha256, value.attachments as unknown as HubStoredAttachment[]) === value.digest, "store_unavailable");
  return value as unknown as HubStoredMessage<S>;
}
