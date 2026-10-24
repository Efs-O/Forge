/** The single data source for the plain help text and Telegram's section menu. */

import { MAX_TELEGRAM_IMAGES_PER_MESSAGE } from './TelegramAlbumBuffer';
import { escapeTelegramHtml } from './telegramHtml';
import { telegramHelpSectionButton } from './TelegramHelpButtons';

export interface RemoteHelpCommand {
  usage: string;
  summary: string;
}

export interface RemoteHelpSection {
  key: string;
  title: string;
  commands: RemoteHelpCommand[];
  notes: string[];
}

export const REMOTE_HELP_SECTIONS: RemoteHelpSection[] = [
  {
    key: 'session',
    title: 'Session',
    commands: [
      { usage: '/agents', summary: 'List the agents linked to this chat.' },
      { usage: '/chat <n-or-name>', summary: 'Switch to one conversation.' },
      { usage: '/chats [page]', summary: 'Number recent conversations.' },
      { usage: '/context', summary: 'Break down this chat’s context window.' },
      { usage: '/help', summary: 'Show this command menu.' },
      { usage: '/mirror on|off', summary: 'Echo sidebar answers here.' },
      { usage: '/new', summary: 'Start a new chat.' },
      { usage: '/notify on|off', summary: 'Mute agent notices for this chat.' },
      { usage: '/resume', summary: 'Continue the conversation bound here.' },
      { usage: '/status', summary: 'Show the model, context and queued prompts.' },
      { usage: '/stop', summary: 'Stop the running request and linked-agent ask.' },
      { usage: '/view [n]', summary: 'Replay recent answers in this conversation.' },
      { usage: '/voice on|off', summary: 'Turn spoken replies on or off.' },
    ],
    notes: [
      '/status shows the model, the context used, and how many prompts are waiting; /context breaks the context window down on its own',
      '/chats numbers the recent conversations; /chat switches to one by that number, its title, or its id; /resume continues the one already bound to this chat',
      "/view replays the last answers in this chat's conversation, oldest first — 3 by default, 10 at most; use it after /chat to see what an older conversation came to",
      '/mirror off stops answers typed in the Forge window being echoed here (on by default)',
      '/notify off silences agent notify_user messages for this chat until the window reloads',
      '/voice off stops replies being sent as a spoken voice message (text stays); /voice on turns it back on — saved to config.yaml, so it survives a window reload',
      `You can send up to ${MAX_TELEGRAM_IMAGES_PER_MESSAGE} images in one message (send them as a photo album). Each image is capped at 10 MiB and 25 MiB total; send more than ${MAX_TELEGRAM_IMAGES_PER_MESSAGE} and I keep the first ${MAX_TELEGRAM_IMAGES_PER_MESSAGE} and tell you`,
    ],
  },
  {
    key: 'queue',
    title: 'Queue',
    commands: [
      { usage: '/drop <n|all>', summary: 'Cancel queued prompts.' },
      { usage: '/queue', summary: 'List prompts waiting for this chat.' },
    ],
    notes: [
      'Plain text reaches the running turn at its next step (👀 receipt). Photos and other attachments wait for the turn to end. Tap Send now on the receipt to stop the turn and run it next. /queue numbers what is waiting',
      '/stop cancels the running Forge request and any linked-agent ask; everything queued stays queued. /drop <n|all> is what clears the queue',
    ],
  },
  {
    key: 'sessions',
    title: 'Sessions',
    commands: [
      { usage: '/agents', summary: 'List this chat’s linked sessions.' },
      { usage: '/answer <question-id> <text>', summary: 'Answer a linked-session question.' },
      { usage: '/claude <msg>', summary: 'Ask this chat’s linked Claude session.' },
      { usage: '/codex <msg>', summary: 'Ask this chat’s linked Codex session.' },
      { usage: '/copilot <msg>', summary: 'Ask this chat’s linked Copilot session.' },
      { usage: '/tell <agent> <msg>', summary: 'Send a one-way note to a linked agent.' },
    ],
    notes: [
      "/claude, /codex and /copilot ask the session linked to this chat, creating one if needed. /agents lists this chat's links. Forge sends the answer here. /tell <agent> <msg> sends a one-way note through the linked session",
    ],
  },
  {
    key: 'models',
    title: 'Models',
    commands: [
      { usage: '/chatmode [solo|multi|status]', summary: 'Set or report solo or multi-chat mode.' },
      { usage: '/model [n-or-name]', summary: 'List models or pin one to this chat.' },
      { usage: '/restart', summary: 'Restart the running backend.' },
      { usage: '/unload', summary: 'Release this chat’s model.' },
      { usage: '/unloadall', summary: 'Release every loaded model.' },
    ],
    notes: [
      '/model lists the configured models, and /model <number-or-name> pins one to this chat; /restart restarts the running backend',
      "/unload releases this chat's model and stops its configured server; /unloadall releases every loaded model and stops configured servers. Both refuse while a turn is running",
    ],
  },
  {
    key: 'work',
    title: 'Workspace',
    commands: [
      { usage: '/workspace', summary: 'List configured workspaces.' },
      { usage: '/workspace <n-or-alias>', summary: 'Switch to a workspace.' },
    ],
    notes: [
      '/workspace lists the workspaces, numbers them, and says which one you are in; /workspace <n-or-alias> goes to one and continues its most recent conversation. The VS Code window reloads, so the chat goes quiet for a few seconds and the remote session does not survive it — expect to send your code again. /new <n> still works as an alias',
    ],
  },
  {
    key: 'window',
    title: 'Window',
    commands: [
      { usage: '/clanker on|off', summary: 'Set approval-gate mode.' },
      { usage: '/compact', summary: 'Summarise the conversation in place.' },
      { usage: '/lock', summary: 'End this authenticated session.' },
      { usage: '/ratelimit [1-600|off]', summary: 'Set this chat’s message limit.' },
      { usage: '/reload', summary: 'Reload the VS Code window.' },
      { usage: '/timeout [1-1440|off]', summary: 'Set the session idle timeout.' },
    ],
    notes: [
      '/clanker on auto-approves non-dangerous tools for every tab of the VS Code window — writes then land with no confirmation anywhere, here or in the sidebar. It is remembered per workspace and survives a window reload, so it stays armed until someone turns it off; /clanker off, or the sidebar toggle, is the only thing that clears it',
      '/compact summarises the conversation in place to win back context; the chat and its queue survive it',
      '/lock ends this authenticated session and discards any held prompt; the next message asks for the code again',
      '/ratelimit sets how many messages this chat may send per minute (default 30); off raises it to the 600 ceiling rather than removing it, because the limit is also what stops a stuck message being retried forever',
      '/reload fully reloads the VS Code window: it picks up a newly installed build, and drops a held prompt, the queue, and this session',
      '/timeout sets how long this chat stays authenticated when idle; off never expires',
    ],
  },
  {
    key: 'jobs',
    title: 'Jobs',
    commands: [
      { usage: '/job <n|name> pause|resume|run|delete|chat', summary: 'Act on a persistent job.' },
      { usage: '/jobs', summary: 'List persistent agent jobs.' },
    ],
    notes: [
      '/jobs lists the persistent agent jobs, numbered; /job <n|name> pause|resume|run|delete|chat acts on one. /job <n> run runs it on the next scheduler tick, in whichever window holds the jobs lease; /job <n> delete asks for "/job <n> delete confirm" first, like /sleep; /job <n> chat opens (or reuses) the job\'s discuss chat, seeded with the job, its recent runs, and the last observation',
    ],
  },
  {
    key: 'contacts',
    title: 'Contacts',
    commands: [
      { usage: '/contact approve|bind|link|disable|unbind', summary: 'Manage a remote contact.' },
      { usage: '/contacts pending|list', summary: 'List remote contacts.' },
      { usage: '/send <name>: <message>', summary: 'Prepare a confirmed contact message.' },
    ],
    notes: [],
  },
  {
    key: 'machine',
    title: 'Machine',
    commands: [
      { usage: '/sleep [8h|07:00]', summary: 'Suspend this machine.' },
      { usage: '/system', summary: 'Report GPU, VRAM, RAM and drives.' },
      { usage: '/wake [8h|07:00|off]', summary: 'Show or set wake options.' },
    ],
    notes: [
      "/system reports GPU load, which processes hold VRAM (Forge's own backends are tagged), RAM and drive space; it answers while a turn is running",
      '/sleep suspends this machine. It asks for "/sleep confirm" first, and refuses while a turn is running unless you send "/sleep force". "/sleep 8h" arms a wake timer before suspending, so it comes back on its own; add "hibernate" for S4 instead of S3',
      '/wake with no argument reports how to wake this machine from outside — the MAC address for a Wake-on-LAN magic packet, the broadcast address, and whether the adapter is armed. Forge CANNOT wake the machine itself: once it sleeps nothing on it is running, so no message can reach it. "/wake 07:00" arms the clock instead, which does work; "/wake off" clears it',
    ],
  },
];

