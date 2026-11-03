/**
 * The one-at-a-time guard for opening a chat and pinning its model.
 *
 * Two paths open a chat on a model that is not the config default: the agent
 * bus's `--new` (`src/vscode/agentBusSubmission.ts`) and `message_chat`
 * `action=new` (`src/tools/messageChatActions.ts`). Both read the model to
 * follow, then `createConversation`, then `setConversationModel`, and the read
 * must happen before the create: a new chat's model is the stale
 * `config.active_model`, and loading that stale default spawns a second
 * llama-server beside the one already serving the conversation. The lock is
 * shared by both paths so one opener cannot land its create between another
 * opener's create and its pin, which is how a `--new` used to end up following
 * a model a chat nobody meant to open had just been pinned to.
 *
 * The lock covers only this prologue — sidebar state work, no turn — so two
 * opens still run concurrently overall: the second waits for the first to pin,
 * then follows the model the first pinned. Nothing else needs it: a follow-up
 * restores its own chat with `activate: false`, which never moves the active
 * tab, and `setConversationModel` is addressed by id.
 */
let newChatPrologue: Promise<unknown> = Promise.resolve();

/** Run `run` alone among the chat-opening prologues. A failed prologue (a chat
 *  cap, an unknown model) must not poison the line, so the next open still gets
 *  its turn at the lock. */
export function inNewChatPrologueLock<T>(run: () => Promise<T>): Promise<T> {
  const next = newChatPrologue.then(run, run);
  newChatPrologue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
