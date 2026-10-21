/** v2 open-chat ordering and bodies, split from the smaller legacy memento. */

import type { Memento } from 'vscode';
import { z } from 'zod';
import { getLogger } from '../util/logger';
import { ConversationBodyStore } from './ConversationBodyStore';
import {
  SESSION_KEY_V1,
  SESSION_KEY_V1_CORRUPT,
  UNTITLED_TITLE,
  conversationPersistedSchema,
  newConversationId,
  sidebarSessionPersistedSchema,
  type ConversationPersisted,
  type ConversationRuntime,
  type SidebarRuntime,
  type SidebarSessionPersisted,
} from './sessionTypes';

const log = getLogger();

export const OPEN_CONVERSATIONS_KEY_V2 = 'forge.conversations.v2';

interface OpenConversationsV2 {
  activeConversationId: string;
  order: string[];
  inline: ConversationPersisted[];
}

function openConversationsV2Schema(): z.ZodType<OpenConversationsV2> {
  return z
    .object({
      activeConversationId: z.string().min(1),
      order: z.array(z.string().min(1)),
      inline: z.array(conversationPersistedSchema),
    })
    .strict();
}

/** Every persisted key is deliberately classified by the signature test. */
const OPEN_SIGNATURE_FIELDS = [
  'id',
  'title',
  'createdAt',
  'updatedAt',
  'messages',
  'agentLinks',
  'active_model',
  'cli_sessions',
  'compaction',
  'plan',
  'display_diffs',
  'active_time_ms',
  'active_started_at',
  'input_tokens',
  'output_tokens',
  'last_input_tokens',
  'last_output_tokens',
  'model_request_count',
  'tool_call_count',
] as const;

/** No persisted field currently relies on an `updatedAt`-only classification. */
const OPEN_UPDATED_AT_ONLY_FIELDS: readonly string[] = [];

type SignatureInput = ConversationRuntime | ConversationPersisted;

function lastContentLength(conversation: SignatureInput): number {
  const last = conversation.messages.at(-1);
  if (!last) return 0;
  if (typeof last.content === 'string') return last.content.length;
  if (!Array.isArray(last.content)) return 0;
  return last.content.reduce(
    (length, part) => length + (part.type === 'text' ? part.text.length : 0),
    0,
  );
}

function lastToolCallCount(conversation: SignatureInput): number {
  return conversation.messages.at(-1)?.tool_calls?.length ?? 0;
}

/**
 * Open chats add in-place fields to history's signature: the compaction
 * revision/summary size, model, most recent input size and last message shape.
 * Other persisted metadata is included too, so a save cannot skip it.
 */
function signatureFor(conversation: SignatureInput, displayDiffs: unknown): string {
  const historySignature = `${conversation.updatedAt}:${conversation.title}:${conversation.messages.length}:${JSON.stringify(conversation.agentLinks ?? {})}`;
  const compaction = conversation.compaction;
  return JSON.stringify([
    historySignature,
    conversation.id,
    conversation.createdAt,
    compaction?.summary.length ?? null,
    compaction?.generation ?? null,
    compaction?.fromIndex ?? null,
    compaction?.memoryKeys ?? null,
    compaction?.resumeNote ?? null,
    conversation.active_model ?? null,
    conversation.last_input_tokens ?? null,
    lastContentLength(conversation),
    lastToolCallCount(conversation),
    conversation.cli_sessions ?? null,
    conversation.plan ?? null,
    displayDiffs ?? null,
    conversation.active_time_ms ?? null,
    conversation.active_started_at ?? null,
    conversation.input_tokens ?? null,
    conversation.output_tokens ?? null,
    conversation.last_output_tokens ?? null,
    conversation.model_request_count ?? null,
    conversation.tool_call_count ?? null,
  ]);
}

export function openConversationSignature(conversation: ConversationRuntime): string {
  return signatureFor(conversation, conversation.displayDiffs);
}

function persistedOpenConversationSignature(conversation: ConversationPersisted): string {
  return signatureFor(conversation, conversation.display_diffs);
}

