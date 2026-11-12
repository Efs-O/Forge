# Workspace forensics

Lookups that are occasionally essential and almost never needed on a given
turn. They lived in `FORGE.md` — the system prompt of every single request —
until the cost was measured: the session-title recipe alone was 313 tokens,
14% of that file, for something looked up perhaps once a month. Read this file
when you need one of them.

---

## Finding a chat's session log

The file name is the chat's **full** id, all 8-4-4-4-12 hex digits:
`~/.forge/sessions/ec64f51f-cfa7-420a-a98d-b0705ed30c47.jsonl`. The ids that
`message_chat` lists are not file names: `formatChatId`
(`src/tools/chatMessageResolver.ts:186`) cuts each one to the shortest prefix
that is unique among the open chats, often 8 digits, so a path built from one
is a file-not-found round. Resolve a short id to the file with a prefix glob
(`ls ~/.forge/sessions/ec64f51f*.jsonl`); if that matches more than one file,
the prefix is not unique on disk, though it was in the list.

A search across the whole folder finds which files contain a string, not whose
files they are. `rg -l "256 entries" ~/.forge/sessions` matched the chat that
wrote the phrase and an unrelated one that happened to contain it, and taking
the hit as proof that a message reached a given agent was a wrong claim. Before
you attribute a hit, read that file's `session_start` row (`title`, `model`,
`forge_version`) and the row that holds the match.

## Finding the current session's title

The raw logs carry a title, but not necessarily the current one. Every
`~/.forge/sessions/<chat-id>.jsonl` starts with a `session_start` row that
holds `title` — the name the chat had **at the start of that run**: `updateTitle`
(`src/sidebar/SessionLogger.ts:140-142`) refreshes it only for the _next_
`session_start` (`:150-162`), so a rename shows up in the log one run late. Use
that log title when you want the name a chat went by at the time; use the store
below for the name it has now. The logs are still the forensic record of every
tool call, argument and result — dedupe rows before counting anything in them.

For the title as it is now, read the open chat's body file. The memento in VS
Code's storage only names which chat is open: its `v2` `inline` list is empty
on the normal path (`openConversationsPersistence.ts:290-292` keeps bodies there
only after a failed body write) and `v1` is a compat stub, so neither carries
titles.

- Extension storage root:
  `%APPDATA%\Code\User\workspaceStorage\<hash>\Efsoo.forge-llm\`
  (`state.vscdb` sits one level up, inside `<hash>\`)
- Active id: `state.vscdb` → table `ItemTable` → key `Efsoo.forge-llm` →
  `forge.conversations.v2.activeConversationId`; the sibling key
  `forge.conversations.activeId` carries the same id
- Title: `<root>\open\<id>.json` → `.title`. Closed chats:
  `history\<id>.json`. Archived chats: `archive\index.json`, one row per chat.

The old recipe (`forge.conversations.v1.activeConversationId`, then match it
against `forge.conversations.v1.conversations[].title`) is dead, and reading it
is how an agent gets `Untitled chat` for a chat that has a real name:
`shrinkV1` (`src/sidebar/openConversationsPersistence.ts:307-322`) leaves `v1`
one record. Measured 2026-10-27 against this workspace's live store: `v1` held
`('1b20a7e5…', 'Untitled chat')` with an `activeConversationId` that was not
the active chat, `v2.inline` was `[]`, and the path above printed the real
title of the chat in front of the author.

Find the `<hash>` folder by reading each
`workspaceStorage\<hash>\workspace.json` and matching its `"folder"` to the
workspace URL. For `n:\vs code apps\Forge` it is currently
`e9a4155d14fdbca95fcae964471e7762` — re-derive it if it ever differs.

There is no `better-sqlite3` or `sqlite3` CLI on this machine. Use Python's
stdlib, and force UTF-8 or an emoji in a title will crash the cp1253 console.
`<ws>` below is the whole `workspaceStorage\<hash>` folder — open it read-only
so a running VS Code is not disturbed:

```
python -c "import json,os,sqlite3,sys;sys.stdout.reconfigure(encoding='utf-8');ws=r'<ws>';d=json.loads(sqlite3.connect('file:'+os.path.join(ws,'state.vscdb').replace(os.sep,'/')+'?mode=ro',uri=True).execute(\"SELECT value FROM ItemTable WHERE key='Efsoo.forge-llm'\").fetchone()[0]);v=d.get('forge.conversations.v2') or {};a=v.get('activeConversationId') or d.get('forge.conversations.activeId');print(json.load(open(os.path.join(ws,'Efsoo.forge-llm','open',a+'.json'),encoding='utf-8'))['title'])"
```
