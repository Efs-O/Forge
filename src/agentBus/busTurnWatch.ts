/** The bus's in-memory view of agent progress (docs/plans/AGENT_BUS_STATUS_VIEW_PLAN.md §5.2). */

import type { AgentProgressEvent } from '../sidebar/AgentProgress';

/** Per-turn caps. Local to the bus: RemoteAgentProgress's caps are private to Telegram. */
export const MAX_TOOL_NAME_CHARS = 80;
export const MAX_NARRATION_CHARS = 300;
export const MAX_WARNINGS = 4;
/** Conversations remembered; the least recently active is dropped past this. */
export const MAX_WATCHED = 20;

export interface TurnSnapshot {
  state: 'running' | 'ended';
  startedAt: number;
  lastEventAt: number;
  toolCalls: number;
  lastTool?: string;
  lastNarration?: string;
  phase?: string;
  warnings: string[];
  endedOk?: boolean;
  endedAt?: number;
}

export function reduceTurn(
  prev: TurnSnapshot | undefined,
  event: AgentProgressEvent,
  now: number,
): TurnSnapshot {
  if (prev === undefined && event.kind === 'end') {
    return {
      state: 'ended',
      startedAt: now,
      lastEventAt: now,
      toolCalls: 0,
      warnings: [],
      endedOk: event.ok,
      endedAt: now,
    };
  }
  const current: TurnSnapshot =
    prev === undefined || (prev.state === 'ended' && event.kind !== 'end')
      ? { state: 'running', startedAt: now, lastEventAt: now, toolCalls: 0, warnings: [] }
      : { ...prev, warnings: [...prev.warnings] };
  current.lastEventAt = now;
  switch (event.kind) {
    case 'tool':
      current.toolCalls += 1;
      current.lastTool = clip(event.toolName, MAX_TOOL_NAME_CHARS);
      break;
    case 'narration': {
      const text = clip(oneLine(event.text), MAX_NARRATION_CHARS);
      if (text) current.lastNarration = text;
      break;
    }
    case 'phase':
      if (event.text === undefined) delete current.phase;
      else current.phase = event.text;
      break;
    case 'notice':
      if (event.severity === 'warning') {
        current.warnings.push(clip(oneLine(event.text), MAX_NARRATION_CHARS));
        if (current.warnings.length > MAX_WARNINGS) current.warnings.shift();
      }
      break;
    case 'end':
      current.state = 'ended';
      current.endedOk = event.ok;
      current.endedAt = now;
      break;
    case 'commentary':
    case 'status':
      break;
  }
  return current;
}

function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

export interface ProgressSource {
  onAgentProgress?(listener: (event: AgentProgressEvent) => void): { dispose(): void };
}

export class BusTurnWatch {
  private readonly snapshots = new Map<string, TurnSnapshot>();
  private subscription: { dispose(): void } | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  /** Subscribe once. A missing stream can be retried by a later call. */
  attach(source: ProgressSource): boolean {
    if (this.subscription) return true;
    if (!source.onAgentProgress) return false;
    this.subscription = source.onAgentProgress((event) => {
      this.snapshots.set(
        event.conversationId,
        reduceTurn(this.snapshots.get(event.conversationId), event, this.now()),
      );
      if (this.snapshots.size > MAX_WATCHED) {
        const oldest = [...this.snapshots.entries()].reduce((a, b) =>
          a[1].lastEventAt <= b[1].lastEventAt ? a : b,
        );
        this.snapshots.delete(oldest[0]);
      }
    });
    return true;
  }

  get attached(): boolean {
    return this.subscription !== undefined;
  }

  snapshot(conversationId: string): TurnSnapshot | undefined {
    return this.snapshots.get(conversationId);
  }

  dispose(): void {
    this.subscription?.dispose();
    this.subscription = undefined;
    this.snapshots.clear();
  }
}
