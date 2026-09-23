import * as fs from 'fs';
import type * as http from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import { BUS_ID_PATTERN, ensureBus, writeReply, type BusPaths } from '../agentBus/agentBus';
import { MAX_INBOUND_CHARS, forgeInboundPrompt } from '../agentBus/busContent';
import { parseMeshCommand } from '../agentMesh/meshCommands';
import type { AgentInbox, InboxMessageOptions } from '../agentBus/agentInbox';
import { sendJson, sendText } from './controlHttp';
import { getLogger } from '../util/logger';

const log = getLogger();

/** An answer may be longer than a new message: it is what Forge asked for. */
export const MAX_REPLY_CHARS = 32_000;
const MAX_BODY_BYTES = 256 * 1024;
const FROM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

export type BusReadResult =
  | { ok: true; text: string }
  | { ok: false; status: 400 | 404; error: string };

export interface AgentRoutesDeps {
  paths: () => BusPaths;
  inbox: Pick<AgentInbox, 'accept' | 'cancel'>;
  /** Injected by tests; production mints one per activation. */
  token?: string;
  /**
   * The host-side relay (AGENT_MESH_PLAN M6). When an inbound message names a
   * `to` that is not Forge, the host forwards it through the recipient's
   * adapter with zero Forge model turns. Absent ⇒ a non-Forge `to` is rejected
   * (not silently delivered to the Forge inbox).
   */
  relay?: (
    from: string,
    to: string,
    text: string,
  ) => Promise<{ ok: true; exchangeId: string } | { ok: false; error: string }>;
  /**
   * F-06: a `priority=steer` message to another agent interrupts its active
   * turn and runs the steer next. Absent ⇒ `priority=steer` is treated as an
   * ordinary relay (the field is ignored).
   */
  steer?: (
    from: string,
    to: string,
    text: string,
  ) => Promise<{ ok: true; exchangeId: string } | { ok: false; error: string }>;
  /**
   * Validate an inbound `from` against live aliases (M6/§4). An unknown or
   * forged sender is rejected with the live list. Absent ⇒ shape check only.
   */
  validateFrom?: (
    from: string,
  ) =>
    | { ok: true }
    | { ok: false; error: string }
    | Promise<{ ok: true } | { ok: false; error: string }>;
  /**
   * Dispatch a typed lifecycle command (§8, P3). When an inbound `to: forge`
   * message parses as a mesh command (`standby codex`, `close codex`, …), it is
   * dispatched here and the reply is written to the sender's inbox — not queued
   * as an ordinary prompt. Absent ⇒ the text is treated as an ordinary message.
   */
  handleCommand?: (
    text: string,
  ) => Promise<{ ok: true; reply: string } | { ok: false; error: string }>;
  /**
   * §10: `forge.sh join claude` — a user-opened session registers itself as an
   * alias by its pid. Absent ⇒ `/agent/join` is 404.
   */
  /**
   * §6: a `priority=steer` message to Forge itself interrupts Forge's active
   * turn (same as Telegram `/steer`); the steer is queued first, so it runs
   * next. Absent ⇒ a steer to Forge queues like any message.
   */
  interruptForge?: () => Promise<void>;
  join?: (alias: string, pid: number) => { ok: true; reply: string } | { ok: false; error: string };
  /**
   * §11: `forge.sh who` — read-only projection of every mesh participant and
   * its state (attachment × activity). The host owns the truth (it reads the
   * alias table, ownership records and the in-memory FIFO); the client only
   * formats. Absent ⇒ `GET /agent/who` is 404.
   */
  who?: () => Promise<unknown> | unknown;
  /** Read-only view of the sender's chat; absent means the route is 404. */
  status?: (from: string) => BusReadResult | Promise<BusReadResult>;
  view?: (from: string, count: string | undefined) => BusReadResult | Promise<BusReadResult>;
  /** Configured model names used to validate an inbound message's model. */
  configuredModels?: () => readonly string[];
}

interface Fields {
  [key: string]: unknown;
}

const AgentMessageOptionsSchema = z.object({
  model: z.string().trim().min(1).optional(),
  new_chat: z.boolean().optional(),
});

