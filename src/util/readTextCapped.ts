export interface CappedTextResult {
  text: string;
  bytesRead: number;
  truncated: boolean;
}

/** Read no more than maxBytes and cancel the stream when additional bytes exist. */
export async function readTextCapped(
  response: Response,
  maxBytes: number,
): Promise<CappedTextResult> {
  const body = response.body;
  if (!body) return { text: '', bytesRead: 0, truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = Math.max(0, maxBytes - total);
    if (value.byteLength > remaining) {
      if (remaining > 0) chunks.push(value.subarray(0, remaining));
      total += remaining;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return {
    text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'),
    bytesRead: total,
    truncated,
  };
}
