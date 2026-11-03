import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import {
  findSessionChatIn,
  agentDisplayName,
  agentKindSchema,
  type AgentSender,
} from './chatAgentLinks';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import { appendEvent, EXCHANGES_LOG_NAME } from '../agentMesh/exchangeLog';
import { retainVerdict, verdictEventId } from '../agentMesh/verdictArtifact';
import { writeFileAtomicSync } from '../util/atomicWrite';
import { getLogger } from '../util/logger';
import type { AskAgentRuntime } from './askAgentService';
import { deliverAgentReply } from './askAgentService';

const log = getLogger();

/** The fields every event of one relay carries, shared by its `created`,
 *  `accepted`, `started`, `verdict` and `cancelled` rows. */
interface RelayIdentity {
  exchangeId: string;
  workspace: string;
  conversation: string;
  from: string;
  senderSessionId: string;
  to: string;
  type: string;
}

interface RelayLogPaths {
  log: string;
  lock: string;
}

/** A relay this window started and that has not settled: the ask it put in
 *  flight, and the signal a steer can withdraw it through. Keyed by
 *  (chat, agent kind) — exactly the pair `forge.sh steer <name> <agent>`
 *  names, because a relay is addressed by the sender's chat, not by its name. */
interface InFlightRelay {
  conversationId: string;
  target: AgentSender['kind'];
  exchangeId: string;
  controller: AbortController;
  logPaths: RelayLogPaths;
  common: RelayIdentity;
}

const inFlightRelays = new Map<string, InFlightRelay>();

function relayKey(conversationId: string, target: AgentSender['kind']): string {
  return `${conversationId}:${target}`;
}

/** How many relays this window has in flight. The plan's CI row for the
 *  registry: every way a relay can end — answered, failed, or withdrawn by a
 *  steer — has to bring this back to zero, so a later exit path that forgets
 *  the cleanup fails a test instead of holding the chat's line forever. */
export function inFlightRelayCount(): number {
  return inFlightRelays.size;
}

/** Withdraw every relay this window is holding. Called when the window's
 *  agent-bus wiring is disposed: the ask promise is abandoned there anyway,
 *  and aborting is what stops the CLI process Forge started for it. */
export function abortInFlightRelays(): void {
  for (const [, relay] of [...inFlightRelays.entries()]) {
    inFlightRelays.delete(relayKey(relay.conversationId, relay.target));
    relay.controller.abort();
  }
}

/** What every relay needs from the window: the host facade, the bus folder, the
 *  workspace the exchange log rows carry, and the runtime that delivers an
 *  answer back to the sender. */
interface RelayContext {
  getFacade(): ForgeHostFacade;
  root: string;
  workspace: string;
  runtime: AskAgentRuntime;
}

/**
 * `forge.sh send <name> <agent>`: record the exchange, then ask the recipient
 * linked to the sender's own Forge chat. The 202 confirms acceptance only; the
 * answer is retained as a verdict and, when the sender's link is still there,
 * delivered to it live.
 */
export function makeAgentToAgentRelay(
  getFacade: () => ForgeHostFacade,
  root: string,
  workspace: string,
  runtime: AskAgentRuntime,
) {
  return (sender: AgentSender, target: string, message: string, originConversation?: string) =>
    startRelay(
      { getFacade, root, workspace, runtime },
      sender,
      target,
      message,
      originConversation,
    );
}

/**
 * `forge.sh steer <name> <agent>` — "withdraw what I asked before, ask this
 * instead". The old request is this chat's in-flight relay to that agent: its
 * ask signal is aborted, which ends a Forge-run Codex or Claude turn (the CLI
 * process Forge started is terminated, and a warm app-server turn receives
 * `turn/interrupt` through that same signal). The exchange is recorded
 * `cancelled` so the log does not go on reading as work that will still
 * happen.
 *
 * Forge cannot interrupt an agent it does not run: a message already queued
 * into someone's own open Claude or Codex session is out of its hands, so the
 * answer says plainly that the earlier request was withdrawn and may still be
 * running, rather than claiming an interruption Forge did not cause.
 */
