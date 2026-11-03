import { useCallback, type Dispatch, type SetStateAction } from 'react';
import type { AttachmentData } from '../../src/sidebar/messageBridge';
import type { Action } from './reducer';
import { approvalsSlashCommand, linkSlashCommand, unknownSlashCommand } from './slashCommands';
import { vscode } from './vscode';

/**
 * What the send button does with the text in the box.
 *
 * Three outcomes, in this order, and the order is the whole behaviour:
 * - A command the webview has to route itself (`/approvals [reset]`, `/link …`)
 *   goes straight to the host, because the host cannot answer it as a prompt.
 * - A `/word` nothing recognises is refused here and never becomes a turn. It
 *   used to reach the model, which spent a whole turn on a word no code
 *   handles, and the owner never learned that the name was wrong — they had to
 *   read an answer to find out. The notice is the local `NOTICE` row the host
 *   already uses for `/approvals` usage and chat-mode refusals: the composer
 *   owns this decision, so the webview says it out loud itself, in the same
 *   mechanism, rather than inventing a second kind of message.
 * - Everything else is a prompt and sends as one.
 *
 * It lives outside `App.tsx` because that file is at the 500-line lint cap: this
 * is the composer's routing rule, not the shell of the panel, and it is the
 * part that changes when a command is added.
 */
export function useComposerSend({
  dispatch,
  handleSend,
  restoreDraft,
}: {
  dispatch: Dispatch<Action>;
  handleSend: (text: string, attachments: AttachmentData[]) => void;
  /**
   * Put text back in the box.
   *
   * The input row clears the draft as part of sending, so a send that is
   * refused has to ask for its own text back. This is the same route the host
   * uses to prefill `/chatMode` after a command asks for it, so a refused
   * command leaves the draft exactly as it was typed, ready to be corrected.
   */
  restoreDraft: Dispatch<SetStateAction<string | null>>;
}): (text: string, attachments: AttachmentData[]) => void {
  return useCallback(
    (text: string, attachments: AttachmentData[]) => {
      const trimmed = text.trim();
      const approvalsCommand = approvalsSlashCommand(trimmed);
      if (approvalsCommand) {
        vscode.postMessage({ type: 'runSlashCommand', ...approvalsCommand });
        return;
      }
      const linkCommand = linkSlashCommand(trimmed);
      if (linkCommand) {
        vscode.postMessage({ type: 'runSlashCommand', ...linkCommand });
        return;
      }
      // A message that carries a file is not a command, whatever its first word
      // looks like, so attachments keep their send path untouched.
      const unknown = unknownSlashCommand(trimmed);
      if (unknown && attachments.length === 0) {
        dispatch({
          type: 'NOTICE',
          message: `Unknown command ${unknown.command}. Type / to see the commands.`,
        });
        restoreDraft(trimmed);
        return;
      }
      handleSend(text, attachments);
    },
    [dispatch, handleSend, restoreDraft],
  );
}