const pendingMementoWrites = new WeakMap<Memento, Promise<void>>();

/** Serialize and report memento updates shared by both session persistence modules. */
export function persistMemento(
  workspaceState: Memento,
  key: string,
  value: unknown,
): Promise<boolean> {
  const previous = pendingMementoWrites.get(workspaceState) ?? Promise.resolve();
  const pending = previous.then(() => workspaceState.update(key, value));
  const reported = pending.then(
    () => true,
    (error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      log.error(`[sessionPersistence] failed to persist ${key}: ${detail}`);
      return false;
    },
  );
  pendingMementoWrites.set(
    workspaceState,
    reported.then(() => undefined),
  );
  return reported;
}

export interface OpenConversationsLoad {
  hasSession: boolean;
  conversations: ConversationPersisted[];
  activeConversationId?: string;
  v1?: SidebarSessionPersisted;
  /** Non-open inline bodies are history fallbacks from a failed body write. */
  inlineHistory: ConversationPersisted[];
}

function isMinimalV1(session: SidebarSessionPersisted | undefined): boolean {
  return Boolean(
    session &&
    session.conversations.length === 1 &&
    session.conversations[0]!.messages.length === 0 &&
    !Object.prototype.hasOwnProperty.call(session, 'history'),
  );
}

function newerInline(
  inline: ConversationPersisted | undefined,
  disk: ConversationPersisted | undefined,
): ConversationPersisted | undefined {
  return inline && (!disk || inline.updatedAt > disk.updatedAt) ? inline : disk;
}

