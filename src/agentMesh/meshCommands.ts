/**
 * The typed agent-mesh command surface (AGENT_MESH_PLAN §8, P3).
 *
 * Lifecycle commands are **typed operations**, not a generic string blob
 * (Codex, §4). This module is pure: it parses a command line into a typed
 * command and dispatches it against a handler interface. The wiring layer
 * (the orchestrator) supplies the handlers — the bus route and the remote
 * command handler both call into the same parser, so there is one owner of the
 * command grammar.
 *
 * Peer-targeted (hub-relayed, by alias):
 *   say <alias> <msg>        — send a message
 *   steer <alias> [msg|file] — interrupt a running turn / wake a parked one (§6)
 *   standby <alias>          — park-but-warm (§2b)
 *   wake <alias>             — explicitly wake a parked session
 *   handoff <alias> [ctx]    — a `say` with a convention ("my part is done")
 *   close <alias>            — hard-kill a Forge-owned session (never user-opened)
 * Observational:
 *   status | board | peers | queue | context
 */

export type MeshCommand =
  | { verb: 'say'; alias: string; message: string }
  | { verb: 'steer'; alias: string; message: string }
  | { verb: 'standby'; alias: string }
  | { verb: 'wake'; alias: string }
  | { verb: 'handoff'; alias: string; context: string }
  | { verb: 'close'; alias: string }
  | { verb: 'status' }
  | { verb: 'board' }
  | { verb: 'peers' }
  | { verb: 'queue' }
  | { verb: 'context' };

/** The verbs that target a peer by alias (the rest are observational). */
const PEER_VERBS = new Set(['say', 'steer', 'standby', 'wake', 'handoff', 'close']);
const OBS_VERBS = new Set(['status', 'board', 'peers', 'queue', 'context']);

/**
 * Parse a command line. Returns the command, or undefined when the text is not
 * a recognised command (the caller then treats it as ordinary message text).
 *
 * Grammar: `verb [alias] [rest]`. Peer verbs require an alias; `say`/`steer`/
 * `handoff` take the remainder as the message/context. A bare observational
 * verb is a command with no arguments.
 */
export function parseMeshCommand(text: string): MeshCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split(/\s+/);
  const verb = parts[0].toLowerCase();
  if (PEER_VERBS.has(verb)) {
    const alias = (parts[1] ?? '').trim().toLowerCase();
    if (!alias) return undefined; // a peer verb needs an alias
    const rest = parts.slice(2).join(' ');
    switch (verb) {
      case 'say':
        if (!rest.trim()) return undefined;
        return { verb: 'say', alias, message: rest };
      case 'steer':
        return { verb: 'steer', alias, message: rest };
      case 'handoff':
        return { verb: 'handoff', alias, context: rest };
      case 'standby':
        return { verb: 'standby', alias };
      case 'wake':
        return { verb: 'wake', alias };
      case 'close':
        return { verb: 'close', alias };
      default:
        return undefined;
    }
  }
  if (OBS_VERBS.has(verb)) {
    if (parts.length > 1) return undefined; // observational verbs take no arguments
    return { verb } as MeshCommand;
  }
  return undefined;
}

/** True when the text is a recognised mesh command. */
export function isMeshCommand(text: string): boolean {
  return parseMeshCommand(text) !== undefined;
}

/**
 * The dispatch lives in `MeshOrchestrator.handleCommand` (one owner of both the
 * grammar and its effects). The bus route and the remote command handler both
 * parse with `parseMeshCommand` and hand the result to the orchestrator, so the
 * grammar is never re-implemented per caller.
 */
