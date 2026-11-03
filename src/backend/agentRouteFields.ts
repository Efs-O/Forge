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

/** The text a route needs in the body: absent, blank, or over `max` is an error. */
export function requireText(fields: AgentRouteFields, max: number): string {
  const text = typeof fields['text'] === 'string' ? fields['text'] : undefined;
  if (!text || !text.trim()) throw new AgentRouteHttpError(400, 'text is required');
  if (text.length > max)
    throw new AgentRouteHttpError(400, `text is ${text.length} chars; the limit is ${max}`);
  return text;
}

/** Query values arrive as strings; these three route fields are read as booleans. */
function coerceFlagFields(fields: AgentRouteFields): AgentRouteFields {
  for (const key of ['new_chat', 'to_running', 'unattended'] as const) {
    if (fields[key] === 'true') fields[key] = true;
    else if (fields[key] === 'false') fields[key] = false;
  }
  return fields;
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
    // The query string carries the addressing — every bus route is named as
    // `?from=<name>&id=<id>` — and the body carries the payload. This branch
    // used to read the body alone, so a POST that claims form data with an
    // empty body (`curl -d ''`, or any client that puts its fields in the
    // query) arrived with no fields at all, and the first validation then
    // blamed `from`, the one field the request had sent (audit F7). A key in
    // both places is refused rather than guessed at, so the same rule that
    // already covers a repeated body field covers a query/body conflict.
    const fields: AgentRouteFields = { ...Object.fromEntries(url.searchParams) };
    for (const [key, value] of new URLSearchParams(body)) {
      if (Object.hasOwn(fields, key)) {
        throw new AgentRouteHttpError(400, `duplicate field "${key}"`);
      }
      fields[key] = value;
    }
    return coerceFlagFields(fields);
  }
  const fields: AgentRouteFields = { ...Object.fromEntries(url.searchParams), text: body };
  return coerceFlagFields(fields);
}
