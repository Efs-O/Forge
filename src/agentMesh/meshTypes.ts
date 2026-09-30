import type { AgentKind } from './aliasRegistry';
import type { ExchangeState } from './deliveryState';
import type { HostLivenessDeps } from './hostIdentity';
import type { MeshAdapter } from './meshAdapter';
import type { MeshMessageAcceptedSink } from './meshMessageAccepted';

export interface SessionProvider {
  resolveAdapter(alias: string): Promise<MeshAdapter | undefined>;
  isOwned(alias: string): boolean;
  touchActivity(alias: string): void;
  park(alias: string): boolean;
  wake(alias: string): boolean;
  isParked(alias: string): boolean;
  close(alias: string): Promise<boolean>;
}

export interface MeshScope {
  workspace: string;
  conversation?: string;
}

export interface TellOutcome {
  exchangeId: string;
  to: string;
  observing: boolean;
  note?: string;
}

export interface PendingMeshMessage {
  alias: string;
  message: string;
}

export interface RelayOutcome extends TellOutcome {
  relayed: true;
}

export interface OrchestratorDeps extends HostLivenessDeps {
  busRoot: string;
  provider: SessionProvider;
  scope: () => MeshScope;
  onEvent: (e: {
    exchangeId: string;
    from: string;
    to?: string;
    type: string;
    state: ExchangeState;
    detail?: string;
  }) => Promise<void> | void;
  knownAliases: () => string[];
  verdictDir?: string;
  onObservation?: (verb: 'status' | 'board' | 'peers' | 'queue' | 'context') => string;
  onMessageAccepted?: MeshMessageAcceptedSink;
}

export type RegisterAliasArgs = [
  alias: string,
  agent: AgentKind,
  sessionId: string,
  by: 'user' | 'forge',
];
