import * as path from 'path';
import * as vscode from 'vscode';
import { busPaths, removeLegacyAliasFiles } from '../agentBus/agentBus';
import { rememberClaudeReopen } from '../agentBus/claudeReopen';
import { clearSelfWindow, setSelfWindow } from '../agentBus/selfWindow';
import { EXCHANGES_LOG_NAME } from '../agentMesh/exchangeLog';
import { setBoardContext } from '../agentMesh/meshContext';
import { AgentInbox, type InboxMessageOptions } from '../agentBus/agentInbox';
import { AgentRoutes } from '../backend/agentRoutes';
import { expandAlias } from '../config/ConfigResolver';
import type { ForgeConfig } from '../config/types';
import type { ForgeHostFacade } from '../sidebar/ForgeHostFacade';
import type { MidTurnTellDrain } from '../agent/MidTurnTellDrain';
import type { MidTurnDrainResult } from '../agent/MidTurnInbox';
import type { BusTurnEnd } from '../agentBus/agentInbox';
import { busMessageActivityText, busTarget, submitBusMessage } from './agentBusSubmission';
export { submitBusMessage } from './agentBusSubmission';
import { BusTurnWatch } from '../agentBus/busTurnWatch';
import type { RemoteRuntime } from '../remote/RemoteRuntime';
import { PendingAgentReplies } from '../agentLinks/pendingAgentReplies';
import { makeAskAgentRuntime } from '../agentLinks/askAgentRuntime';
import type { AskAgentRuntime } from '../agentLinks/askAgentService';
import { makeAgentReplyLifecycle } from '../agentLinks/agentReplyLifecycle';
import { abortInFlightRelays } from '../agentLinks/agentToAgentRelay';
import { buildAgentRouteDeps } from './agentRouteDeps';
import type { ForgeRequestOutcome } from '../sidebar/turnOutcome';
import { subscribeConversationSettled } from '../sidebar/workerChatWake';
import { getLogger } from '../util/logger';
import { unattendedConversations } from '../sidebar/unattendedConversations';

const log = getLogger();

type ReplyLifecycleHandlers = Pick<
  ReturnType<typeof makeAgentReplyLifecycle>,
  'onAgentTurnStarted' | 'onAgentTurnFinished'
>;

/** Owns the replies claimed by one running conversation until its chain settles. */
export function createAgentBusMidTurnReplies(deps: {
  inbox: AgentInbox;
  getFacade(): ForgeHostFacade;
  replyLifecycle: ReplyLifecycleHandlers;
}): {
  source(conversationId: string): Promise<MidTurnDrainResult>;
  settled(conversationId: string, outcome: ForgeRequestOutcome): Promise<void>;
  dispose(): void;
} {
  const pendingByConversation = new Map<string, InboxMessageOptions[]>();
  return {
    source: async (conversationId) => {
      const facade = deps.getFacade();
      const job = unattendedConversations.jobMeta(conversationId);
      const claimed = deps.inbox.claimMidTurn(
        conversationId,
        (options) => busTarget(facade, options?.from, options?.targetConversationId),
        {
          unattended: unattendedConversations.has(conversationId),
          ...(job ? { jobId: job.jobId } : {}),
        },
      );
      const claimedReplies = claimed.flatMap((item) =>
        item.options?.sender ? [item.options] : [],
      );
      if (claimedReplies.length) {
        const waiting = pendingByConversation.get(conversationId) ?? [];
        waiting.push(...claimedReplies);
        pendingByConversation.set(conversationId, waiting);
      }
      for (const item of claimed) {
        const options = item.options;
        if (options?.sender) await deps.replyLifecycle.onAgentTurnStarted(options);
        const text = busMessageActivityText(item.content, options?.sender);
        if (text) {
          facade.emitHostActivity?.({
            conversationId,
            ...(options?.sender ? { suppressProgress: true } : {}),
            text,
          });
        }
      }
      // A claim joins an already-running turn; it does not start a new bus turn
      // and must not create an F-08 status file of its own.
      return {
        messages: claimed.map((item) => ({
          role: 'user' as const,
          content: item.content,
          midTurn: true,
        })),
      };
    },
    settled: async (conversationId, outcome) => {
      const claimed = pendingByConversation.get(conversationId);
      if (!claimed) return;
      // ConversationTabs.close invalidates the request chain before removing its
      // tab; SendPipeline settles that chain as cancelled through this listener.
      pendingByConversation.delete(conversationId);
      const end = toBusTurnEnd(outcome);
      for (const options of claimed) {
        try {
          await deps.replyLifecycle.onAgentTurnFinished(options, end);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          log.error(`[agentMessagingSetup] claimed reply settlement failed: ${detail}`);
        }
      }
    },
    dispose: () => pendingByConversation.clear(),
  };
}