export const HELP_SECTIONS = new Set(REMOTE_HELP_SECTIONS.map((section) => section.title));

/** Plain, non-Telegram help preserves every usage line and original note. */
export const HELP_TEXT = `Forge commands:\n\n${REMOTE_HELP_SECTIONS.map(
  (section) =>
    `${section.title}: ${section.commands.map((command) => command.usage).join(' · ')}${section.notes.length ? `\n\n${section.notes.map((note) => `• ${note}`).join('\n\n')}` : ''}`,
).join('\n\n')}`;

/** Telegram's compact top-level menu. */
export function renderRemoteHelpMenu(): { html: string; buttons: RemoteContactButton[][] } {
  const quick = [
    [
      '/status',
      REMOTE_HELP_SECTIONS[0]!.commands.find((command) => command.usage === '/status')!.summary,
    ],
    [
      '/chats',
      REMOTE_HELP_SECTIONS[0]!.commands.find((command) => command.usage.startsWith('/chats'))!
        .summary,
    ],
    ['/model', REMOTE_HELP_SECTIONS[3]!.commands[0]!.summary],
    [
      '/stop',
      REMOTE_HELP_SECTIONS[0]!.commands.find((command) => command.usage === '/stop')!.summary,
    ],
  ];
  const html = [
    '<b>Forge commands</b>',
    'Tap a section for its commands.',
    '',
    ...quick.map(
      ([usage, summary]) =>
        `<code>${escapeTelegramHtml(usage!)}</code> ${escapeTelegramHtml(summary!)}`,
    ),
    '',
    '<i>Plain text reaches the running turn at its next step.</i>',
  ].join('\n');
  const buttons = REMOTE_HELP_SECTIONS.map((section) =>
    telegramHelpSectionButton(section.key, section.title),
  );
  return { html, buttons: [...chunk(buttons, 3), [{ text: '✕ Close', callbackData: 'h:x' }]] };
}

