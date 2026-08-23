/** Read an HTTP response body with a real streaming byte ceiling. Checking after response.text() is too
 * late: a chunked or length-less Control response could already have exhausted the process heap. */
export async function readBoundedResponseText(
  response: Response,
  maxBytes: number,
  tooLargeMessage: string,
): Promise<string> {
  const limit = Math.max(1, Math.floor(maxBytes));
  const contentLength = response.headers.get("content-length");
  const declared = contentLength === null ? undefined : Number(contentLength);
  if (declared !== undefined && Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(tooLargeMessage);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error(tooLargeMessage);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
}