class HttpError extends Error {
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
        reject(new HttpError(413, `body over ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Plain text with the fields in the query (what `forge.sh` sends), or JSON. */
async function readFields(req: http.IncomingMessage, url: URL): Promise<Fields> {
  const body = await readBody(req);
  if ((req.headers['content-type'] ?? '').includes('application/json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new HttpError(400, 'invalid JSON body');
    }
    if (typeof parsed !== 'object' || parsed === null)
      throw new HttpError(400, 'body must be an object');
    return parsed as Fields;
  }
  const fields: Fields = { ...Object.fromEntries(url.searchParams), text: body };
  if (fields['new_chat'] === 'true') fields['new_chat'] = true;
  if (fields['new_chat'] === 'false') fields['new_chat'] = false;
  return fields;
}

function requireText(fields: Fields, max: number): string {
  const text = typeof fields['text'] === 'string' ? fields['text'] : undefined;
  if (!text || !text.trim()) throw new HttpError(400, 'text is required');
  if (text.length > max)
    throw new HttpError(400, `text is ${text.length} chars; the limit is ${max}`);
  return text;
}

function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'message'}: ${issue.message}`)
    .join('; ');
}

/**
 * The inbound half of agent messaging (docs/plans/AGENT_MESSAGING_PLAN.md), on
 * the control server:
 *   POST /agent/message {from, text}  → 202 {queued, id}  (a visible Forge turn)
 *   POST /agent/cancel  {from, id}    → 200 {cancelled} (withdraw a queued message)
 *   POST /agent/reply   {id, text}    → 200 {delivered} (answers ask_live_session)
 *   POST /agent/join    {alias, pid}  → 200 {joined}    (AGENT_MESH_PLAN §10)
 *   GET /agent/status   ?from         → 200 text (the sender's chat, now)
 *   GET /agent/view     ?from&count   → 200 text (its last answers)
 * These are the first control routes that put text in front of the model, so
 * they need the bearer token from endpoint.json; the model routes do not.
 */
export class AgentRoutes {
  readonly token: string;
  private url: string | undefined;
  /** `agent_bus.enabled`, pushed by the control server that owns the config. */
  private enabled = false;

  constructor(private readonly deps: AgentRoutesDeps) {
    this.token = deps.token ?? randomBytes(32).toString('hex');
  }

  /** The control server is listening at `url`: publish the endpoint. */
  onListening(url: string): void {
    this.url = url;
    this.refresh();
  }

  /** Follow `agent_bus.enabled`: publish or withdraw endpoint.json. */
  setEnabled(on: boolean): void {
    this.enabled = on;
    this.refresh();
  }

  private refresh(): void {
    try {
      if (this.url && this.enabled) this.publish(this.url);
      else this.withdraw();
    } catch (err) {
      log.error('[agentRoutes] could not update endpoint.json', err);
    }
  }

  dispose(): void {
    this.url = undefined;
    this.withdraw();
  }

