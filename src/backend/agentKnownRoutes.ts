/**
 * Which `/agent/*` paths this window serves.
 *
 * Extracted from `agentRoutes.ts` so the route table can grow — cross-window
 * chat adds `GET /agent/chats` and `GET /agent/peer-view`, both answered on the
 * bus token alone — without that file passing its line budget. What it encodes
 * is a gate, not a router: a path that is unknown, or known but not enabled
 * here, answers 404 before the token is checked, so a caller cannot probe which
 * features a window has.
 */

/** The optional dependencies whose presence decides whether a route exists.
 *  Structural rather than `AgentRoutesDeps`, because that type lives in
 *  `agentRoutesDeps.ts`, which would otherwise import this file — a type-only
 *  import back would tie the two modules together. Every field here is only ever
 *  tested for being set, never called, so the precise signature is not this
 *  gate's business. */
export interface AgentRouteAvailability {
  stopForge?: unknown;
  who?: unknown;
  status?: unknown;
  view?: unknown;
  chats?: unknown;
  peerView?: unknown;
  sendFile?: unknown;
  validateAgentSender?: unknown;
  remoteSession?: unknown;
}

/** True when `route` is a path this window is wired to answer. */
export function isKnownAgentRoute(route: string, deps: AgentRouteAvailability): boolean {
  return (
    route === '/agent/message' ||
    route === '/agent/holds-link' ||
    route === '/agent/reply' ||
    route === '/agent/cancel' ||
    (route === '/agent/stop' && !!deps.stopForge) ||
    (route === '/agent/who' && !!deps.who) ||
    (route === '/agent/status' && !!deps.status) ||
    (route === '/agent/view' && !!deps.view) ||
    (route === '/agent/chats' && !!deps.chats) ||
    (route === '/agent/peer-view' && !!deps.peerView) ||
    (route === '/agent/send-file' && !!deps.sendFile && !!deps.validateAgentSender) ||
    ((route === '/agent/remote-ask' || route === '/agent/remote-notify') && !!deps.remoteSession) ||
    // The verdict routes depend on nothing but the bus folder: `readVerdictArtifact`
    // and `acknowledgeVerdict` authorize the reader against the exchange's own
    // sender (and its session id, when the caller supplied one), so a stranger
    // gets 404 whatever this window thinks of the name. Gating them on
    // `validateFrom` — an optional dependency neither one uses — is what made
    // both answer `no route` in every production window (audit F1).
    route === '/agent/read-verdict' ||
    route === '/agent/ack-verdict'
  );
}
