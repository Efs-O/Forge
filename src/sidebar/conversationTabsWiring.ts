import type * as vscode from 'vscode';
import type { CheckpointStack } from '../checkpoint/CheckpointStack';
import type { AgentLoop, SidebarProviderEvents } from './AgentLoop';
import type { ToolFailureTracker } from '../tools/StripTools';
import type { IBackendPool } from '../backend/BackendPool';
import type { RequestChainLifecycle } from './RequestChainLifecycle';
import {
  evictionBlockers,
  isConversationEvictable,
  retentionBlockState,
  type ConversationEvictionSignals,
} from './evictionGate';
import { listMemoryKeys } from '../tools/memoryTools';
import { ConversationRetentionScheduler } from './ConversationRetentionScheduler';
import { ConversationTabs } from './ConversationTabs';
import type { SidebarHost, SidebarParts } from './sidebarWiring';

interface ConversationTabsWiringDeps {
  host: SidebarHost;
  parts: SidebarParts;
  pool: IBackendPool;
  checkpoints: CheckpointStack;
  failureTracker: ToolFailureTracker;
  events: SidebarProviderEvents;
  agentLoop: AgentLoop;
  requestChains: RequestChainLifecycle;
  workspaceState: vscode.Memento;
  evictionSignals: (id: string) => ConversationEvictionSignals;
}

/** Own the scheduler/tab circular callbacks at their shared wiring seam. */
export function wireConversationTabs(deps: ConversationTabsWiringDeps): {
  tabs: ConversationTabs;
  retention: ConversationRetentionScheduler;
} {
  const { host, parts, pool, checkpoints, failureTracker, events, agentLoop, requestChains } = deps;
  const tabsRef: { current?: ConversationTabs } = {};
  const retention = new ConversationRetentionScheduler({
    getSidebar: host.getSidebar,
    setSidebar: host.setSidebar,
    persistSession: host.persistSession,
    persistSidebar: host.persistSidebar,
    post: host.post,
    blockState: (id) => retentionBlockState(deps.evictionSignals(id)),
    archiveExpired: (id, expectedAt) => tabsRef.current?.archiveExpired(id, expectedAt) ?? false,
    onInvalidSetting: (message) => host.post({ type: 'error', message }),
  });
  const tabs = new ConversationTabs({
    liveMemoryKeys: () => listMemoryKeys(deps.workspaceState),
    isStreaming: () => agentLoop.streaming,
    getConfig: host.getConfig,
    getSidebar: host.getSidebar,
    setSidebar: host.setSidebar,
    setActiveModel: host.setActiveModel,
    persistSession: host.persistSession,
    persistSidebar: host.persistSidebar,
    postModels: host.postModels,
    postSessionSync: host.postSessionSync,
    pool,
    agentLoop,
    requestChains,
    checkpoints,
    failureTracker,
    events,
    post: host.post,
    baseOf: host.baseOf,
    refreshUi: (options) => {
      if (options?.pointerOnly) host.persistActiveId();
      else if (!options?.sessionPersisted) host.persistSession();
      host.postModels();
      host.postSessionSync();
      host.postTokenBudget();
    },
    isConversationEvictable: (id) => isConversationEvictable(deps.evictionSignals(id)),
    evictionBlockers: (id) => evictionBlockers(deps.evictionSignals(id)),
    isConversationDrafted: host.isConversationDrafted,
    retention,
    ...(parts.archivedSessions ? { archivedSessions: parts.archivedSessions } : {}),
  });
  tabsRef.current = tabs;
  return { tabs, retention };
}