function toBusTurnEnd(outcome: ForgeRequestOutcome): BusTurnEnd {
  return outcome.kind === 'failed'
    ? {
        kind: 'failed',
        error: outcome.error,
        ...(outcome.finalText ? { finalText: outcome.finalText } : {}),
      }
    : { kind: outcome.kind, ...(outcome.finalText ? { finalText: outcome.finalText } : {}) };
}

/** What `setupAgentMessaging` hands to the window that owns it: the routes, and
 *  the one startup task that has to wait for this window's sidebar. */
export interface AgentMessagingWiring {
  routes: AgentRoutes;
  /** Finish the pending agent replies whose owning window died before it
   *  answered. Call this once, after the sidebar exists and its conversations
   *  are loaded: `recover()` judges every record against this window's chat
   *  list, and before the provider exists there is no list to read — every
   *  record then warns about a missing `getHostFacade` and none is recovered.
   *  That list is complete the moment `new SidebarProvider(...)` returns: its
   *  constructor loads it synchronously through `loadSidebarSession`, so
   *  neither a session-restore await nor `resolveWebviewView` comes before the
   *  first safe call, and a window that never opens the Forge view still
   *  recovers its replies. */
  recoverPendingReplies(): Promise<void>;
}

/**
 * Mounts inbound messaging routes and the inbox, and connects session links
 * to `ask_agent` and host-side relays. The sidebar is lazy:
 * activation may start the control server before its provider exists, so the
 * inbox waits until `getSidebar` can resolve the target chat.
 *
 * Crash recovery is not run here for the same reason: it is returned as
 * `recoverPendingReplies`, and `extension.ts` calls it once the sidebar is
 * there. Running it inside setup on 0.17.98 meant `getSidebar()` had nothing
 * to hand back, so each pending reply warned about `undefined.getHostFacade`
 * and lingered until its 24-hour expiry. One caller, in `src/extension.ts`.
 *
 * What this file owns is the window's living parts — the inbox, the turn watch,
 * the pending-reply store, the ask runtime, crash recovery — and how they are
 * disposed. Which routes exist and what each one does is
 * `buildAgentRouteDeps`'s (`src/vscode/agentRouteDeps.ts`), because that set has
 * to be buildable by a test with fakes: the client advertises verbs whose routes
 * a window never registered, and nothing caught it (audit F1).
 */