  async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const route = url.pathname;
    const known =
      route === '/agent/message' ||
      route === '/agent/reply' ||
      route === '/agent/cancel' ||
      (route === '/agent/join' && !!this.deps.join) ||
      (route === '/agent/who' && !!this.deps.who) ||
      (route === '/agent/status' && !!this.deps.status) ||
      (route === '/agent/view' && !!this.deps.view);
    if (!this.enabled || !known) {
      return sendJson(res, 404, { error: `no route for ${req.method ?? 'GET'} ${route}` });
    }
    if (!this.authorized(req.headers.authorization)) {
      return sendJson(res, 401, {
        error:
          'missing or stale token: read it from endpoint.json (it changes when Forge restarts)',
      });
    }
    // §11: the one GET route. Read-only: it returns the participant projection
    // and touches no other route's state.
    if (route === '/agent/who') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' });
      const participants = await this.deps.who?.();
      return sendJson(res, 200, { participants });
    }
    if (route === '/agent/status' || route === '/agent/view') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' });
      const from = (url.searchParams.get('from') ?? '').trim();
      if (!FROM_PATTERN.test(from)) {
        return sendJson(res, 400, {
          error: 'from must be 1-40 chars: letters, digits, space . _ -',
        });
      }
      const sender = await this.deps.validateFrom?.(from);
      if (sender && !sender.ok) return sendJson(res, 400, { error: sender.error });
      const result =
        route === '/agent/status'
          ? await this.deps.status?.(from)
          : await this.deps.view?.(from, url.searchParams.get('count') ?? undefined);
      if (!result) return sendJson(res, 404, { error: `no route for GET ${route}` });
      if (result.ok) return sendText(res, 200, result.text);
      return sendJson(res, result.status, { error: result.error });
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST only' });
    try {
      const fields = await readFields(req, url);
      if (route === '/agent/join' && this.deps.join) {
        const alias = (typeof fields['alias'] === 'string' ? fields['alias'] : '')
          .trim()
          .toLowerCase();
        const pid = Number(fields['pid'] ?? '');
        const joined = this.deps.join(alias, pid);
        if (!joined.ok) throw new HttpError(400, joined.error);
        return sendJson(res, 200, { joined: true, reply: joined.reply });
      }
      if (route === '/agent/reply') {
        const id = typeof fields['id'] === 'string' ? fields['id'] : '';
        if (!BUS_ID_PATTERN.test(id)) throw new HttpError(400, 'id must be the question id');
        writeReply(this.deps.paths(), id, requireText(fields, MAX_REPLY_CHARS));
        return sendJson(res, 200, { delivered: true });
      }
      const from = (typeof fields['from'] === 'string' ? fields['from'] : '').trim();
      if (!FROM_PATTERN.test(from)) {
        throw new HttpError(400, 'from must be 1-40 chars: letters, digits, space . _ -');
      }
      // M6/§4: an unknown or forged sender is rejected with the live list.
      const sender = await this.deps.validateFrom?.(from);
      if (sender && !sender.ok) throw new HttpError(400, sender.error);
      if (route === '/agent/cancel') {
        const id = (typeof fields['id'] === 'string' ? fields['id'] : '').trim();
        if (!id) throw new HttpError(400, 'id is required: a queued message id, or all');
        const cancelled = this.deps.inbox.cancel(from, id);
        if (cancelled === 0) {
          throw new HttpError(
            404,
            id === 'all'
              ? `no queued messages from "${from}"`
              : `no queued message ${id} from "${from}": unknown, already started, or not yours`,
          );
        }
        return sendJson(res, 200, { cancelled });
      }
      // M6: an inbound message addressed to another agent (to != forge) is
      // relayed by the host through the recipient's adapter, with zero Forge
      // model turns. The model never decides whether to relay. A non-Forge `to`
      // with no relay installed is rejected, not silently delivered to the
      // Forge inbox (which would treat a message meant for another agent as a
      // prompt for itself).
      const to = (typeof fields['to'] === 'string' ? fields['to'] : '').trim();
      if (to && to.toLowerCase() !== 'forge') {
        const text = requireText(fields, MAX_INBOUND_CHARS);
        // F-06: a `priority=steer` message interrupts the recipient's active
        // turn and runs the steer next, instead of queuing behind it.
        const isSteer =
          (typeof fields['priority'] === 'string' ? fields['priority'] : '')
            .trim()
            .toLowerCase() === 'steer';
        const deliver = isSteer && this.deps.steer ? this.deps.steer : this.deps.relay;
        if (!deliver) {
          throw new HttpError(400, `no relay available to deliver to "${to}"`);
        }
        const result = await deliver(from, to, text);
        if (!result.ok) throw new HttpError(400, result.error);
        return sendJson(res, 202, { relayed: true, exchangeId: result.exchangeId });
      }
      // §8/P3: a `to: forge` message that parses as a typed lifecycle command
      // is dispatched, not queued as a prompt. The reply goes to the sender.
      const text = requireText(fields, MAX_INBOUND_CHARS);
      if (this.deps.handleCommand) {
        const cmd = parseMeshCommand(text);
        if (cmd) {
          const result = await this.deps.handleCommand(text);
          if (!result.ok) throw new HttpError(400, result.error);
          return sendJson(res, 200, { command: cmd.verb, reply: result.reply });
        }
      }
      const steerForge =
        (typeof fields['priority'] === 'string' ? fields['priority'] : '').trim().toLowerCase() ===
          'steer' && !!this.deps.interruptForge;
      const options = this.messageOptions(fields);
      const accepted = this.deps.inbox.accept(
        forgeInboundPrompt(from, text),
        from,
        steerForge,
        options,
      );
      if (accepted === undefined)
        throw new HttpError(429, 'Forge has too many unread agent messages');
      const { position: queued, id } = accepted;
      if (steerForge) {
        await (this.deps.interruptForge as () => Promise<void>)();
        return sendJson(res, 202, { queued, id, steered: true });
      }
      return sendJson(res, 202, { queued, id });
    } catch (err) {
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.message });
      throw err;
    }
  }

  private messageOptions(fields: Fields): InboxMessageOptions {
    const parsed = AgentMessageOptionsSchema.safeParse({
      model: fields['model'],
      new_chat: fields['new_chat'],
    });
    if (!parsed.success) throw new HttpError(400, zodMessage(parsed.error));

    const validModels = [...(this.deps.configuredModels?.() ?? [])];
    if (parsed.data.model && !validModels.includes(parsed.data.model)) {
      throw new HttpError(
        400,
        `model: unknown model "${parsed.data.model}"; valid models: ${validModels.join(', ') || '(none configured)'}`,
      );
    }
    return {
      ...(parsed.data.model !== undefined ? { model: parsed.data.model } : {}),
      ...(parsed.data.new_chat !== undefined ? { newChat: parsed.data.new_chat } : {}),
    };
  }

  private authorized(header: string | undefined): boolean {
    const given = Buffer.from((header ?? '').replace(/^Bearer\s+/i, ''));
    const want = Buffer.from(this.token);
    return given.length === want.length && timingSafeEqual(given, want);
  }

  private publish(url: string): void {
    const paths = this.deps.paths();
    ensureBus(paths);
    const tmp = `${paths.endpoint}.tmp`;
    const text = `${JSON.stringify({ url, token: this.token, pid: process.pid }, null, 2)}\n`;
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, paths.endpoint);
  }

  /** Delete endpoint.json only if it is ours: another window may own it now. */
  private withdraw(): void {
    const file = this.deps.paths().endpoint;
    try {
      const current = JSON.parse(fs.readFileSync(file, 'utf8')) as { token?: unknown };
      if (current.token === this.token) fs.unlinkSync(file);
    } catch {
      // Absent or unreadable: nothing of ours to remove.
    }
  }
}
