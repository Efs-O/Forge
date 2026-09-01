# Workspace forensics

Lookups that are occasionally essential and almost never needed on a given
turn. They lived in `FORGE.md` — the system prompt of every single request —
until the cost was measured: the session-title recipe alone was 313 tokens,
14% of that file, for something looked up perhaps once a month. Read this file
when you need one of them.

---

## Finding the current session's title

`.forge/sessions/*.jsonl` does not carry the conversation title. Those logs are
still the project's forensic record — every tool call, argument and result —
but dedupe rows before counting anything in them.

The live title is in VS Code's own storage:

- File: `%APPDATA%\Code\User\workspaceStorage\<hash>\state.vscdb` (SQLite)
- Table `ItemTable`, key **`Efsoo.forge-llm`** — the value is a JSON blob
- Inside it: `forge.conversations.v1.activeConversationId`, then match that id
  against `forge.conversations.v1.conversations[].title`

Find the `<hash>` folder by reading each
`workspaceStorage\<hash>\workspace.json` and matching its `"folder"` to the
workspace URL. For `n:\vs code apps\Forge` it is currently
`e9a4155d14fdbca95fcae964471e7762` — re-derive it if it ever differs.

There is no `better-sqlite3` or `sqlite3` CLI on this machine. Use Python's
stdlib, and force UTF-8 or an emoji in a title will crash the cp1253 console:

```
python -c "import sqlite3,json,sys;sys.stdout.reconfigure(encoding='utf-8');d=json.loads(sqlite3.connect(r'<ws>\state.vscdb').execute(\"SELECT value FROM ItemTable WHERE key='Efsoo.forge-llm'\").fetchone()[0]);c=d['forge.conversations.v1'];a=c['activeConversationId'];print([x['title'] for x in c['conversations'] if x['id']==a])"
```