/** Render a section to one or more Telegram-safe messages, preserving all notes. */
export function renderRemoteHelpSection(key: string): string[] | undefined {
  const section = REMOTE_HELP_SECTIONS.find((item) => item.key === key);
  if (!section) return undefined;
  const heading = `<b>${escapeTelegramHtml(section.title)}</b>`;
  const commands = section.commands.map(
    ({ usage, summary }) =>
      `<code>${escapeTelegramHtml(usage)}</code> ${escapeTelegramHtml(summary)}`,
  );
  const prefix = [heading, ...commands].join('\n');
  const noteChunks = splitNotes(section.notes, 4096 - prefix.length - 40);
  if (noteChunks.length === 0) return [prefix];
  return noteChunks.map(
    (notes) => `${prefix}\n\n<blockquote expandable>${escapeTelegramHtml(notes)}</blockquote>`,
  );
}

/** Retained for non-menu rich-text consumers and existing formatting checks. */
export function decorateHelpLine(line: string, index: number): string {
  // markupTelegramLines escapes the complete source before this formatter runs.
  if (index === 0) return `<b>${line}</b>`;
  const section = /^([A-Za-z]+):(.*)$/u.exec(line);
  if (section && HELP_SECTIONS.has(section[1]!)) {
    return `<b>${section[1]!}:</b>${section[2]!}`;
  }
  const note = /^(• )(\/[a-z]+)(.*)$/u.exec(line);
  if (note) return `${note[1]}<b>${note[2]!}</b>${note[3]!}`;
  return line;
}

type RemoteContactButton = { text: string; callbackData: string };

function chunk<T>(items: readonly T[], count: number): T[][] {
  const rows: T[][] = [];
  for (let offset = 0; offset < items.length; offset += count)
    rows.push(items.slice(offset, offset + count));
  return rows;
}

function splitNotes(notes: readonly string[], available: number): string[] {
  if (notes.length === 0) return [];
  const result: string[] = [];
  let current = '';
  for (const note of notes) {
    const paragraph = current ? `\n\n${note}` : note;
    if (escapeTelegramHtml(paragraph).length <= available) {
      current += paragraph;
      continue;
    }
    if (current) result.push(current);
    current = '';
    let remaining = note;
    while (escapeTelegramHtml(remaining).length > available) {
      let take = Math.max(
        1,
        Math.floor((remaining.length * available) / escapeTelegramHtml(remaining).length),
      );
      while (
        take > 1 &&
        escapeTelegramHtml([...remaining].slice(0, take).join('')).length > available
      )
        take -= 1;
      const chars = [...remaining];
      result.push(chars.slice(0, take).join(''));
      remaining = chars.slice(take).join('');
    }
    current = remaining;
  }
  if (current) result.push(current);
  return result;
}
