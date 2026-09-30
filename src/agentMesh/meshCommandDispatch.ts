import type { MeshCommand } from './meshCommands';
import type { MeshOrchestrator } from './meshOrchestrator';

export async function dispatchMeshCommand(
  orchestrator: MeshOrchestrator,
  cmd: MeshCommand,
): Promise<string> {
  switch (cmd.verb) {
    case 'say': {
      const res = await orchestrator.tell(cmd.alias, cmd.message);
      return 'error' in res ? res.error : `sent to ${res.to} (exchange ${res.exchangeId})`;
    }
    case 'steer': {
      const message = cmd.message.trim()
        ? cmd.message
        : 'steer: interrupt the current work and report status';
      const res = await orchestrator.steer(cmd.alias, message);
      return 'error' in res ? res.error : `steered ${res.to} (exchange ${res.exchangeId})`;
    }
    case 'standby':
      return orchestrator.park(cmd.alias)
        ? `${cmd.alias} parked (warm; the thread stays resumable)`
        : `no session to park for "${cmd.alias}"`;
    case 'wake':
      return orchestrator.wake(cmd.alias)
        ? `${cmd.alias} woken`
        : `no parked session for "${cmd.alias}"`;
    case 'handoff': {
      const message = cmd.context.trim()
        ? `handoff: my part is done. ${cmd.context}`
        : 'handoff: my part is done; you take over.';
      const res = await orchestrator.tell(cmd.alias, message);
      return 'error' in res ? res.error : `handed off to ${res.to} (exchange ${res.exchangeId})`;
    }
    case 'close':
      return (await orchestrator.close(cmd.alias))
        ? `${cmd.alias} closed (Forge-owned session killed; thread kept for resume)`
        : `"${cmd.alias}" is not a Forge-owned session (never closes a user-opened session)`;
    default:
      return orchestrator.observe(cmd.verb);
  }
}
