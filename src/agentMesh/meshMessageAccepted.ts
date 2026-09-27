export interface MeshMessageAcceptedEvent {
  exchangeId: string;
  from: string;
  to: string;
  message: string;
  priority: 'normal' | 'steer';
}

export type MeshMessageAcceptedSink = (event: MeshMessageAcceptedEvent) => void;
