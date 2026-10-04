import * as http from 'http';

const MAX_BODY_BYTES = 256 * 1024;

export interface AgentRouteFields {
  [key: string]: unknown;
}

export class AgentRouteHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new AgentRouteHttpError(413, `body over ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Plain text with query fields, form fields, or a JSON object body. */
export async function readAgentRouteFields(
  req: http.IncomingMessage,
  url: URL,
): Promise<AgentRouteFields> {
  const body = await readBody(req);
  if ((req.headers['content-type'] ?? '').includes('application/json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new AgentRouteHttpError(400, 'invalid JSON body');
    }
    if (typeof parsed !== 'object' || parsed === null)
      throw new AgentRouteHttpError(400, 'body must be an object');
    return parsed as AgentRouteFields;
  }
  if ((req.headers['content-type'] ?? '').includes('application/x-www-form-urlencoded')) {
    const fields: AgentRouteFields = {};
    for (const [key, value] of new URLSearchParams(body)) {
      if (Object.hasOwn(fields, key)) {
        throw new AgentRouteHttpError(400, `duplicate field "${key}"`);
      }
      fields[key] = value;
    }
    return fields;
  }
  const fields: AgentRouteFields = { ...Object.fromEntries(url.searchParams), text: body };
  if (fields['new_chat'] === 'true') fields['new_chat'] = true;
  if (fields['new_chat'] === 'false') fields['new_chat'] = false;
  if (fields['reply_in_chat'] === 'true') fields['reply_in_chat'] = true;
  if (fields['reply_in_chat'] === 'false') fields['reply_in_chat'] = false;
  if (fields['to_running'] === 'true') fields['to_running'] = true;
  if (fields['to_running'] === 'false') fields['to_running'] = false;
  return fields;
}
