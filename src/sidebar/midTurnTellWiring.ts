import type { HostToWebview } from './messageBridge';
import type { ElapsedTimeNote } from '../agent/elapsedTimeNote';
import type { MidTurnInbox } from '../agent/MidTurnInbox';
import type { MidTurnTellDrain } from '../agent/MidTurnTellDrain';
import type { MidTurnTellServices } from './turnServices';
import { fileChangeSource } from '../agent/fileChangeReminder';

/** Compose the sidebar inbox and elapsed-time notes into AgentLoop's tell path. */
export function wireMidTurnTells(options: {
  tellDrain: MidTurnTellDrain;
  midTurnInbox: MidTurnInbox;
  elapsedTimeNote: ElapsedTimeNote;
  post: (message: HostToWebview) => void;
  setMidTurnTells: (services: MidTurnTellServices) => void;
}): void {
  const { tellDrain, midTurnInbox, elapsedTimeNote, post, setMidTurnTells } = options;
  // One composer for every door. The sidebar inbox registers first so its tells
  // drain ahead of any remote claim; the agent-bus source registers in
  // agentMessagingSetup.ts, and the remote source is added by extension.ts once
  // the RemoteRuntime's store and auth exist.
  tellDrain.registerSource(
    'sidebar',
    (conversationId) => Promise.resolve(midTurnInbox.drainResult(conversationId)),
    (conversationId, callback) => midTurnInbox.onAdded(conversationId, callback),
  );
  tellDrain.registerSource('elapsed-time', elapsedTimeNote.source);
  // The file-change reminder, always registered: the source itself reads the
  // config at every drain, so switching the setting on or off takes effect on the
  // next round without a reload or a re-registration.
  tellDrain.registerSource('file-change', fileChangeSource);
  setMidTurnTells({
    onTaskStart: (conversationId) => elapsedTimeNote.taskStarted(conversationId),
    // `set_checkin`'s route to the clock. Bound per conversation by ModelTurn,
    // so the tool itself never handles a conversation id.
    setCheckin: (conversationId, minutes, byThen) =>
      elapsedTimeNote.setCheckin(conversationId, minutes, byThen),
    drainTells: async (conversationId) => {
      const drained = await tellDrain.drain(conversationId);
      // A streaming chat ignores host syncs, so a tell (a Telegram one above
      // all) was invisible in the sidebar until the turn ended. Show it now.
      for (const tell of drained.messages) {
        if (typeof tell.content !== 'string') continue;
        if (tell.internal) continue;
        post({
          type: 'userPrompt',
          text: tell.content,
          ...(tell.createdAt !== undefined ? { createdAt: tell.createdAt } : {}),
          conversationId,
          midTurn: true,
        });
      }
      return drained;
    },
    onTellArrived: (conversationId, callback) => tellDrain.onArrived(conversationId, callback),
  });
}
