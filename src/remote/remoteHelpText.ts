/**
 * The `/help` message, and the markup that makes it readable on a phone.
 *
 * Owner of the remote command map. It is written as plain text and decorated
 * afterwards (see `markupTelegramLines`), so a transport without rich text
 * shows the same paragraphs without a single stray tag — and the angle
 * brackets in `<n-or-id>` stay literal either way.
 */

/** Section labels that head a command group, bolded when the transport allows. */
const HELP_SECTIONS = new Set(['Session', 'Workspace', 'Queue', 'Models', 'Window', 'Machine']);

export const HELP_TEXT = `Forge commands:

Session: /status · /context · /stop · /new · /list [page] · /resume · /select <n-or-id> · /notify on|off · /mirror on|off · /voice on|off

Workspace: /workspace [page] · /new <n-or-alias>

Queue: /queue · /drop <n|all> · /steer <prompt>

Models: /models [page] · /model [n-or-name] · /unload · /restart

Window: /compact · /lock · /reload · /timeout [1-1440|off] · /clanker on|off

Machine: /system

Notes:

• /stop cancels the current request; queued prompts stay queued

• /resume continues the conversation bound to this chat; /select <n-or-id> switches to another one

• /steer interrupts the current turn and runs its prompt before queued ones

• /clanker on auto-approves non-dangerous tools until the window reloads — writes then land with no confirmation anywhere

• /reload fully reloads the VS Code window: it picks up a newly installed build, and drops a held prompt, the queue, and this session

• /system reports GPU load, which processes hold VRAM (Forge's own backends are tagged), RAM and drive space; it answers while a turn is running

• /unload releases every loaded model and frees its memory, exactly like Unload Model in the sidebar; unlike /reload it refuses while a turn is running

• /notify off silences agent notify_user messages for this chat until the window reloads

• /mirror off stops answers typed in the Forge window being echoed here (on by default)

• /voice off stops replies being sent as a spoken voice message (text stays); /voice on turns it back on — saved to config.yaml, so it survives a window reload

• /new <n-or-alias> switches this chat to another workspace; /workspace lists them, numbers them, and says which one you are in`;

/**
 * Bolds the two things a reader scans for: the section a command lives under,
 * and the command a note is about. Telegram already renders every `/command`
 * as a tappable link, so bolding them all would only flatten the difference
 * between the map and the prose.
 */
export function decorateHelpLine(line: string, index: number): string {
  if (index === 0 || line === 'Notes:') return `<b>${line}</b>`;
  const section = /^([A-Za-z]+):(.*)$/u.exec(line);
  if (section && HELP_SECTIONS.has(section[1]!)) return `<b>${section[1]}:</b>${section[2]}`;
  const note = /^(• )(\/[a-z]+)(.*)$/u.exec(line);
  if (note) return `${note[1]}<b>${note[2]}</b>${note[3]}`;
  return line;
}
