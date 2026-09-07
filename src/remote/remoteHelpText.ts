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

Session: /help · /status · /context · /stop · /new · /chats [page] · /chat <n-or-id> · /resume · /notify on|off · /mirror on|off · /voice on|off

Workspace: /workspace [page] · /new <n-or-alias>

Queue: /queue · /steer <n-or-prompt> · /drop <n|all>

Models: /models [page] · /model [n-or-name] · /unload · /restart

Window: /compact · /lock · /reload · /timeout [1-1440|off] · /ratelimit [1-600|off] · /clanker on|off

Machine: /system · /sleep [8h|07:00] · /wake [8h|07:00|off]

How work is queued:

• Anything you send while a turn is running waits its turn — it never interrupts. /queue numbers what is waiting.

• /steer is the only way to cut a running turn short. /steer 2 runs queued prompt 2 now; /steer with no number runs prompt 1; /steer <text> runs new text now. A bare number is always a queue position, never prompt text — the reply says which one it did.

• /stop cancels only the running request; everything queued stays queued. /drop <n|all> is what clears the queue.

Notes:

• /status shows the model, the context used, and how many prompts are waiting; /context breaks the context window down on its own

• /chats numbers the recent conversations; /chat <n-or-id> switches to one; /resume continues the one already bound to this chat

• /notify off silences agent notify_user messages for this chat until the window reloads

• /mirror off stops answers typed in the Forge window being echoed here (on by default)

• /voice off stops replies being sent as a spoken voice message (text stays); /voice on turns it back on — saved to config.yaml, so it survives a window reload

• /new <n-or-alias> switches this chat to another workspace; /workspace lists them, numbers them, and says which one you are in

• /model with no argument reports the pinned model, /models lists them, /restart restarts the running backend

• /unload releases every loaded model and frees its memory, exactly like Unload Model in the sidebar; unlike /reload it refuses while a turn is running

• /compact summarises the conversation in place to win back context; the chat and its queue survive it

• /lock ends this authenticated session and discards any held prompt; the next message asks for the code again

• /reload fully reloads the VS Code window: it picks up a newly installed build, and drops a held prompt, the queue, and this session

• /timeout sets how long this chat stays authenticated when idle; off never expires

• /ratelimit sets how many messages this chat may send per minute (default 30); off raises it to the 600 ceiling rather than removing it, because the limit is also what stops a stuck message being retried forever

• /clanker on auto-approves non-dangerous tools in this workspace until the window reloads — writes then land with no confirmation anywhere, in any tab of that window. /clanker off also clears the sidebar toggle's memory, so it stays off across a reload

• /system reports GPU load, which processes hold VRAM (Forge's own backends are tagged), RAM and drive space; it answers while a turn is running

• /sleep suspends this machine. It asks for "/sleep confirm" first, and refuses while a turn is running unless you send "/sleep force". "/sleep 8h" arms a wake timer before suspending, so it comes back on its own; add "hibernate" for S4 instead of S3

• /wake with no argument reports how to wake this machine from outside — the MAC address for a Wake-on-LAN magic packet, the broadcast address, and whether the adapter is armed. Forge CANNOT wake the machine itself: once it sleeps nothing on it is running, so no message can reach it. "/wake 07:00" arms the clock instead, which does work; "/wake off" clears it`;

/**
 * Bolds the two things a reader scans for: the section a command lives under,
 * and the command a note is about. Telegram already renders every `/command`
 * as a tappable link, so bolding them all would only flatten the difference
 * between the map and the prose.
 */
export function decorateHelpLine(line: string, index: number): string {
  if (index === 0 || line === 'Notes:' || line === 'How work is queued:') {
    return `<b>${line}</b>`;
  }
  const section = /^([A-Za-z]+):(.*)$/u.exec(line);
  if (section && HELP_SECTIONS.has(section[1]!)) return `<b>${section[1]}:</b>${section[2]}`;
  const note = /^(• )(\/[a-z]+)(.*)$/u.exec(line);
  if (note) return `${note[1]}<b>${note[2]}</b>${note[3]}`;
  return line;
}