export function makeAgentToAgentSteer(
  getFacade: () => ForgeHostFacade,
  root: string,
  workspace: string,
  runtime: AskAgentRuntime,
) {
  return async (sender: AgentSender, target: string, text: string) => {
    const context = { getFacade, root, workspace, runtime };
    const conversationId = findSessionChatIn(sender.sessionId, sender.kind, (id, kind) =>
      getFacade().getAgentLink(id, kind),
    );
    if (!conversationId)
      return {
        ok: false as const,
        error: 'You are not linked to a Forge chat; message Forge with say first.',
      };
    const agent = agentKindSchema.parse(target);
    const key = relayKey(conversationId, agent);
    const previous = inFlightRelays.get(key);
    if (previous) {
      inFlightRelays.delete(key);
      previous.controller.abort();
      try {
        await appendEvent(previous.logPaths, {
          ...previous.common,
          eventId: `steered-${previous.exchangeId}`,
          ts: Date.now(),
          state: 'cancelled',
          detail: 'withdrawn by a steer from the same chat before it answered',
        });
      } catch (error) {
        // The withdrawal already happened; a log failure cannot undo it, and it
        // must not stop the steer that replaces it.
        log.error(
          `Relay ${previous.exchangeId} cancellation could not be recorded: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const result = await startRelay(context, sender, target, text);
    if (!result.ok) return result;
    return {
      ok: true as const,
      exchangeId: result.exchangeId,
      deliveredTo: result.deliveredTo,
      ...(previous
        ? {
            note:
              `The earlier request from this chat to ${agentDisplayName(agent)} (exchange ` +
              `${previous.exchangeId}) was withdrawn before it answered. A turn Forge ran was ` +
              'stopped; a message already delivered to the agent itself may still be running, ' +
              'and its verdict will still be retained.',
          }
        : {}),
    };
  };
}

async function startRelay(
  context: RelayContext,
  sender: AgentSender,
  target: string,
  message: string,
  originConversation?: string,
): Promise<{ ok: true; exchangeId: string; deliveredTo: string } | { ok: false; error: string }> {
  const { getFacade, root, workspace } = context;
  // Newest chat this window really holds, not simply `findBySession`: the
  // index is process-wide, so the session's current chat may sit in another
  // window and this one would answer "you are not linked" to a sender that is
  // linked here.
  const conversationId = findSessionChatIn(sender.sessionId, sender.kind, (id, kind) =>
    getFacade().getAgentLink(id, kind),
  );
  if (!conversationId)
    return {
      ok: false as const,
      error: 'You are not linked to a Forge chat; message Forge with say first.',
    };
  const facade = getFacade();
  const agent = agentKindSchema.parse(target);
  const chatTitle =
    facade.status().conversations.find((item) => item.id === conversationId)?.title ??
    conversationId;
  const exchangeId = randomUUID();
  const logPaths = {
    log: path.join(root, EXCHANGES_LOG_NAME),
    lock: path.join(root, 'exchanges.lock'),
  };
  fs.mkdirSync(root, { recursive: true });
  const common: RelayIdentity = {
    exchangeId,
    workspace,
    conversation: conversationId,
    from: sender.kind,
    senderSessionId: sender.sessionId,
    to: agent,
    type: 'relay',
  };
  try {
    await appendEvent(logPaths, {
      ...common,
      eventId: exchangeId,
      ts: Date.now(),
      state: 'created',
      ...(originConversation ? { originConversation } : {}),
    });
    await appendEvent(logPaths, {
      ...common,
      eventId: `accepted-${exchangeId}`,
      ts: Date.now(),
      state: 'accepted',
    });
    void completeRelay({
      ...context,
      facade,
      conversationId,
      chatTitle,
      sender,
      target: agent,
      message,
      exchangeId,
      root,
      workspace,
      logPaths,
      common,
      controller: new AbortController(),
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      log.error(`Agent relay ${exchangeId} recovery failed: ${detail}`);
      facade.showConversationNotice(conversationId, `Agent relay failed: ${detail}`);
    });
    return {
      ok: true as const,
      exchangeId,
      deliveredTo: `${agentDisplayName(agent)} link in chat ${conversationId}`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await appendEvent(logPaths, {
      ...common,
      eventId: `rejected-${exchangeId}`,
      ts: Date.now(),
      state: 'rejected',
      detail,
    });
    return { ok: false as const, error: detail };
  }
}

async function completeRelay(options: {
  facade: ForgeHostFacade;
  runtime: AskAgentRuntime;
  conversationId: string;
  chatTitle: string;
  sender: AgentSender;
  target: AgentSender['kind'];
  message: string;
  exchangeId: string;
  root: string;
  workspace: string;
  logPaths: RelayLogPaths;
  common: RelayIdentity;
  controller: AbortController;
}): Promise<void> {
  const name = agentDisplayName(options.target);
  const key = relayKey(options.conversationId, options.target);
  // Registered before the first await, so a steer that arrives in the same
  // turn as the send can still withdraw this relay instead of queuing behind it.
  inFlightRelays.set(key, {
    conversationId: options.conversationId,
    target: options.target,
    exchangeId: options.exchangeId,
    controller: options.controller,
    logPaths: options.logPaths,
    common: options.common,
  });
  try {
    await appendEvent(options.logPaths, {
      ...options.common,
      eventId: `started-${options.exchangeId}`,
      ts: Date.now(),
      state: 'started',
    });
    const result = await options.facade.askAgent(
      options.conversationId,
      { agent: options.target, message: options.message },
      options.controller.signal,
    );
    if (result.status !== 'completed' || !result.finalText.trim())
      throw new Error(result.error ?? `${name} completed without an answer.`);
    const answer = result.finalText.trim();
    const source = path.join(options.root, 'outbox', `${options.exchangeId}.verdict.md.tmp`);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    writeFileAtomicSync(source, `${answer}\n`);
    retainVerdict(options.root, source, options.exchangeId);
    // Recorded before the live delivery is awaited: the retained file is
    // readable only once this event exists, and nothing rescans the folder
    // after a crash, so a crash or a hung delivery must not come between them.
    await appendEvent(options.logPaths, {
      ...options.common,
      eventId: verdictEventId(options.exchangeId),
      ts: Date.now(),
      type: 'verdict',
      state: 'completed',
      detail: 'answer retained as verdict',
    });
    const senderLink = options.facade.getAgentLink(options.conversationId, options.sender.kind);
    let delivered = false;
    if (senderLink?.sessionId === options.sender.sessionId) {
      try {
        delivered = await deliverAgentReply(
          options.runtime,
          options.sender.kind,
          senderLink,
          `Forge (chat "${options.chatTitle}") replied:\n\n${answer}`,
          // The relay's own signal, not a fresh one: disposing this window's
          // bus wiring (or a steer) withdraws the relay, and a hung live
          // delivery used to be the one thing it could not stop. The verdict
          // is already retained and recorded before this point, so an abort
          // here loses nothing the reader cannot get back with read-verdict.
          options.controller.signal,
        );
      } catch (error) {
        if (options.controller.signal.aborted) {
          // Withdrawn while its reply was in the air: the steer already
          // recorded why (or the window is going away), so only the "not seen
          // live" line below applies — a failure notice here would claim a
          // delivery that was simply cancelled had failed.
        } else {
          options.facade.showConversationNotice(
            options.conversationId,
            `Could not deliver ${name}'s reply live: ${error instanceof Error ? error.message : String(error)}. It is available with forge.sh read-verdict ${options.exchangeId}.`,
          );
        }
      }
    }
    if (!delivered)
      options.facade.showConversationNotice(
        options.conversationId,
        `${name} replied; the answer was not seen live and is available with forge.sh read-verdict ${options.exchangeId}.`,
      );
  } catch (error) {
    if (options.controller.signal.aborted) {
      // The ask was withdrawn, not defeated: a steer aborted it after recording
      // `cancelled` for this exchange, or this window's bus wiring was disposed
      // and withdrew it. A `crashed` row here only ever got rejected by the
      // terminal-state rule, and the "relay failed" notice it came with made
      // the chat read a withdrawn request as a broken link.
      //
      // A withdrawn relay still owes the board a terminal row, because the
      // window-disposal path withdraws silently (`abortInFlightRelays` records
      // nothing) and would otherwise leave the exchange `started` until the 24 h
      // non-terminal deadline. For a steer this append is rejected as an event
      // after a terminal state, so the exchange keeps exactly one terminal row
      // — the steer's `cancelled` — and the notice is gone either way.
      try {
        await appendEvent(options.logPaths, {
          ...options.common,
          eventId: `withdrawn-${options.exchangeId}`,
          ts: Date.now(),
          state: 'cancelled',
          detail:
            'the ask was aborted before it answered (withdrawn by a steer, or the window that ran it closed)',
        });
      } catch {
        // Nothing the withdrawal can undo: the abort already happened, and a
        // log failure here must not resurrect the failure notice it replaces.
      }
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    await appendEvent(options.logPaths, {
      ...options.common,
      eventId: `crashed-${options.exchangeId}`,
      ts: Date.now(),
      state: 'crashed',
      detail,
    });
    options.facade.showConversationNotice(
      options.conversationId,
      `${name} relay failed: ${detail}`,
    );
  } finally {
    // Only drop the entry this relay put there: a steer replaced it with the
    // entry for its own relay, and clearing it unconditionally would leave the
    // new relay unaborted for the rest of the chat's line.
    if (inFlightRelays.get(key)?.exchangeId === options.exchangeId) inFlightRelays.delete(key);
  }
}