export function setupAgentMessaging(
  context: vscode.ExtensionContext,
  getSidebar: () => { getHostFacade(): ForgeHostFacade; readonly tellDrain: MidTurnTellDrain },
  getConfig: () => ForgeConfig,
  workspaceRoot: string,
  getRemoteRuntime: () => RemoteRuntime | undefined = () => undefined,
): AgentMessagingWiring {
  const paths = busPaths();
  removeLegacyAliasFiles(paths, (message) => {
    void vscode.window.showWarningMessage(message);
  });
  setBoardContext({
    root: paths.root,
    workspace: workspaceRoot,
    log: path.join(paths.root, EXCHANGES_LOG_NAME),
  });
  const pendingReplies = new PendingAgentReplies(busPaths().root);
  const askRuntime: AskAgentRuntime = makeAskAgentRuntime({ getConfig });
  const replyLifecycle = makeAgentReplyLifecycle({
    root: busPaths().root,
    workspaceRoot,
    pending: pendingReplies,
    runtime: askRuntime,
    getFacade: () => getSidebar().getHostFacade(),
    showWarning: (message) => {
      void vscode.window.showWarningMessage(message);
    },
  });
  const watch = new BusTurnWatch();
  const inbox = new AgentInbox({
    isBusy: (options?: InboxMessageOptions) => {
      if (options?.newChat) return false;
      const facade = getSidebar().getHostFacade();
      registerTellSource(); // every queued message asks this first
      return facade
        .status()
        .streamingConversationIds.includes(
          busTarget(facade, options?.from, options?.targetConversationId),
        );
    },
    // The chat a queued message will run in, so messages for another chat can
    // start while it is mid-turn. Same resolution `isBusy` and `claimMidTurn`
    // use — `busTarget` owns it, and the inbox never guesses. A `--new` message
    // has no chat yet and creates its own, so it shares no line with anything.
    laneOf: (options?: InboxMessageOptions) => {
      if (options?.newChat) return undefined;
      const facade = getSidebar().getHostFacade();
      registerTellSource();
      return busTarget(facade, options?.from, options?.targetConversationId);
    },
    submit: async (prompt, options?: InboxMessageOptions) => {
      const facade = getSidebar().getHostFacade();
      watch.attach(facade);
      await vscode.commands.executeCommand('workbench.view.extension.forge-sidebar');
      // An alias is resolved here so the chat stores the model id its picker shows.
      const model = options?.model && expandAlias(getConfig(), options.model);
      return submitBusMessage(facade, prompt, model ? { ...options, model } : options);
    },
    warn: (message) => void vscode.window.showWarningMessage(message),
    // F-08: a bus-started turn began — write its durable status file so a
    // crashed turn can be detected at the next window's startup.
    // F-08: a bus-started turn ended (success OR failure) — clear its status
    // file. The inbox calls this in a `finally`, so a normal finish never
    // leaves a stale "running" record; only a crash does, and the startup sweep
    // detects that.
    // §9 (P1): a bus-started turn just ended — successfully, or as a failure the
    // inbox is telling about. The sender gets one `finished`/`failed` line via
    // tell (which writes the board event), so there are no silent stalls. A
    // user-typed turn has no bus sender, so this never fires for it.
    ...replyLifecycle,
  });
  const claimedReplies = createAgentBusMidTurnReplies({
    inbox,
    getFacade: () => getSidebar().getHostFacade(),
    replyLifecycle,
  });
  // Let a chain that already claimed replies settle them even if this extension
  // context is disposed; process death drops the list and recover() finishes its records.
  subscribeConversationSettled(claimedReplies.settled);
  context.subscriptions.push(inbox);
  context.subscriptions.push(watch);
  // A relay this window started outlives the wiring that started it only as
  // long as its ask is still running: disposing the bus withdraws every relay
  // still in flight, which is what stops the CLI process Forge ran for it.
  context.subscriptions.push({ dispose: () => abortInFlightRelays() });
  // A chat that is mid-turn reads its waiting bus messages at the next
  // tool-round gap, the way Telegram and typed messages reach it. The sidebar
  // may not exist yet at activation, so the first busy check registers it.
  let tellSourceRegistered = false;
  const registerTellSource = (): void => {
    if (tellSourceRegistered) return;
    getSidebar().tellDrain.registerSource(
      'agent-bus',
      claimedReplies.source,
      (conversationId, callback) => {
        const facade = getSidebar().getHostFacade();
        return inbox.onClaimableMidTurnAdded(
          conversationId,
          (options) => busTarget(facade, options?.from, options?.targetConversationId),
          () => {
            const job = unattendedConversations.jobMeta(conversationId);
            return {
              unattended: unattendedConversations.has(conversationId),
              ...(job ? { jobId: job.jobId } : {}),
            };
          },
          callback,
        );
      },
    );
    tellSourceRegistered = true;
  };
  const routes = new AgentRoutes(
    buildAgentRouteDeps({
      getFacade: () => getSidebar().getHostFacade(),
      getConfig,
      workspaceRoot,
      inbox,
      watch,
      pendingReplies,
      askRuntime,
      getRemoteRuntime,
      rememberClaudeReopen: (sessionId) => rememberClaudeReopen(context.workspaceState, sessionId),
      isFocused: () => vscode.window.state.focused,
    }),
  );
  // This window's own address on the bus, for a chat that talks to a peer
  // window: the bus folder, this window's id, and the folder it is open on. The
  // id exists nowhere else, and the tool layer cannot reach this file.
  setSelfWindow({ busRoot: paths.root, windowId: routes.windowId, workspaceRoot });
  context.subscriptions.push({ dispose: () => clearSelfWindow(routes.windowId) });
  context.subscriptions.push(
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) routes.claim();
    }),
  );
  // The window's own recovery step, for the caller to run once its sidebar
  // exists. `recover()` already warns per record, so what this catch can still
  // see is a failure past that loop; a startup recovery that goes wrong is
  // never silent.
  const recoverPendingReplies = async (): Promise<void> => {
    try {
      await replyLifecycle.recover();
    } catch (error) {
      void vscode.window.showWarningMessage(
        `Forge could not recover pending agent replies: ${String(error)}`,
      );
    }
  };
  return { routes, recoverPendingReplies };
}