function uniqueInOrder(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  return ids.filter((id) => {
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export class OpenConversationsPersistence {
  private needsV1Shrink = true;
  private forceMigrationIds = new Set<string>();

  constructor(private readonly bodies?: ConversationBodyStore) {}

  /** Load v2 by order, then recover full v1 chats written by a downgraded build. */
  load(workspaceState: Memento): OpenConversationsLoad {
    const rawV1 = workspaceState.get<unknown>(SESSION_KEY_V1);
    const parsedV1 = sidebarSessionPersistedSchema.safeParse(rawV1);
    const v1 = parsedV1.success ? parsedV1.data : undefined;
    if (rawV1 !== undefined && !parsedV1.success) {
      log.error(
        `[sessionPersistence] invalid ${SESSION_KEY_V1}; keeping a quarantine copy: ${parsedV1.error.message}`,
      );
      void persistMemento(workspaceState, SESSION_KEY_V1_CORRUPT, {
        quarantinedAt: Date.now(),
        value: rawV1,
      });
    }

    const rawV2 = workspaceState.get<unknown>(OPEN_CONVERSATIONS_KEY_V2);
    const parsedV2 = openConversationsV2Schema().safeParse(rawV2);
    if (rawV2 !== undefined && !parsedV2.success) {
      log.error(`[openConversationsPersistence] invalid v2 memento: ${parsedV2.error.message}`);
    }

    const disk = this.bodies?.load(persistedOpenConversationSignature) ?? [];
    const diskById = new Map(disk.map((body) => [body.id, body]));
    this.forceMigrationIds = new Set();
    this.needsV1Shrink = rawV1 === undefined || !parsedV1.success || !isMinimalV1(v1);

    if (parsedV2.success) {
      const value = parsedV2.data;
      const order = uniqueInOrder(value.order);
      const inlineById = this.inlineById(value.inline);
      const open = new Map<string, ConversationPersisted>();
      for (const id of order) {
        const body = newerInline(inlineById.get(id), diskById.get(id));
        if (!body) {
          log.error(`[openConversationsPersistence] missing body for open conversation ${id}`);
          continue;
        }
        open.set(id, body);
      }

      // A v1 chat a downgraded build wrote or continued (the shrink had not
      // committed yet) wins over an older v2 body of the same id.
      for (const body of v1?.conversations ?? []) {
        if (body.messages.length === 0) continue;
        const current = open.get(body.id);
        if (current && body.updatedAt <= current.updatedAt) continue;
        open.set(body.id, body);
        this.forceMigrationIds.add(body.id);
        this.needsV1Shrink = true;
        inlineById.delete(body.id);
      }

      const activeId = open.has(value.activeConversationId)
        ? value.activeConversationId
        : open.keys().next().value;
      return {
        hasSession: true,
        conversations: [...open.values()],
        ...(activeId ? { activeConversationId: activeId } : {}),
        ...(v1 ? { v1 } : {}),
        inlineHistory: [...inlineById.values()].filter((body) => !open.has(body.id)),
      };
    }

    if (v1 && v1.conversations.length > 0) {
      this.forceMigrationIds = new Set(v1.conversations.map((body) => body.id));
      this.needsV1Shrink = true;
      return {
        hasSession: true,
        conversations: v1.conversations,
        activeConversationId: v1.activeConversationId,
        v1,
        inlineHistory: [],
      };
    }

    return {
      hasSession: false,
      conversations: [],
      ...(v1 ? { v1 } : {}),
      inlineHistory: [],
    };
  }

  /** Body files precede v2; removals and v1 shrink follow its successful commit. */
  save(
    workspaceState: Memento,
    session: SidebarRuntime,
    build: (conversation: ConversationRuntime) => ConversationPersisted,
    historyFallback: readonly ConversationPersisted[],
    changedId?: string,
    pruneHistory?: () => void,
  ): void {
    const openSave = this.bodies?.save(
      session.conversations,
      build,
      openConversationSignature,
      changedId,
      this.forceMigrationIds,
    );
    const openInline = openSave?.failedBodies ?? session.conversations.map(build);
    const inline = this.inlineById([...historyFallback, ...openInline]);
    const value: OpenConversationsV2 = {
      activeConversationId: session.activeConversationId,
      order: session.conversations.map((conversation) => conversation.id),
      inline: [...inline.values()],
    };
    const mementoWrite = persistMemento(workspaceState, OPEN_CONVERSATIONS_KEY_V2, value);
    void mementoWrite.then((committed) => {
      if (!committed) return;
      this.bodies?.pruneRemoved();
      pruneHistory?.();
      if (this.needsV1Shrink) void this.shrinkV1(workspaceState);
      this.forceMigrationIds.clear();
    });
  }

  private async shrinkV1(workspaceState: Memento): Promise<void> {
    const id = newConversationId();
    const now = Date.now();
    const minimal: SidebarSessionPersisted = {
      activeConversationId: id,
      conversations: [
        {
          id,
          title: UNTITLED_TITLE,
          createdAt: now,
          updatedAt: now,
          messages: [],
        },
      ],
    };
    if (await persistMemento(workspaceState, SESSION_KEY_V1, minimal)) this.needsV1Shrink = false;
  }

  private inlineById(bodies: readonly ConversationPersisted[]): Map<string, ConversationPersisted> {
    const byId = new Map<string, ConversationPersisted>();
    for (const body of bodies) {
      const current = byId.get(body.id);
      if (!current || body.updatedAt > current.updatedAt) byId.set(body.id, body);
    }
    return byId;
  }
}

const inlineOnlyPersistence = new WeakMap<Memento, OpenConversationsPersistence>();

/** Share in-memory migration state for workspaces without a storage directory. */
export function openConversationsPersistenceFor(
  workspaceState: Memento,
  persistent?: OpenConversationsPersistence,
): OpenConversationsPersistence {
  if (persistent) return persistent;
  let current = inlineOnlyPersistence.get(workspaceState);
  if (!current) {
    current = new OpenConversationsPersistence();
    inlineOnlyPersistence.set(workspaceState, current);
  }
  return current;
}

/** Kept explicit so the schema-coverage test can enforce future additions. */
export function openConversationSignatureFields(): readonly string[] {
  return OPEN_SIGNATURE_FIELDS;
}

export function openConversationUpdatedAtOnlyFields(): readonly string[] {
  return OPEN_UPDATED_AT_ONLY_FIELDS;
}
