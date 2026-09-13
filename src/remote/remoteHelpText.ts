/**
 * The `/help` message, and the markup that makes it readable on a phone.
 *
 * Owner of the remote command map. It is written as plain text and decorated
 * afterwards (see `markupTelegramLines`), so a transport without rich text
 * shows the same paragraphs without a single stray tag — and the angle
 * brackets in `<n-or-name>` stay literal either way.
 */

/** Section labels that head a command group, bolded when the transport allows. */
export const HELP_SECTIONS = new Set([
  'Session',
  'Workspace',
  'Queue',
  'Models',
  'Window',
  'Machine',
]);

export const HELP_TEXT = `Forge commands:

Session: /chat <n-or-name> · /chats [page] · /context · /help · /mirror on|off · /new · /notify on|off · /resume · /status · /stop · /view [n] · /voice on|off

Workspace: /workspace · /workspace <n-or-alias>

Queue: /drop <n|all> · /queue · /steer <n-or-prompt>

Models: /model [n-or-name] · /restart · /unload

Window: /clanker on|off · /compact · /lock · /ratelimit [1-600|off] · /reload · /timeout [1-1440|off]

Machine: /sleep [8h|07:00] · /system · /wake [8h|07:00|off]

How work is queued:

• Anything you send while a turn is running waits its turn — it never interrupts. /queue numbers what is waiting.

• /steer is the only way to cut a running turn short. /steer 2 runs queued prompt 2 now; /steer with no number runs prompt 1; /steer <text> runs new text now. A bare number is always a queue position, never prompt text — the reply says which one it did.

• /stop cancels only the running request; everything queued stays queued. /drop <n|all> is what clears the queue.

Notes:

• /status shows the model, the context used, and how many prompts are waiting; /context breaks the context window down on its own

• /chats numbers the recent conversations; /chat switches to one by that number, its title, or its id; /resume continues the one already bound to this chat

• /view replays the last answers in this chat's conversation, oldest first — 3 by default, 10 at most; use it after /chat to see what an older conversation came to

• You can send up to 3 images in one message (send them as a photo album). Each image is capped at 10 MiB and 25 MiB total; send more than 3 and I keep the first 3 and tell you

• /notify off silences agent notify_user messages for this chat until the window reloads

• /mirror off stops answers typed in the Forge window being echoed here (on by default)

• /voice off stops replies being sent as a spoken voice message (text stays); /voice on turns it back on — saved to config.yaml, so it survives a window reload

• /workspace lists the workspaces, numbers them, and says which one you are in; /workspace <n-or-alias> goes to one and continues its most recent conversation. The VS Code window reloads, so the chat goes quiet for a few seconds and the remote session does not survive it — expect to send your code again. /new <n> still works as an alias

• /model lists the configured models, and /model <number-or-name> pins one to this chat; /restart restarts the running backend

• /unload releases every loaded model and frees its memory, exactly like Unload Model in the sidebar; unlike /reload it refuses while a turn is running

• /compact summarises the conversation in place to win back context; the chat and its queue survive it

• /lock ends this authenticated session and discards any held prompt; the next message asks for the code again

• /reload fully reloads the VS Code window: it picks up a newly installed build, and drops a held prompt, the queue, and this session

• /timeout sets how long this chat stays authenticated when idle; off never expires

• /ratelimit sets how many messages this chat may send per minute (default 30); off raises it to the 600 ceiling rather than removing it, because the limit is also what stops a stuck message being retried forever

• /clanker on auto-approves non-dangerous tools for every tab of the VS Code window — writes then land with no confirmation anywhere, here or in the sidebar. It is remembered per workspace and survives a window reload, so it stays armed until someone turns it off; /clanker off, or the sidebar toggle, is the only thing that clears it

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
