# Forge — Recent Changes

## 0.15.18

- **Every Telegram list and report is readable on a phone now.** The model list
  already grouped and bolded itself; everything else arrived as one unbroken
  block. `/help` ran eleven notes together with nothing between them, `/list`
  packed a title, an id, a model and a timestamp onto a single wrapping line per
  conversation, and `/status` read as six lines of undifferentiated prose. Rich
  text now covers all of them: `/help` gets a paragraph per command group and
  per note with the section label and each note's subject command in bold;
  `/list` and `/select` give each conversation a bold numbered title on its own
  line, its ids and timestamp indented under it, and a blank line before the
  next; `/models` and `/workspace` bold the entry number, which is the part you
  type back; `/status`, `/context` and `/queue` bold their line labels. The rule
  that makes it safe is the one the model list already used — escape the whole
  message first, then re-insert markup only for the structure Forge itself
  decided on — so a conversation title full of angle brackets is content, never
  markup, and a transport that does not parse HTML still gets the same
  paragraphs with nothing leaking through.

## 0.15.14

- **Remote resume and conversation selection now have distinct commands.** Bare
  `/resume` continues the conversation already bound to Telegram and loads its
  model when needed. `/select <number-or-id>` switches the binding without
  starting a turn; numbered `/resume` remains as a compatibility alias.

- **`/system` says what the machine is doing, and which PID is holding the
  VRAM.** New on both surfaces — the sidebar `/` menu and Telegram — plus a
  `get_system_status` tool so the agent can read the same numbers in one round
  instead of shelling out for them. Per-GPU load, utilisation and temperature
  come from `nvidia-smi`; the per-process VRAM does not, because on WDDM
  `--query-compute-apps` reports `[N/A]` for every process *and* lists graphics
  clients like `explorer.exe`. The report reads the same performance counters
  Task Manager does, filters to processes actually holding VRAM, reconciles each
  adapter LUID against a card, and tags Forge's own llama-server backends with
  their model name — the one line no external tool can produce. RAM and free
  space per drive ride along. A probe that fails says why: a missing nvidia-smi
  or a localised counter name is reported, never rendered as an empty section.

- **A workspace switch no longer strands the chat between two windows.**
  `/new <n>` recorded the move, stopped this window's transports and asked VS
  Code to open the target folder — but when that folder is *already open in
  another window*, VS Code focuses that window instead of reloading this one.
  Nothing reloaded, so nothing ran the arrival claim, and the transport lease
  had already been released: no window was polling Telegram at all. The chat's
  last message stayed “switching…”, and `/status` went unanswered until a window
  was reloaded by hand. Now a window that is already running watches for a chat
  handed to it and claims it without a restart — taking the transport over first,
  so two windows on one folder cannot both take the chat — and the window that
  started the switch takes it back if nobody claims within twenty seconds,
  saying so in the chat rather than leaving it quiet. The arrival receipt no
  longer blames a reload for the locked session: sessions live in the window
  that authenticated them and never cross to another one, reload or not.

- **A spoken reply no longer reads your own question back first.** The one-time
  `Chat: … · ID: …` label at the top of the first answer in a chat was being
  synthesized along with the answer — and a conversation title is derived from
  the prompt you sent, so every voice message opened by repeating your question
  and then spelling out a shortened id, before any of the reply arrived. The
  label is a written navigation aid; it is now stripped before synthesis and
  left untouched in the text message.

## 0.15.13

- **Talk to Forge, and hear it answer.** Send a voice note to the Telegram bot
  and it comes back as `Heard: "..."` for you to confirm with `/ok` before
  anything runs — the transcript is a draft, never a submission. Replies are
  spoken back as a playable voice message. Transcription is whisper.cpp with
  `large-v3`, chosen on deployment grounds rather than speed: faster-whisper's
  CUDA path cannot start without a ~500 MB CUDA 12 runtime an end user would
  have to install, and Ssuno had already tested and deleted `turbo` for
  dropping a whole couplet and hallucinating an outro.

- **Spoken approvals, and the refusals that make them safe.** Say "approve",
  "εντάξει", "deny" or "σταμάτα" and the matching gate resolves — but only when
  exactly one approval was open across your entire recording window. Anything
  ambiguous refuses and tells you to tap the button. Matching is
  whole-utterance, which is what makes the negated cases safe: a recorded
  `μην εγκρίνεις` came back from whisper as `Μείνα εγκρίνης.` — mangled past
  recognition, the negation destroyed — and was still refused, because a
  two-word phrase cannot match a whole utterance. All six recorded negations
  are now a test, against verbatim fixture transcripts, so it needs no GPU.

- **Replies are summarized for speech, not narrated.** A code fence becomes
  "Code block, 12 lines", a path becomes its last segment, a table becomes "A
  table.", a URL becomes "a link" — and inline code keeps its content, because
  `npm run ci` is exactly what you want to hear. A reply that renders down to
  nothing but placeholders is not spoken at all.

- **An invisible byte no longer costs an hour.** A stray `0x08` inside a regex
  literal made a function return the wrong answer while the identical code
  worked in plain node. It renders as `` in `od` and as *nothing* in every
  editor, terminal and grep. That is the second time this repo has been bitten
  by a control character generated through a shell heredoc, so there is now a
  test that scans every tracked source file and fails by name.

## 0.15.12

- **A resumed agent stops treating old requests as new ones.** After an
  auto-compaction the agent announced that a benchmark run had "errored again"
  and started re-investigating a fix it had already shipped and reported. The
  summary was not at fault — it carried the right root cause and an exact Next
  ("user presses Enter on the pasted command"). What it read instead was the
  last line of the `VERBATIM USER REQUESTS` block: a complaint issued before the
  fix, already answered in full, rendered in a user-role message with nothing
  marking it as history. Everything in that block is history by construction, so
  it now says so, and names the summary's Next as the authority on what is still
  open. Two earlier sessions show the same misread ("User's last message [22]…"
  when [22] was not the last message); both recovered, this one did not.

- **Forge's own prompts stopped looking like yours.** The compaction resume
  prompt is sent with an `internal` flag precisely so it is not mistaken for
  something you typed — and the flag never arrived. The wiring adapter was
  written with three parameters against a four-parameter signature, which
  type-checks and silently discards the fourth. Zero of 472 messages in the
  audited conversation carried the flag, and `Continue the active task from the
  compacted context.` was sitting in the verbatim block as entry [12], replayed
  to the model as one of your instructions.

- **The agent's last words survive the cut.** A compaction keeps the last
  exchange verbatim only when it fits 4,000 characters; one measured exchange
  cost 21,860, so nothing was kept and the agent's closing message to you — the
  one saying the command was pasted and waiting — reached the next turn only as
  a paraphrase. When the retained tail carries no words of the agent's own, the
  last thing it actually said is now recorded verbatim beside the summary.

- **The summary is in the session log.** The row recorded `summary_chars` and
  dropped the text. That summary *is* the working context for every turn after
  it, and reconstructing this misread meant digging the live copy out of
  workspaceState, which survives only until the tab is cleared.

## 0.15.9

> Ships 0.15.7 and 0.15.8 as well: both were committed but never tagged, so the
> publish workflow — which fires on the tag, not the commit — never ran for
> them. Coming from 0.15.6, everything under all three headings is new to you.

- **The sidebar gets its column back.** The panel was spending roughly two
  thirds of a 382 px column on chrome, leaving the transcript the smallest
  region on screen. Eight changes, none of them a restyle: the header is one row
  instead of two and carries the Forge mark; the sessions flyout floats over the
  transcript instead of pushing 200 px of it off-screen, and its list is twice as
  tall now that length costs the chat nothing; the composer's stacked button
  column becomes one row under a full-width field, taking the model selector with
  it; and a short conversation anchors to the bottom of the panel, next to the
  composer, rather than floating above 400 px of void.

- **The "Queue" button is gone.** While a turn was running it called the same
  submit that Enter calls, and the queued prompt already announces itself in the
  transcript with Steer and Cancel on it. Enter still queues; a line under the
  composer says so.

- **Clanker arms the field instead of shouting.** An amber all-caps pill sat a
  pointer-width from Stop — persistent state filed among actions. Clanker is
  durable across reloads, so it now colours the box you type into, with one dim
  line naming it and how to stop it. Off, none of it renders.

- **The thinking fold says how long it thought.** `Thinking · 4.2s`. Reasoning
  and the answer draw on one output budget, so that number is worth seeing
  without opening the fold.

- **"Starting backend, please wait…" stops lying.** It is rewritten in place to
  "Backend ready." rather than answered by a second row, which used to leave the
  first one in the transcript permanently describing a wait that had ended.

## 0.15.8

- **`/workspace` lists on its own now.** The namespace had exactly one verb, so
  `/workspace list` was ceremony: `/workspace` lists, `/workspace 2` pages, and
  `/workspace list [page]` still parses so the namespace stays open for the
  `create`/`confirm` subcommands the remote plan has queued behind it. Anything
  else after `/workspace` is rejected rather than silently listed.

- **`/workspace list <page>` never paged.** The command line was split with a
  limit of two, so `/workspace list 3` arrived as `['/workspace', 'list']` and
  the page number was thrown away — the page fallback printed in every list
  footer always returned page 1. Commands now split whole.

- **"Where am I?" is answerable.** A chat moved with `/new` could be sitting in
  any project on disk and nothing said which. `/status` now leads with
  `Workspace:`, and the `/workspace` list names the open folder under the
  entries. Both fall back to the folder's own name when it is not an alias, so
  the answer is never blank.

- **A workspace switch no longer goes silent.** `/new <n>` reloads the VS Code
  window, and remote TOTP sessions are memory-only, so the chat arrived in the
  new project locked — with nothing to say so. The last message was
  “switching…” and the challenge only appeared if the user happened to send
  something, so the sane reading was that the switch had hung. The window that
  comes up now sends its own arrival receipt (“now in X — a new chat is bound
  here”, plus the unlock instruction when TOTP is enrolled), which doubles as
  the signal that the switch finished, and the pre-switch line says the chat
  will go quiet for a few seconds first.

- **`/new <number>` stopped blaming the wrong thing.** A number that resolved to
  nothing reported `workspace "26" was not found` — sending the user to look for
  a missing project when the real cause was a selection list that had expired
  (they live 10 minutes) or a number outside its range. The three cases now say
  which one happened, and an unavailable switch path says that instead.

## 0.15.7

- **`/workspace list` was empty on every install.** Switching the Telegram
  chat to another project needed `remote.workspace_aliases` hand-written into
  `config.yaml` — four path/display pairs before the feature did anything — so
  in practice the block was empty and the command answered "no remote workspace
  aliases are configured". Forge now lists the sibling folders of whatever
  project this window has open, with no configuration at all: the search root is
  `dirname(workspaceFolders[0])`, derived at runtime, so it is `N:s code apps`
  for one user and `~/dev` for another and hardcoded for nobody.

  There is deliberately no `.git` filter. It was the obvious refinement and it
  would have hidden the folder that prompted the whole change — on the disk in
  question the parent holds 29 directories, 13 of them repositories, and the
  `Qwen testing` folder is not one of them. Dotfolders and dependency
  directories are skipped and the scan is capped at 100 entries. Explicit
  `remote.workspace_aliases` still win, and an explicit entry pointing at a
  discovered folder replaces it rather than listing the same directory twice.

  The scan runs when the remote controller's options are built, so a project
  created after this window opened appears after a config change or a reload
  rather than instantly.

- **`/list` sent every conversation in one Telegram message.** A workspace with
  forty conversations produced a wall of text that had to be scrolled past on a
  phone, and left it in the chat history forever. `/list`, `/models` and
  `/workspace list` now send ten entries at a time with native inline-keyboard
  `Previous` / `Next` / `Close` buttons: navigation edits the original message
  rather than posting another one, and `Close` deletes it. Numbering stays
  absolute across pages, so `/select 17` and `/model 17` mean the seventeenth
  item whichever page is on screen. `/list 2` and `/models 2` are the text
  fallback for transports without buttons.

  Every callback runs the full inbound gauntlet before it can move a page —
  private chat, paired owner, TOTP, rate limit — and carries an opaque
  twelve-character token instead of a conversation ID, so a button reveals
  nothing and cannot drive another chat, another list kind, or an expired
  selection. Issuing a list invalidates the previous one of its kind. Stored
  remote state migrates implicitly: the token is optional, so state written by
  an older build still parses.

- **Workspace pages were encoded as model pages.** The Telegram callback codec
  mapped selection kinds with `kind === 'conversations' ? 'c' : 'm'`, which
  gave `/workspace list` a keyboard stamped `m`. Pressing `Next` on it looked
  up a *models* selection under a workspace token, missed, and reported the
  list as expired — the security check working correctly against a bug on our
  own side. Encoding and parsing now share one table covering all three kinds.

- **`/workspace list` never marked where you were.** `RemoteRuntime` computed
  which configured alias matches this window's root and `RemoteCommandHandler`
  read it, but the controller passed it only to the selection-callback path, so
  on the command path it was always undefined: the `· current` marker never
  appeared, and the guard that stops `/new <alias>` from reloading the window to
  arrive where the chat already is could never fire.

- **A successful `move_file` on a directory reported `EISDIR`.** The move
  itself worked — the failure came afterwards, from the per-turn diff trying to
  read the moved directory as text, and the dispatcher turned that render error
  into the tool's result and charged the failure tracker for it. The agent then
  spent three rounds trying to recover a move that had already happened, and
  reached for `powershell -Command` on the way. Diff rendering now runs in its
  own try/catch and skips directories, `move_file`'s schema says it takes a
  file *or a directory*, and the PowerShell refusal names the write tools
  (`write_file`, `edit_file`, `move_file`, `create_directory`, `delete_file`)
  instead of only the read-only ones.

## 0.15.6

- **A cold backend start looked like a hung turn from the phone.** The sidebar
  shows a `backendStarting` row while `llama-server` spawns and the weights
  load, but a remote reader cannot see it: the mirrored Telegram progress
  message just said "Forge: working…" through the whole spawn plus a
  multi-second model load, which reads as a stall rather than a startup. A new
  `phase` agent-progress event replaces the headline of the mirrored message
  for exactly as long as the wait lasts, and `text: undefined` restores the
  default. It is emitted from the same 500 ms timer that already gates the
  sidebar notice — so a warm backend, which returns well inside that window,
  still shows nothing at all. The restore sits in the `finally` alongside
  `clearTimeout`, so a spawn that fails cannot leave the startup headline
  outliving the startup.

## 0.15.5

- **The store description was 157 characters, and the Marketplace truncates
  around 130.** "A VS Code coding agent for people who run their own models:
  real llama.cpp/GGUF control, tools built for local context limits, Keep/Undo
  on every turn, no telemetry" lost its last two clauses in search results —
  including *no telemetry*, which is the one claim in the category that most
  competitors cannot make honestly. It was also four comma-separated clauses
  with no verb, and one of them ("tools built for local context limits") is
  precise, true, and meaningless to anyone who has not already hit a per-slot
  context ceiling.

  Now: **"Run your own models in VS Code: full llama.cpp/GGUF control, 60+ agent
  tools, undo any turn, no telemetry."** 106 characters, so nothing truncates.
  Opens with a verb. `llama.cpp` and `GGUF` land inside the first 40 characters,
  which matters twice over — the Marketplace searches description text, and
  those two words are what make the intended reader stop scrolling. Applied to
  both registries and the GitHub repository, which now all carry the same line.

## 0.15.4

- **The Marketplace and Open VSX Overview pages were 38 KB of contributor
  reference.** That page is `README.md`, and nearly half of it was material a
  store visitor scrolls past forever: a forty-row VS Code command-palette table
  (10.6% of the page on its own), the `npm run test:local-tools` harness with
  its vitest environment variables, `cli_idle_timeout_ms` and LRU eviction
  rules, and a llama.cpp log line about LCP slot similarity. It also carried
  three full release sections duplicating a Changelog tab that has existed
  since 0.15.1.

  The page is now 25 KB and product-shaped: Why Forge, screenshots, what the
  agent can do, run it from your phone — then setup. The reference moved
  wholesale rather than being deleted, into `docs/COMMANDS.md`,
  `docs/TOOL_SCHEMA_AUDIT.md`, `docs/SHARED_RUNTIME.md` and
  `docs/DELEGATION.md`, each linked from the summary that replaced it. Nothing
  was lost; it stopped being the first thing a prospective user reads.

  `docs/*` is gitignored with a per-file allowlist, so all four needed an
  explicit `!` entry — untracked would have meant four 404s on the store page,
  since `vsce` rewrites relative links to absolute GitHub URLs.

  Added version, installs and license badges, which the page had never carried.
  Every relative link and in-page anchor is verified to resolve — `vsce`
  rewrites them to absolute GitHub URLs at package time, so a broken one ships
  silently and only breaks on the store page.

## 0.15.3

- **The README never said what the agent can do.** It documented backends,
  config, sharing and delegation in real depth, and then described the agent
  itself with a bullet list. An entire category was missing outright:
  **LSP-backed code intelligence** — `go_to_definition`, `find_references`,
  `find_implementations`, `get_diagnostics`, `apply_code_action`,
  `rename_symbol` and the rest run through VS Code's own language servers, so
  the agent answers "who implements this?" from real analysis rather than
  guessing from a name, and none of it appeared anywhere in the README. So was
  durable cross-session memory (`remember` / `recall` / `list_memories`). A new
  "What the agent can do" section covers all sixty-plus native tools by group,
  and every tool name in it was verified against `src/tools/` rather than
  written from memory.

- **Remote control had one bullet and a link.** Telegram control — a real Forge
  session in a private chat, with approval gates resolvable from either the
  phone or the desktop, live agent and compaction progress, attachments, and a
  queue you can steer — was a single line at the bottom of Highlights. It now
  has a section: the two gates (exact-ID pairing, private chats only, plus an
  enrolled Google Authenticator-compatible TOTP whose QR is shown locally and
  never sent through Telegram), the durability design that makes a dropped
  connection re-deliver rather than lose, the full command list, and the fact
  that the audit log is metadata only.

- **"Why Forge" gained the two reasons it was missing** — the depth of the tool
  surface, and that Forge follows you out of the room.

## 0.15.2

- **The releases page stopped at v0.12.29 in July while 0.13, 0.14 and 0.15
  shipped to both registries.** Nothing in the publish workflow ever created a
  GitHub Release, so the only account of three minor lines lived in a file you
  had to know to open. The workflow now cuts the release body from `CHANGES.md`
  via `scripts/release-notes.mjs` — the same source, not a second one written by
  hand and left to drift — and attaches the exact VSIX the registries received.
  It runs last, so a registry failure cannot leave a release announcing a
  version that never went out. The job needs `permissions: contents: write`;
  this repo's default token is read-only.

  Note for anyone looking: **0.15.0 and 0.15.1 have no GitHub Release and
  cannot get one.** This repo has immutable releases enabled, which reserves a
  tag permanently on first use; both were created, deleted in an attempt to
  attach their VSIX, and are now refused. Their notes are above, in this file.

- **The VSIX is packaged once and reused.** `vsce publish` packages internally
  and keeps nothing, so the Open VSX step built its own copy and the release
  step would have built a third. One `vsce package --out` step now feeds both.

- **`README.md` covered a version and a half of the eleven that shipped.** Its
  "What's New Since v0.12.3" section predated background execution, demand-loaded
  tool groups, the compaction-surviving task plan, terminal awareness,
  `view_video`, recycle-bin deletes, prompt-prefix stability, and the whole 0.15
  context-reduction pass — a reader on the Marketplace page was being told about
  a Forge two lines behind the one they were installing. Replaced with a "What's
  New" section organised by line, and the Highlights list gained the six
  capabilities it never learned about.

- **The extension description says what Forge is for.** "Local coding agent with
  first-class llama.cpp/GGUF control, reliable tools, and Keep/Undo checkpoints"
  led with a category and buried the wedge; "reliable tools" is a claim every
  extension makes. Both registries and the GitHub repo now carry the same line,
  and the repo gained topics and a homepage it had never been given.

## 0.15.1

- **Both registries said "No changelog available" — every release, since the
  first.** They look for `CHANGELOG.md` at the package root; this repo's
  changelog has always been `CHANGES.md`, and `.vscodeignore` excludes `*.md`
  with only `README.md` re-admitted, so even a correctly named file would not
  have reached the VSIX. `scripts/sync-changelog.mjs` now generates
  `CHANGELOG.md` from `CHANGES.md` as part of `npm run package` and
  `npm run publish`, and `.vscodeignore` re-admits it. A generated copy rather
  than a rename: `CHANGES.md` is referenced by `CLAUDE.md`, `docs/OWNERS.md`
  and years of commit messages, and churning all of that to satisfy a
  packaging convention would be the wrong trade. The copy is gitignored — it
  is a build artifact, and committing it would create a second file that
  drifts from the real one.

## 0.15.0

- **The system prompt is 585 tokens lighter, with nothing lost.** It was 3156
  tokens on every request — `execute.njk` plus this workspace's `FORGE.md` —
  and four blocks in it were paying rent they did not earn.

  *Plan governance moved to the tail.* 378 tokens of rules for how to follow a
  recorded plan sat in the system prompt of every conversation, including the
  majority that never record one. They are only actionable when a plan exists,
  so they now ship with it: `PLAN_GUIDANCE` in `src/tools/planTools.ts`,
  appended to the plan in the turn-context block. The tail specifically, never
  a conditional at the head — content that appears when `update_plan` first
  fires would invalidate the whole KV cache mid-conversation, the failure
  `PROMPT_PREFIX_STABILITY_PLAN.md` measured at 4971 re-evaluated tokens for a
  single changed line. It is appended after `PLAN_RENDER_MAX_CHARS` is applied,
  so a long plan truncates its own items rather than the rules for reading
  them. The one workspace-specific rule (plan docs must end with an acceptance
  checklist) stays in `FORGE.md`, where it belongs.

  *The `state.vscdb` session-title recipe moved to
  `docs/WORKSPACE_FORENSICS.md`.* 313 tokens — 14% of `FORGE.md`, embedded
  Python one-liner included — for a lookup needed perhaps once a month. A
  four-line pointer replaces it.

  *The model-status block is gone.* It was captioned "verify before relying on
  it": a rule the prompt told the model not to trust, charged in full on every
  turn, and it documented `zai-glm-4.7` as archived — a model not in the
  config.

  *The delegation block was rewritten*, since it still said to pick the
  smallest GGUF to minimise OOM risk. Forge now asks the user before any target
  that loads local weights, and the ranked list prefers CLI agents outright.

  Not touched, deliberately: the scripts and test-layout facts look equally
  derivable from a tool call, but a round trip on a local model costs far more
  than their 157 tokens. And `execute.njk` appears to restate roughly 150
  tokens of tool descriptions — that needs an A/B, not a guess.

- **`ask_local_agent` no longer spends 285 tokens a turn listing every model.**
  The target list was spliced into its `model` argument description on every
  request — 1027 characters against a real config, ~40% of it ten
  near-identical GGUF quant names, every entry weighted the same as
  `claude-code`. The schema now names only the configured CLI agents and says
  to call `list_delegation_targets`, a new no-arg tool that returns the full
  live list ranked by what each target costs: CLI agents first (their own
  tools, their own process, no VRAM), then cloud, then local with the VRAM
  warning. The same `load_tool_group` trade — one round when the agent needs
  the list, nothing on the turns it does not. Net ~151 tokens back per request.
  The list stays generated from config, so a model deleted from `config.yaml`
  still disappears without a reload.

- **Delegating to a model that loads local weights now asks the user first.**
  `DelegationGate` counts free SLOTS (`max_simultaneous_models`), not
  gigabytes. Set to 4 on a single 16 GB card, delegating from a resident 27B to
  another large GGUF passes every check Forge makes and then thrashes WDDM
  instead of failing — silent degradation, the worst shape a failure can take.
  `ask_local_agent` now returns approval metadata for any target that loads
  local weights, routing it through the existing per-action confirmation gate.
  Cloud and CLI targets take no slot and are not gated, and an Ollama entry
  tagged `:cloud` is correctly classed as cloud (it reaches the daemon like a
  local one but runs remotely) — `classifyModelRoute` is the owner of that
  distinction, and `eligibility.ts` now carries `localWeights` per target. A
  name that does not match a known target — a fuzzy alias or `model@profile`
  the handler still resolves — falls to the safe side and asks.

- **`wait` names its coding uses.** Its description covered interval pinging
  and rate-limit backoff but not the two cases where it is the only option: a
  dev server or file watcher launched in the background needing a moment before
  it will answer, and a file just written needing one before an index or
  watcher reflects it. Waiting once beats retrying a check that cannot succeed
  yet. `monitor_execution` is still the answer for waiting on a specific
  command.

- **A remote command is no longer held across a TOTP challenge, and `/reload`
  no longer runs twice.** Two separate mistakes stacked into one bug. First,
  the challenge branch held *any* text, so `/reload` typed at a locked session
  was armed and fired the moment the 6-digit code arrived — a command running
  at a moment its sender did not choose. Second, `/reload` awaited
  `workbench.action.reloadWindow`, which tears down the extension host: the
  code after it never ran, so `handleRemoteCommand` never marked the durable
  control receipt completed and the Telegram transport never committed its
  update cursor. The command was redelivered on the next start, un-receipted,
  and ran again. Now only a prompt is held (the reason to hold one is that it
  is expensive to retype, which a command is not), and `/reload` returns first
  and reloads a second later, so both the receipt and the cursor land and a
  redelivery is recognised as already handled. `/steer` still holds — it
  carries a prompt.


## 0.14.3

First changelog entry for the 0.14 line: 0.14.0 through 0.14.2 shipped as
local builds without their own sections, so everything below has accumulated
since 0.13.20. All of it is in 0.14.3.

- **HalluScribe's six MCP schemas are demand-loaded.** They cost 2382 tokens of
  every single request — measured, `test/prompt-context-measurement.txt` — on
  conversations that never ask about a past session. A fresh conversation now
  sees one 125-token `load_tool_group` tool instead; calling it with
  `group: "halluscribe"` marks the group active and the six real schemas arrive,
  unchanged, on the next round. Net recovery on an ordinary coding
  conversation: 2382 tokens (11014 static instead of 13396). Activation is per
  conversation and in memory only — a new chat starts unloaded, and nothing is
  written to `config.yaml`. HalluScribe stays connected and dispatchable
  throughout; only advertisement changes, and no other MCP server is affected.
  `src/tools/lazyToolGroups.ts` is the sole owner of which server is lazy.

  Validated live against Qwen3.8-27B (`test/live/LazyToolGroups.live.test.ts`,
  gated on `FORGE_LIVE_LAZY_TOOLS=1`). From the 125-token description alone and
  with no prompt hinting, the model opened both history questions with
  `load_tool_group` and went straight into the real tools --
  `load_tool_group -> search_sessions -> read_session -> read_tool_result` for
  "what did we decide about the prompt cache", and
  `load_tool_group -> search_sessions -> search_raw_transcripts -> ...` for
  "find the exact llama-tokenize error". An ordinary read-package.json request
  in a separate conversation never touched it.

- **The model-facing tool list is rebuilt every round, not once per turn.**
  `ModelTurn` snapshotted `toolDefinitions` before the loop started, so a group
  activated mid-turn could not reach the request that followed — the tool would
  have reported itself enabled while the next request still omitted its schemas.
  `ToolCallingLoopOptions.toolDefinitions` is now `getToolDefinitions()`, called
  once per round; the context-budget math reads the same live list, so the
  2382 tokens are accounted for on the turn they appear.

- **Stopping the backend no longer leaks a llama.cpp port.** `stopAll()` deleted
  its slot map entries directly instead of freeing them, so every Stop,
  `/unloadModel`, `forge.stopBackend`, and `forge.restartBackend` permanently
  lost that slot's port. `freePorts` is built once in the `BackendPool`
  constructor and never rebuilt, so with `max_simultaneous_models: 4` the fourth
  stop exhausted the pool and every later load failed until the window was
  reloaded. `StopAllContext` now carries the real `PoolSlot` (its old structural
  slot type did not even include `port`, so the leak was not expressible) and a
  `freeSlot` callback. The port-accounting tests covered `release()` thoroughly
  and never called `stopAll()` once; two regression tests now do.

- **An exhausted pool no longer blames delegation.** `claimPort` threw "all
  resident models are pinned by active delegation holds" whenever `lruSlot`
  returned nothing — including when the slot table was *empty*, which is a
  bookkeeping bug rather than capacity pressure. The empty case now says so.

- **Agent questions reach whichever surface started the turn.** `ask_user` used
  to talk straight to `vscode.window`, so a question raised during a Telegram
  turn opened a box nobody was looking at, and the desktop box was dismissed by
  any focus change — the model saw `(cancelled)` for a question the user never
  received. `UserQuestionService` now owns the question, the local box and the
  remote chat race to answer it, and cancelling the turn cancels the question.

- **A prompt sent to an expired remote session is held, not lost.** The TOTP
  challenge now names its cause, holds the prompt for 10 minutes, and replays it
  with an echo once the code lands. Repeated wrong codes, `/lock`, and unpairing
  the owner all drop the held prompt.

- **`/reload` restarts the extension host from the remote chat**, and
  `remote.attachments.retain_days` accepts up to 365 days or `null` to keep
  attachments forever — previously capped at 30 with no way to disable pruning.
  Both shipped inside commit `15894f2`, whose message mentions neither; `git
  bisect` on either will point at the wrong change.

- **Auto-compaction now recovers context-exhausted remote turns.** A tool-call
  exhaustion was recorded as an incomplete turn but returned through the failed
  branch before the post-turn compaction policy ran. The shared send pipeline
  now compacts and resumes this recoverable failure for Telegram and every
  other entry surface when auto-compaction is enabled.

- **Telegram prompts can steer instead of waiting behind the queue.**
  `/steer <prompt>` is durably recorded before Forge interrupts the active turn,
  then runs ahead of ordinary queued prompts while keeping FIFO order between
  steering prompts. `/drop <number|all>` cancels queued work, `/context` reports
  remaining room, and Telegram now publishes the supported commands in its
  native command menu.

- **Remote sessions are easier to diagnose without recording content.** The
  metadata-only audit records pairing, authentication challenges/failures,
  successful authentication, locking, and steering admission. The Forge output
  log records request id, conversation id, outcome, and context use, never the
  prompt, response, bot token, TOTP code, or raw Telegram identity.

- **The full tool surface uses less starting context.** Concise schemas for the
  largest native tools preserve their arguments, constraints, safety rules,
  and capabilities while saving 475 exact Qwen tokens in the measured tool
  catalog. No tool was removed or hidden.

- **Telegram remote control now applies replaced bot credentials immediately.**
  `Forge: Set Telegram Bot Token` used to update SecretStorage and then take the
  ordinary in-place config path, leaving the active poller on the old token
  until the extension reloaded. Credential refresh now recreates only the
  Telegram transport; unrelated transports stay up.

- **TOTP-protected Telegram approvals fit the provider protocol.** The approval
  id and auth-session UUID together exceeded Telegram's 64-byte callback-data
  limit, so enabling the authenticator could make every Approve/Deny keyboard
  fail to send. Telegram now receives a short opaque handle while the Forge
  approval id and auth nonce remain server-side and are checked together.

- **Remote progress reports the real terminal state.** Failed and cancelled
  turns no longer edit their live Telegram progress row to “completed,” and a
  busy retry is labelled queued. Telegram text chunking also preserves complete
  Unicode code points at the 4,096-character boundary instead of splitting an
  emoji in half.

- **The activity line follows the editor's configured font size.** It keeps the
  intended one-pixel emphasis without freezing the webview at 14px for users
  who increase or reduce VS Code's UI font.

- **Remote control gained a complete authenticated phone workflow.** The
  optional Telegram surface now includes owner-bound Google
  Authenticator-compatible TOTP sessions, inactivity locking, conversation and
  model controls, workspace handoff, attachments, durable notifications, and
  live agent/compaction progress. It remains opt-in and uses the normal Forge
  execution, confirmation, checkpoint, and model paths.

- **The agent can read the editor you are looking at, not just write to it.**
  `replace_selection` and `insert_code` have always written into the active
  editor, but nothing could read it back — so "fix this" with a block
  highlighted gave the model no way to see what "this" was, and it fell back to
  re-reading whole files and guessing. `get_editor_context` returns the active
  file, the selected text with its one-based range, the cursor position, and the
  paths of every open tab. It is one call rather than three tools because the
  three facts answer one question, and every tool definition is prompt weight on
  each request.

- **`find_implementations` answers "who implements this?"** On an interface or
  an abstract method, `find_references` buries the handful of implementations in
  every call site. The implementation provider returns only the concrete types.
  It reads `LocationLink` as well as `Location`, the shape mismatch that broke
  `go_to_definition` on every JS file.

- **`git_show` could always read a file at a past commit; nothing said so.** The
  ref is passed straight to `git show`, so `HEAD~1:src/app.ts` has worked from
  the start — but the description said "show a commit or object" and the agent
  never tried the `<ref>:<path>` form, checking branches out instead. The schema
  now spells it out. No behaviour change.

- **`delete_file` moves things to the recycle bin instead of destroying them.**
  Every deletion went through `fs.rmSync`, so an approved mistake was gone —
  the per-turn checkpoint covers file *edits*, not a directory the agent removed
  outright. Deletions now route through `vscode.workspace.fs.delete` with
  `useTrash`, and the confirmation dialog says "About to move to the recycle
  bin" and names the deletion as recoverable. A new `to_trash: false` argument
  restores the permanent behaviour for build output and other cases where
  filling the bin is the wrong trade. Filesystems without a recycle bin —
  network shares, most remote paths — surface the failure and tell the agent to
  retry with `to_trash: false` rather than silently deleting for real.

- **The agent sees the commands you run in your own terminal, and corrects
  them.** Watching only Forge-pasted commands solved half the problem: the
  common case is the user typing a command themselves, getting an error, and
  asking the sidebar what went wrong — at which point the agent had nothing but
  the question. `TerminalCommandTracker` now records every shell-integration
  execution, keeping the last five with their exit codes and up to 4k characters
  of output each. The turn context carries the newest command plus any recent
  failures, and `execute.njk` tells the agent to name the mistake and reply with
  the corrected command rather than asking for output it already has. Commands
  are still only visible from the moment they run: scrollback and shell history
  are never read, and `forge.terminal.watchUserCommands` turns the capture off
  for anyone who would rather keep their terminal to themselves.

- **The agent can see how a command it pasted turned out.** `run_terminal`
  pastes into a terminal Forge creates and never presses Enter, so until now the
  outcome was invisible: the agent suggested a command, the user ran it, it
  failed, and the agent's only move was to ask them to paste the error back.
  `TerminalCommandTracker` registers each pasted command against the terminal it
  went to and reads the result off VS Code's shell-integration execution events,
  so the next turn carries the command, its intended and actual working
  directory, the exit code, and up to 12k characters of output. Scope is
  deliberately narrow: the listeners drop any execution in a terminal Forge did
  not create, no scrollback or terminal history is ever read, and captured
  output is labelled untrusted in the turn context. `execute.njk` tells the
  agent to consult that context before asking the user to repeat something Forge
  already supplied.

- **"Starting backend, please wait…" / "Backend ready." only appear when a
  backend actually starts.** `runLocalProviderTurn` announced the start
  unconditionally and answered it unconditionally, so every prompt in a session
  left two permanent system rows in the transcript — on a warm pool the acquire
  they described returned in single-digit milliseconds. The announcement is now
  armed on a 500 ms timer that the acquire cancels, so a cold `llama-server`
  spawn still reports itself seconds before the wait gets uncomfortable and a
  warm one says nothing. The reply is gated in the reducer rather than at the
  post site: `READY` still flips `backendReady` (it drives the composer
  placeholder and the recovered-error sweep) but appends "Backend ready." only
  for a conversation that has an open announcement, tracked per conversation in
  `backendStartAnnouncedIds`. A failed start clears it, so the error row is the
  only answer given. `CliTurn` has gated the same pair on the first prompt of a
  session all along; this is the local-backend equivalent. As a side effect
  cloud turns, which post `ready` with no backend to start, stop claiming a
  backend became ready.

- **New conversations are labelled "Untitled chat".** It is a placeholder, not
  an action, so it cannot be confused with the New chat button. `deriveTitle()`
  replaces it with the first prompt's first line. `isUntitled()` recognises
  older stored `'Chat'` and `'New chat'` placeholders too, while `displayTitle()`
  translates them at the webview boundary without a migration pass.

- **The sessions panel closes when you pick a session.** Selecting a row is a
  navigation, and leaving the accordion open hid the conversation just chosen
  behind the list it was chosen from. Both selecting actions collapse it —
  switching to an open tab and restoring a closed one — while rename and delete
  leave it open, because walking down the list should survive them. Focus moves
  back to the "All sessions" toggle: the row that had it is hidden along with
  the panel, and without the handoff focus falls to `<body>`.

- **An empty tab now says what the backend is doing.** It rendered nothing at
  all — `MessageList` mapped an empty array — so the only way to learn whether
  the model was resident was to send a prompt and wait out a possible 40-second
  load. A new tab shows the Forge mark plus the model, its residency, and the
  **per-slot** context window (`perSlotContext()`, i.e. `num_ctx / n_parallel`,
  not the over-reported total). Remote routes name their provider instead of a
  load state, because `ModelEntry.residency` is deliberately absent for them
  and rendering `cold` would advertise a VRAM cost that does not exist. This is
  the one thing Forge can put on an empty screen that a hosted-endpoint CLI
  cannot: it drives a `llama-server` you spawned, so it has facts to report.
  Deliberately says nothing about `backendReady` — that flag is global while
  conversations run independently, so a failure in one tab would otherwise mark
  an unrelated empty tab unavailable.

- **A restored tab says it was restored.** Reopening the sidebar dropped you
  mid-conversation with no indication whether that exchange was ten minutes or
  three days old. Tabs idle longer than `RESUMED_AFTER_MS` (4h) now draw a
  `resumed · 3 days ago · 12 msgs` hairline above the composer. The set is
  snapshotted once at hydration and held in state, not recomputed per render:
  `updatedAt` moves on any activity, so a live read made the marker vanish
  mid-session and reappear on unrelated syncs. Sending in a tab clears it, via
  both the ordinary send and the Steer path.

- **A queued prompt now names what it is waiting on, and its tab shows it.**
  The row read a bare `Queued`, and `App` filtered queued prompts to the active
  conversation — so a prompt queued in a background tab was *completely*
  invisible, with nothing distinguishing "waiting for the VRAM slot" from
  "hung". The row now reads `Queued — waiting on <model>`, taken from that
  tab's own `active_model` (falling back to the selected model) so a background
  tab on a different model stays honest, and the tab chip carries a static
  amber dot. The dot is deliberately not a spinner: a tab spinning while it is
  merely waiting reads as a hang. Spinner = generating; dot = waiting.

- **The sessions panel lists open tabs, not just closed ones.** The flyout
  behind the clock button showed only closed conversations —
  `historyMetasFromSession()` filters open ids out — so there was no single
  place to see which tabs were running. It now has an **Open** section fed from
  `state.tabs`, reusing the strip's own spinner and waiting dot so the two
  displays cannot disagree, above the existing **Closed** rows (restore,
  rename, delete unchanged). Open rows get no kebab: an open tab is closed from
  the strip. Zero host changes — `SessionTabMeta.streaming` already shipped.
  The badge on the clock button still counts closed sessions only, so its
  meaning is unchanged.

- Split `webview-ui/styles/sessions-panel.css` out of `tabs.css` (408 → 245
  LOC) along the real seam: the tab strip and the sessions flyout are separate
  concerns, and the panel had just grown a second section.

- **`pwsh` was not covered by the PowerShell ban.** `checkPowerShellBan`
  matched `powershell` and `powershell.exe` only, so `pwsh -Command <script>`
  -- PowerShell 7, present on any machine set up for Codex -- walked straight
  past a guard whose stated rationale is that a model-authored script cannot be
  checked by the denylist. The launcher list is now matched as a set, so a new
  PowerShell binary is a new hole rather than a variant of an old one.

- **New tool: `wait`.** Forge could wait for a *process* (`exec_command`
  background plus `monitor_execution`) but had no way to produce a delay: that
  wait resolves the instant the process exits. Asked to ping on an interval the
  agent burned two rounds hunting a sleep binary -- `powershell -Command
  Start-Sleep` banned, Windows `timeout` needing console stdin it never gets
  under `shell: false` -- before landing on `python -c "time.sleep(15)"`, which
  is luck rather than a capability. `wait` is in-process: no shell, no binary to
  be missing, capped at 15 minutes, and it honours the turn's abort signal so /stop
  never leaves a turn parked on a timer. It reports the time it actually waited,
  not the time requested. The PowerShell refusal now names it first.
- **`notify_user`: the agent can reach the chat that started the turn.** Its
  only outbound signal was `show_notification`, a VS Code desktop toast, so a
  turn driven from Telegram lit up a window nobody was looking at. `notify_user`
  is a second producer on the road auto-compaction notices already travel:
  conversationId to bindings to the durable outbox. Fire-and-forget -- no wake,
  heartbeat, or poll; an agent that needs an answer still uses `ask_user`.

  `RemoteController.enqueueHostNotification` now returns how many chats it
  reached instead of `void`. That count is load-bearing: it is what lets the
  tool say "the user did NOT receive it on their phone" rather than reporting
  success into a void, which is how `ask_user`'s bare `(cancelled)` taught the
  model to trust a lie. Capped at 5 per turn, reset on turn START via
  `onGenerationStarted` -- a cancelled turn never reaches its end, and a leaked
  counter would silently mute the agent for the rest of the conversation.

  `/notify on|off|status` mutes one chat, in memory until the window reloads,
  the same lifetime as `/clanker`. Plan: `docs/plans/NOTIFY_USER_PLAN.md`.

- **`/help` and the Telegram command menu now document `/workspace list` and
  `/new <alias>`.** Both were handled and neither was listed anywhere, so the
  only pointer to `/workspace list` was the error text you got after already
  guessing a bad alias. A capability nothing names is one that does not exist.

Plan and mockups: `docs/plans/SIDEBAR_UX_PLAN.md`,
`docs/plans/SIDEBAR_UX_MOCKUPS.html`.

## 0.13.20

- Session transcripts no longer re-write their whole history on every window
  reload. `SessionLogger` keyed its file off the persisted conversation id but
  kept `writtenCount` only in memory, so each reload built a fresh logger over
  the same file and `messages.slice(0)` appended the entire conversation again.
  One audited session held seven copies of itself — 65% duplicate rows, 14 MB
  of a 20 MB file. The cursor is now written to the file as a `cursor` row at
  the end of each flush and recovered from the tail on construction; a
  `session_start` is still emitted per run, so `forge_version` stays per build.
  Safe because `conv.messages` is append-only: compaction is non-destructive
  (it records a summary and a cut index rather than rewriting the transcript).
  This mattered beyond disk — the duplicates inflate exactly the per-tool
  failure audit CLAUDE.md tells you to run on these files, sevenfold in that
  session.

- `query_powershell` refusals now name the tool that will work. It is confined
  to the workspace on purpose — it is the one tool that runs without the
  confirmation gate — but it answered an out-of-workspace path with a bare
  "Absolute paths are not allowed", while `list_directory`, `read_file` and
  `find_files` accept those paths happily. With a workspace at
  `N:\vs code apps\Ssuno` and the actual work under `N:\AI\ComfyUI`, an agent
  spent 7 of its 9 `query_powershell` calls re-attempting the same refused
  shape after every compaction. The refusal now points at the gated file tools
  (or `exec_command` for `get_file_hash`), an absolute path *inside* the
  workspace is answered with its relative form, and the schema says so up
  front. Same rule as the `rm -rf` denylist fix: a refusal that names no
  alternative teaches the agent the capability does not exist.

## 0.13.19

- Hold the volatile turn-context block fixed for the whole turn instead of
  rebuilding it on every tool round. The block folds into the last user
  message, which on round N of a tool loop is the request that OPENED the turn
  -- so an `update_plan` mid-turn rewrote the prompt just after the system
  prompt and invalidated that turn's own rounds. Measured live on a 4-round
  turn with three plan updates: llama.cpp prompt reuse fell from 76% to 39%,
  and two consecutive rounds that grew the prompt by 186 tokens re-evaluated
  15401 of them, ~20 s of prefill each. The plan now reaches the prompt on the
  next user turn, where the prefix is being extended anyway; the model still
  sees the tool result confirming its own write.

## 0.13.18

- Volatile turn state no longer sits at the head of the prompt, where it was
  destroying llama.cpp's KV-cache reuse on every turn. The active editor file
  was rendered into the *system prompt*, and the task plan was folded into the
  *first user message* - so changing editor tabs, or an `update_plan`, rewrote
  the prompt behind the entire conversation. llama-server reuses the longest
  common prefix and re-evaluates everything after the first divergent token,
  so the whole transcript was being re-processed.
  Measured against b10430 on a 4.9K-token prompt: an append-only turn
  re-evaluated 21 tokens in 618 ms, while changing one line near the head
  re-evaluated 4971 tokens in 7605 ms - a 12x prompt-eval penalty with a cache
  hit of exactly zero. Reproduced on gemma-4-E2B (CPU) and Qwen3.8-27B (GPU).
  Both are now injected at the *latest user message* instead, by the new
  `injectTurnContext`. Everything above it stays byte-identical.
- The task plan no longer carries relative age text ("updated about 2 min
  ago"). It was re-rendered on every tool round, so a turn that crossed a
  minute boundary rewrote the prompt head *mid-turn* with nothing else having
  changed. `updatedAt` is still kept on the conversation for the UI; it just
  never reaches the model.
- Forge now logs how much of each prompt the server served from cache
  (`[cache] prompt=24610 cached=24102 (97.9%) evaluated=508`, debug level, no
  prompt contents). llama.cpp reports this directly as
  `usage.prompt_tokens_details.cached_tokens`, so a future regression of this
  kind is visible rather than inferred.
- `--cache-reuse` was evaluated as a cheaper alternative and rejected: it is
  disabled by llama.cpp itself for both gemma (sliding-window) and Qwen3.8
  (hybrid/recurrent) on b10430 and b10621 alike, since neither architecture
  supports KV shifting. No config knob was added for a flag that silently does
  nothing.

## 0.13.17

- Switching a conversation that contains images to a projector-less model no
  longer kills the turn. The vision gate only ever checked the *new* prompt's
  attachments, so with nothing freshly attached it was a no-op and the
  `image_url` parts already in history — from an attachment, `view_image`, or
  `view_video` — went on the wire anyway and came back as
  `HTTP 500: image input is not supported`. The conversation stayed dead until
  the images were cleared or the window reloaded. Images are now replaced with
  an explanatory note in the model-facing copy only; `conv.messages` keeps the
  pixels, so switching back to a vision model restores them. Covers llama.cpp,
  Ollama and cloud in one place, because the strip happens at the single
  `prepareMessages` choke point.
- The strip is never silent. Every turn it happens posts a `notice` row in the
  transcript naming the model, the number of images affected, and the
  `capabilities: [vision]` / `mmproj_path` line to add if the model actually is
  multimodal — plus a once-per-model toast for the user who just switched in the
  picker and is not reading the transcript. It also says the remedy expires at
  the next window reload, because base64 has never been written to
  `workspaceState`: switch models first, or the images are gone either way. Silence here has two failure modes,
  both of which look like a broken model rather than a config fact: the model
  says it cannot see an image that is visibly sitting above it, or it guesses at
  one and nothing is left to contradict the guess.
- `HTTP 500: image input is not supported` is now translated at the client into
  a message naming the model and `mmproj_path`, on both the non-2xx response
  path and streamed SSE error frames — the same treatment truncation parse
  errors already got. Only the response path reports an HTTP status; a stream is
  already 200 and has none to report.
- A reloaded conversation now says that it lost its images, which affects
  vision models exactly as much as text-only ones: image data has never been
  written to `workspaceState`, so a restored transcript carries a note where its
  pixels used to be. Previously the model would correctly ask for a re-attach
  while the user saw only a bracketed note in their own message and no
  explanation — the same "looks like a broken model" shape as the capability
  case, triggered by a reload instead. Announced once per conversation per
  session, because unlike a model switch there is nothing the user can do to
  undo it. Unloading a model does not trigger this; only a window reload,
  extension host restart, or reopening the workspace does.
- New optional per-model `image_retention_turns` ages images out of long
  conversations even on a vision model, where they otherwise occupy the
  per-slot context forever (worst with `view_video`, which injects N frames at
  once). It counts later **user** messages, not protocol messages, so a
  tool-heavy round cannot evict an image you just attached, and the note says
  how to get the image back rather than implying it is gone. Omitted means
  never age out, which stays the default — there is no implicit fallback.

## 0.13.16

- A background job that prints nothing no longer costs the turn. `monitor_execution`
  now returns `suggested_next_wait_ms`, a geometric backoff (10s → 20s → 40s → 60s)
  derived from the *requested* wait, that resets to 10s the moment new output
  appears. The agent has to stay parked inside a live turn to observe a background
  job — Forge has no auto-wake, by design — so every poll spends one of the turn's
  `max_tool_rounds`. At the old 10s default a 20-minute download cost 120 rounds and
  the turn died waiting; at the ceiling it costs 20. Once the ladder leaves the
  default, a `silence_note` also says why silence is not evidence of a stall
  (progress bars redraw with a carriage return and never reach a pipe) and where to
  look instead.
- `list_directory` now reports each entry's size and how long ago it was modified,
  so "is this job still making progress?" is two calls and a comparison rather than
  a hand-written `python -c` with `os.path.getmtime`. Directories over 500 entries
  are listed without metadata and say so. `list_directory` moved to
  `src/tools/listDirectoryTool.ts`; `dirTools.ts` keeps the two ripgrep-backed
  search tools.

## 0.13.15

- Delegation to an Ollama model whose `provider` is inherited from a `group`
  works again. `BackendPool.isOllamaModel()` scanned the raw `config.models`
  entry, but group merge runs at request time only, so every such model was
  classified as llama.cpp: gated on a free llama-server slot it did not need,
  reported as a guaranteed rather than best-effort hold, and — with
  `shared_runtime` enabled — dragged into the shared-runtime key derivation,
  which composes a llama-server argv and threw `missing gguf_path for llama.cpp`
  before the daemon was ever contacted. That last path made `ask_local_agent`
  delegation to those models fail outright. Confirmed live against a running
  daemon, pre- and post-fix (`test/live/OllamaGroupDelegation.live.test.ts`,
  gated on `FORGE_LIVE_OLLAMA=1`). The classifier is group-resolved now, the
  same fix `ControlModelCatalog.entryFor` already carries for the identical
  defect.

- The command-palette model picker resolves `provider` through the model's
  group too. It read the raw entry, so a grouped model was labelled
  "llama.cpp" in the quick pick and, on selection, handed to the backend pool
  — a grouped `provider: cli` agent or cloud model would have been routed as
  a local llama.cpp load instead of being recognised. Third instance of the
  same raw-scan defect.

- An expanded tool result only renders as Markdown when the tool actually
  returns prose. `read_file`, `exec_command`, `git_diff` and everything else now
  render verbatim in a monospace block, because their output is not prose: a
  `# comment` line in `config.yaml` was being parsed as an H1, and since nothing
  in the stylesheet sized headings, it painted at the browser default 2em inside
  a 12px row. Reading a commented YAML or shell file turned the transcript into
  banners. `rendersAsMarkdown()` in `src/sidebar/toolResultView.ts` owns the
  split — an allowlist, so a tool added later renders verbatim by default rather
  than exploding. Headings are also sized now, in both the tool body and the
  assistant message body, so a delegated agent's `# Report` stays proportionate.

- The streaming status line now deals its phrases from a shuffled bag instead of
  drawing one at random each rotation. With 26 phrases in the local + Clanker
  pool and a 12s hold, independent draws needed roughly 100 picks — about twenty
  minutes of unbroken streaming — before every phrase had shown once, so the
  rarer ones went unseen for days. The bag deals each phrase exactly once per
  cycle and persists across turns, which is the part that matters: most turns
  are short enough to show two or three phrases, so a deck reset per turn would
  never get past the top. Each pool composition keeps its own deck, so toggling
  Clanker Mode or switching to a cloud model does not discard progress through
  the other one, and the rotation still never repeats the phrase on screen.

- A compaction summary now carries what the agent *did*, recorded by Forge from
  the tool calls rather than described by the summarizer. Every entry is
  classified from its paired tool result: a write that failed reads `FAILED`, a
  write whose result never arrived (the normal state for a compaction that
  fires mid-turn) reads `ATTEMPTED … outcome unknown`, and commands carry their
  exit codes — `ran \`npm run ci\` → exit 0`. Previously a resumed agent had only
  model-written prose, could not tell a claim from a verified fact, and re-read
  the files to find out; that re-verification is the cost this removes. The
  classifier uses Forge's own result contract (`Error:`, `User declined:`, both
  ToolBudget refusals, the reload marker), because a check for `Error:` alone
  would have reported a user-declined write as a completed one.
- Compaction also records the working tree: unstaged, staged, and
  `git status --short` together, so untracked files and staged work are visible
  — a plain `git diff --stat` shows neither, and an agent that had just created
  and staged three files would have read an empty diff and concluded nothing
  happened. The three commands run concurrently, are bounded at 3s, and a
  failure returns nothing rather than losing the summary.
- New `update_plan` tool: the agent's task list is now conversation state
  rather than transcript text, so a compaction cannot summarize it away. It is
  re-injected verbatim each round (after the system prompt, never between an
  assistant's tool calls and their results), bounded at 20 items × 200 chars,
  auto-approved so marking an item done is never gated behind a confirmation,
  and persisted for live *and* archived conversations. Worst case after a
  compaction is one stale item instead of a plan rebuilt from prose.
- The post-compaction resume prompt no longer says "do not redo work" — a
  prohibition a model breaks the moment it feels uncertain. It now points at
  the host-recorded blocks and permits verification exactly where they are
  silent: entries marked FAILED or unknown.

## 0.13.14

- `ask_local_agent` can now delegate to a configured cloud model (xAI,
  OpenRouter, OpenAI-compatible) and to Ollama cloud-routed models. The old
  block was a VRAM-capacity rule applied to targets that hold no local slot, so
  the agent's only route to OpenRouter was curl'ing the control server's
  `/chat` proxy through the terminal. Cloud targets skip the backend hold
  entirely — a second opinion now works *while* the local slot is busy — and
  get a 300s timeout instead of the 120s sized for a resident local model. A
  non-local Ollama endpoint is still refused; Forge holds no auth for someone
  else's daemon.
- `ask_local_agent` now names its callable targets in its own schema. The
  `model` arg was a bare string with no list anywhere — not in the schema, not
  in the system prompt, and no tool enumerates models — so the only way to
  learn that `qwen/qwen3.8-max` is a legal value was to read config.yaml, ~9k
  tokens of context spent before the first delegation and a standing invitation
  to invent model names. The hint costs ~300 tokens and is rebuilt per turn, so
  a model added to config.yaml appears without a window reload.

## 0.13.13

- Model name is centred in the picker. The chevron is out of flow so it no
  longer pulls the name off-centre, and its lane stays reserved so a long name
  ellipsises before reaching it.

## 0.13.12

- Streaming status line is larger (0.78em -> 0.92em) with a matching 7px dot; it
  sat below comfortable reading size for an ambient line.
- New phrases: "Something smells burned..." (local) plus a route-agnostic shared
  pool, "Sloppy coding..." and "No code for you...".
- Removed the three bouncing dots from the transcript. They stated the same fact
  as the streaming line above the composer, which stays put while the transcript
  scrolls, so the dots were duplicate motion in a worse place.

## 0.13.11 - slower phrase rotation

- Streaming phrases rotate every 12s, up from 6s. The line sits under the text
  you are reading, and anything quicker pulls the eye to it.

## 0.13.10 - stop the idle dot blinking, slow the phrase rotation

- **The blue dot blinked forever, even with nothing running.** It was hidden
  with `opacity: 0` while a keyframe animation drove that same property, and a
  running animation outranks normal declarations in the cascade — so the idle
  rule never applied. The dot is now hidden with `visibility`, and the
  animation is attached only while a turn is streaming.
- **Phrases rotate every 6s instead of 3.5s.** At 3.5s the line pulled the eye
  away from the text it sits under, which is the opposite of what an ambient
  indicator is for.

## 0.13.9 - one streaming line, and it has opinions

- **The status line rotates through a pool of phrases.** With no spinner glyph
  a fixed line sits motionless for the length of a cold model load, and a
  motionless indicator cannot tell working from hung — so the rotation is the
  liveness signal, not decoration. Local turns talk about your own hardware
  ("Melting VRAM…", "Heating the room…"); Clanker Mode adds its own set.
- **Cloud turns get their own pool** ("Burning credits…", "Renting a GPU…").
  Claiming local VRAM load during an xAI or Ollama-cloud call would undercut
  the residency signalling the picker now does honestly — and the wording
  quietly tells you when a turn went to the wrong model.
- **No phrase claims progress.** "Almost there" is unknowable, so nothing in
  any pool says it. A unit test enforces this.
- **The line no longer moves the page.** It kept its own bordered strip that
  appeared on stream start and pushed the composer down exactly as text began
  arriving. It is now always mounted at a reserved height, borderless, and
  clips rather than wraps when the sidebar is narrow.
- **Screen readers get a fact, not a joke every 3.5s.** The rotating text is
  aria-hidden; a stable "Generating" lives in the live region instead. The
  blinking dot honours prefers-reduced-motion.
- Removed the dead header typing-dot indicator, which had been display:none
  but still expanded the header row on every turn.

## 0.13.8 - the model picker says whether your next send pays a cold load

- **Readiness dot in the model picker.** Picking a model only *pins* it; the
  llama-server spawn happens on your first send. On a single-slot card that
  means the next turn can evict what is resident and spend tens of seconds
  reading weights, with nothing in the UI saying so beforehand. Each local
  model now shows solid (loaded and ready), hollow-pulsing (resident, still
  starting) or dim (cold — the next send loads it).
- **No dot for remote models.** Residency is meaningless for a model Forge does
  not host, Ollama *cloud* included — it reaches the daemon on localhost but
  holds no VRAM here. Showing those as "cold" would advertise a load cost that
  does not exist, so they get no dot at all.
- The dot is polled, not pushed, and lags reality by at most 1.5s. Slot state
  mutates in nine places across five files; a signature compare cannot rot the
  way an emit call that someone forgets to add can. It only runs while the
  sidebar is visible. See `docs/plans/MODEL_READINESS_DOT_PLAN.md`.

## 0.13.7 - rename a chat from the history row; model picker by the prompt

- **History rows can be renamed.** The only control on a row was a 12px trash
  icon held at opacity 0 until hover — a permanent, unrecoverable action that
  was invisible until the cursor was already on top of it. Rows now carry a
  kebab at half opacity in a real 28×28 target, opening Rename / Delete. Rename
  edits in place (Enter commits, Escape cancels); delete still routes to the
  existing modal confirm. Renaming leaves `updatedAt` alone, so a cosmetic edit
  does not reorder history.
- **Closed chats are renameable at all.** `/rename` only ever retitled the
  *active* conversation, so an auto-derived title like "hello man" could not be
  fixed once the chat was closed without restoring it first.
- **The model selector moved to the composer**, next to the prompt where the
  choice is actually made — it previously sat above the tab strip, the history
  panel and the whole scrolled transcript. The dropdown opens upward. The token
  budget stays in the header: it is ambient status that has to stay readable
  while scrolling, not only when you look down to type.
- **The history list stops slicing a row in half** at the scroll boundary.

## 0.13.6 - say what happened to missing output

- **"Capped, call again" and "gone for good" are no longer the same flag.**
  `stdout_truncated` meant both, so an agent could not tell whether more output
  was waiting or whether it had permanently missed some. Given a 4.7 MB job it
  guessed wrong, decided the cursor API was broken, and fell back to writing a
  file. `monitor_execution` now reports `stdout_more_available` (keep calling)
  separately from `stdout_dropped_chars` (that much is unrecoverable), plus
  `stdout_oldest_available_cursor` so the retained window is visible rather
  than something to infer from cursor arithmetic.
- **A dropped-output note names the way out.** When the retention cap has eaten
  part of a stream, the result carries a note saying how much went, where
  reading resumed, and that redirecting to a file is the way to capture a noisy
  job from the start — instead of leaving the agent to work that out and lose
  confidence in the tool on the way.

## 0.13.5 - background execution reporting fixes

- **Truncated output can be read to the end.** `monitor_execution` capped the
  output it returned but reported the next cursor as the end of the whole
  stream, so everything the cap held back was unreachable: `stdout_truncated`
  told the agent it had missed output and then gave it no way to fetch it. The
  next cursor is now computed from what the call actually returned, so repeated
  calls page through the retained buffer. `tail_lines` still consumes to the
  end, since a caller asking for the tail does not want to resume mid-buffer.
- **`waited_ms` is measured, not requested.** It echoed the `wait_ms` budget
  even when the process finished — or the turn was cancelled — a fraction of
  the way in, which made it impossible to tell a prompt return from a full
  wait, including when checking whether cancellation worked at all.
- **Execution timestamps say they are UTC, and elapsed time is reported
  directly.** `started_at` / `finished_at` are now `started_at_utc` /
  `finished_at_utc`, and both `list_executions` and `monitor_execution` carry
  `ran_for_ms`, so "how long has this been running" no longer requires
  subtracting two ISO strings against a clock three hours off.

## 0.13.4 — video frames, background execution follow-ups

- **`view_video` extracts frames for vision models.** A new tool pulls frames
  via ffmpeg (`ffmpeg_path` and `frame_max_dimension` under a new `video:`
  config block) so a vision-capable model can look at a clip. Models without
  vision get an explicit unavailable message naming the model rather than a
  silent no-op.
- **Every spawned process now gets an upper-case Windows drive letter.** VS
  Code's `Uri.fsPath` lower-cases it, so a workspace on `N:` reached `spawn` as
  `n:\...`. Node runs that fine, but tools resolving module ids against `cwd` —
  anything on Vite — key the same file under two spellings and load two copies
  of their own module graph. `npx vitest run` failed all 140 files at `describe`
  with "Cannot read properties of undefined (reading 'config')", which reads as
  a broken test suite and was a broken path. Normalising happens at the spawn
  itself, so it covers every tool, not just `exec_command`.
- **Background executions can no longer run forever unnoticed.**
  `exec_command` now honours `timeout_ms` when `background: true`, arming a kill
  deadline that reports `terminated` with the elapsed limit in `error`. There is
  deliberately no default deadline in background mode — inheriting the 30s
  foreground default would have killed every long job it exists to support — so
  the schema now states both halves of that rule.
- **`list_executions` recovers a lost `execution_id`.** The agent's own record
  of an id does not survive a `/compact`, which left a running job unreachable
  and unstoppable until the window closed. The new tool lists every execution
  the session still knows about, with status, pid, cwd, and exit code.
- **`stop_execution` no longer prompts.** Stopping a job the agent itself
  started is less risky than starting it was; gating the stop harder than the
  start only added friction.
- **A background command that fails to launch says so immediately.** The status
  was read in the same tick as the spawn, before Node reports a failed launch,
  so a process that was already dead came back as `running`.

## 0.13.3 — image handling, permission visibility, and an explicit risk statement

- **The README states the risk in plain language.** A new "Responsibility and
  Risk" section says the authors accept no responsibility for lost work,
  deleted files, destructive commands, or unwanted git operations, restates the
  Apache 2.0 AS-IS terms, and lists what each safety measure does and does not
  cover. The example config carries a short pointer to it.
- **The shipped example config no longer trips its own deprecation warning.**
  It set `permissions.agents.cloud_workers`, removed in 0.13.0, so every user
  copying it got a warning toast on first load. It also now documents `groups`
  (referenced by a model in the file but never defined), `model_dirs` (empty
  means the model browser scans nothing at all), `custom_instructions`, and
  `log_level`, and states that `net.search: true` does nothing without a
  `search:` block.
- **A partial `permissions` block no longer switches capabilities off in
  silence.** Naming any one group makes the schema defaults authoritative for
  every other group, so adding `fs.delete` to grant one tool also revoked
  `web_search`, and `net.fetch` stayed off because nobody knew to set it — the
  only symptom either time was a tool missing from the model's list, which
  reads as a broken model rather than as config. Forge now warns at config load
  and names the exact keys to set, once per distinct message per session.
- **`read_file` no longer decodes binary files.** It read every path as UTF-8
  with no size cap, so a 1.3 MB PNG returned roughly 1.3 million replacement
  characters and could exhaust a single-slot context in one tool result. It now
  refuses binary content, names `view_image` when the file is an image, and
  caps text reads at 120,000 characters with an instruction to re-read a
  narrower `start_line`/`end_line` range.
- **A model without a vision projector is told why it cannot see images.**
  `view_image` was only withheld from the advertised tool list while remaining
  in the registry, so a model calling it blind would still ship base64 to a
  backend with no projector, and a model that never saw it went looking for a
  substitute. The call is now refused at dispatch with the reason and a pointer
  to switching models.
- **A prompt sent with an attachment survives a reload.** Persistence extracted
  text only for `role: 'tool'` messages, so a user turn carrying an image had
  array content, failed the string test, and was dropped whole — losing what the
  user had asked along with the picture.
- **Restored image results no longer read as intact successes.** Image data is
  deliberately never written to workspace state, but the reloaded transcript
  still said `Loaded image ...`, inviting the model to describe something it
  could no longer see. Restored turns now carry an explicit note that the image
  is gone and must be re-loaded.

## 0.13.2 — Open VSX release audit

- **The complete dependency audit is clean, including development tooling.**
  Upgraded Vitest and its V8 coverage provider to 4.1.11, esbuild to 0.28.2,
  and the transitive Vite toolchain to patched releases. The migration keeps
  the full test suite and coverage thresholds intact, updates the Vitest
  configuration to native ESM, and adapts a constructor test double to Vitest
  4's JavaScript constructor semantics. `npm audit` now reports zero
  vulnerabilities across production and development dependencies.
- **Production dependency audit is clean.** Updated `js-yaml` and the MCP SDK
  to patched releases, including their URL parsing and HTTP-server transitive
  dependencies. `npm audit --omit=dev` now reports zero vulnerabilities.
- **Delegation and privacy documentation matches the shipped behavior.** The
  README now distinguishes tool-free local-model delegates from read-only CLI
  delegates, removes the last reference to deleted CLI workers, and discloses
  that an explicitly invoked authenticated CLI uses its own network settings.
  The public tool-coverage matrix was regenerated from the current 48-tool
  catalog, removing retired worker tools and access columns.
- **The VSIX contains only release assets.** Removed a duplicate root logo,
  unused palette previews, and an unused SVG logo source from the package. The
  resulting archive contains no source, tests, local configuration, machine
  paths, source maps, or credential-shaped strings.
- **Forge's local-model wedge is clear at first glance.** The README now leads
  with first-class llama.cpp/GGUF control, local-model tool reliability, and
  reversible Keep/Undo checkpoints; Marketplace metadata uses the same
  concrete positioning. Open VSX is documented as an installation source, and
  development guidance uses the canonical `npm run ci` and `npm run package`
  gates.
- **The HTTP streaming smoke test no longer depends on a lucky ephemeral
  port.** Its loopback server retries ports that Fetch classifies as unsafe,
  eliminating a Windows CI failure that appeared only when the OS selected one
  of those otherwise-free ports.

## 0.13.1 — Shared-runtime reliability and worker removal

Supersedes 0.13.0, which was never published. The entries below marked *(found
in smoke testing)* came out of the manual two-window validation rather than the
automated suite — worth noting, because none of the 952 tests caught them.

- **Stop cancels the generation instead of killing the server** *(found in
  smoke testing)*. The Stop button aborted the request and then SIGTERM'd
  llama-server, so cancelling one generation cost a full model reload. Under a
  shared runtime it was worse: the owning window's Stop tore down the server a
  second window had borrowed, silently. Closing a tab took the same path.
  Aborting the request is what ends generation; backend teardown belongs to
  unload and eviction.
- **Re-borrowing no longer leaks the previous lease** *(found in smoke
  testing)*. Re-attaching to a restarted server took a second lease without
  releasing the first, leaving a lease file naming a live process — which
  blocked the owner from ever unloading. The exact failure shared leases exist
  to prevent, reached by a different route.
- **Window close no longer calls `stop()` on borrowed backends** *(found in
  smoke testing)*. It relied on `stop()` throwing into a swallowed catch, and
  skipped attachment-state cleanup. The borrower path is now explicit.
- **`forge.logLevel` is read again** *(found in smoke testing)*. The setting was
  contributed and shown in the settings UI but wired to nothing; only
  `config.yaml`'s `log_level` had any effect.
- **One llama-server output channel, not one per backend** *(found in smoke
  testing)*. Each backend created its own identically-named channel and nothing
  disposed them. Servers now announce themselves with a banner naming the model
  and port.
- **Repository instructions no longer name removed tools** *(found in smoke
  testing)*. `FORGE.md` still told the model to call `dispatch_workers`, costing
  a turn per delegation while it worked out the tool did not exist.

- **Releasing a borrowed model no longer strands the owner.** A runtime
  borrowed from another Forge window is now detached rather than stopped, and
  its lease is released even if detaching fails. Previously the release threw
  before cleanup, leaving a lease that blocked the owning window from ever
  unloading the model.
- **Leases from crashed windows are reclaimed.** Lease files record a PID and
  are discarded when that process is gone or the file is malformed, so a
  force-killed or crashed borrower no longer pins another window's VRAM
  indefinitely.
- **A borrowed runtime now counts as ready.** A window whose only backend was
  borrowed reported the model as loaded but not ready, so the status bar and
  the prompt gate disagreed about the same usable endpoint.
- **Worker dispatch is removed.** `dispatch_workers` and `list_worker_models`
  are gone, along with the coordinator/worker role split, its per-role
  permission and path policy, and the `Forge: Dispatch Workers` command.
  Delegation is unaffected: `ask_local_agent` still asks a second local model
  or an external CLI agent (Claude, Codex) for an opinion.
  `permissions.agents.cloud_workers` remains valid in `config.yaml` so existing
  configurations keep loading, but it grants nothing and Forge warns once at
  startup when it is present.

## 0.12.49 — Reliable resumes, Git batches, and repository instructions

- **Host-initiated turns always expose Stop.** The shared send pipeline now
  announces every accepted turn, including automatic post-compaction resumes,
  and a restored webview recovers busy conversations from the host session.
- **`git_stage` accepts multiple paths from one repository.** Repository
  selection uses one Git API snapshot and compares normalized roots instead of
  wrapper-object identity, while still rejecting genuinely cross-repository
  batches.
- **The context bar follows llama-server's occupied-token counter.** Completed
  local turns retain exact prompt-plus-completion usage, including thinking,
  instead of jumping back to a character estimate after the response lands.
- **`FORGE.md` is Forge's canonical repository instruction file.** It is
  preferred over `AGENTS.md`, resolved per nested repository, injected into
  Forge-native worker prompts, generated by `/initForge`, and—when
  `forge_instructions.auto_create` is enabled—created non-destructively in each
  Git repository VS Code discovers. `AGENTS.md` remains a compatibility
  fallback.

## 0.12.47 — Search, the round cap, and the tools that were quietly failing

- **`search_code` stopped returning its own index instead of your code.** Three
  faults compounded. `.forge/` was never excluded, so the embeddings index — a
  verbatim copy of every indexed chunk — matched nearly any query; being a
  dot-directory it was also the *first* thing ripgrep reached. The exclude globs
  were root-anchored (`!.git/**`), so a monorepo's `subproject/.git/` and nested
  `node_modules/` were searched anyway, while `find_files` had always excluded
  them recursively. And the 50-line output budget was global, so whichever file
  came first spent all of it. Measured on a real workspace, a search for
  "pickup" returned fifty lines of index JSON and not one source file. Excludes
  are now recursive and cover `.forge/`, and a per-file snippet cap stops any
  single file from starving the rest.
- **`web_search` is reachable again — the permission, not the key, was hiding
  it.** `permissions.net.search` defaults to `false`, and once a `permissions`
  block exists at all those schema defaults are authoritative. Any config with
  an `exec` or `agents` group but no `net` group therefore filtered `web_search`
  (and `web_fetch`) out of the advertised tool list entirely, so the model
  truthfully reported having no web search tool — with a valid API key sitting
  in SecretStorage the whole time. Enable it with `permissions: { net: { search:
  true } }`.
- **Web search now authenticates the way Tavily documents.** The key moved from
  an `api_key` body field to an `Authorization: Bearer` header, and a 401 now
  says the key was *rejected* rather than implying it was missing. This is a
  cleanup, not a bug fix: verified against the live API, Tavily still accepts
  the undocumented body form, so a 401 from either form means the key itself is
  bad — check the key before suspecting the transport.
- **The context bar is calibrated against the tokenizer instead of a guess.**
  Chars-per-token was 4, the English-prose figure; measured against llama-server
  on 200,000 chars of real transcript, this workload runs 3.15. The system
  prompt was counted as a flat 200 tokens when the rendered template alone is
  659, because `injectSystemPrompt` builds it outside the message array the
  estimate walks. And reasoning was counted despite never being sent to the
  model — on an agentic turn that is a whole thinking budget of phantom tokens
  per round. The first two pushed the bar low and the third pushed it high, so
  each previous fix appeared to help and then drifted. This matters beyond the
  display: `auto_compact.at` and the 75% warning are fractions of this number,
  so a bar reading 0.85 was really nearer 0.95 of the window.
- **The Stop button survives an automatic compaction.** Compaction posts `done`
  in its `finally`, which clears the webview's streaming state, and the resume
  that follows is host-initiated — so it produced no `USER_SEND` either. The
  resumed turn generated with Stop hidden and only Send showing, leaving no way
  to cancel a turn that was still running. It looked random because auto-compact
  fires on a threshold, not on anything you did.
- **A refusal on one tab no longer disarms another.** `SendPipeline`'s guard
  errors were unaddressed, and the webview resolves an unaddressed message
  against the active tab — clearing *its* streaming state. A background
  conversation refusing a send hid the Stop button on whatever tab you were
  looking at.
- **Running out of tool rounds no longer throws your work away.** The loop
  *threw* at the cap, which discarded the turn's text and left nothing in the
  transcript to say the turn had been cut short — so the next request re-planned
  from a history that looked complete. It now returns, records the stop as an
  assistant turn, and keeps every edit the capped rounds landed.
- **The tool-round cap is configurable.** `max_tool_rounds` on `defaults`, a
  group, or a model — set it once on `defaults` to cover every model
  (built-in default 40, hard ceiling 400) replaces one constant that had to serve both a
  chat turn and a multi-file refactor. Measured on a real session: a turn that
  made 28 successful edits was killed at 40 rounds with the refactor half done.
  The cap's job is to bound a runaway loop, not to decide how big a task may be.
  Hitting it now says so, and names the setting.
- **Tool paths say what they resolve against.** Every `path`, `cwd`, and
  `include` resolves against the workspace root — but nothing said so, and a
  task pointed at a repository *nested* in the workspace ("you are working in
  .../Qwen testing/threejs-game-prompt") would ask for `BUGS.md` and get a bare
  ENOENT naming a path it never chose. The contract is now stated in the system
  prompt and in the tool schemas, including that `search_code` and `find_files`
  already return paths in the accepted form.
- **`edit_file` can apply several edits in one call.** One edit per call is one
  *round* per edit, and rounds are the scarcest thing a turn has: 616 calls
  across recent sessions at an average of 1.62 tool calls per round, against a
  40-round budget. Pass `edits: [{old_str, new_str}, ...]` to change one file in
  a single call. Edits apply in order and all-or-nothing — a miss on any one of
  them leaves the file untouched rather than half-written.
- **`read_file` can number its lines.** `apply_line_edits` wants 1-based line
  numbers and verbatim `expected_lines`, but nothing could produce them: the
  only way to read a file returned bare text, so the model counted lines itself
  and failed **14 of the 19 times** it tried. `numbered: true` prefixes each
  line with its real number, ranged reads included.
- **`find_files` uses ripgrep, like `search_code`.** It used VS Code's indexed
  search service, which on a workspace held on a mapped network drive reported
  "no files match" for paths that plainly exist and are not ignored —
  `threejs-game-prompt/package*.json` among them, **16 failures in 42 calls** —
  while `search_code` was returning those very paths from the same root. Two
  file-matching tools backed by two engines could disagree about what the
  workspace contains. Now there is one engine, one root, one glob dialect.
- **A repeated tool name is no longer concatenated into an unknown one.** Only
  `arguments` is streamed in fragments; the name arrives whole. Appending every
  name delta assumed otherwise, so a provider that repeats it on each chunk
  produced `search_codesearch_code` — dispatched as an unknown tool, and a
  wasted round, every time (measured on `gemma4:31b-cloud`).
- **The `rm -rf` rule no longer refuses scoped deletes.** Its pattern ended in
  `-?[fF]` with the hyphen optional, so any bare "r" in a later filename
  satisfied it: `git rm -f README.md` was refused while `git rm -f notes.txt`
  was allowed. Recursion and force must now both be present as real flags,
  short or long. Every destructive form stays blocked, with tests to prove it.
- **The denylist covers the git commands that actually destroy work.** It
  blocked `git reset --hard` — which the reflog can undo — while allowing
  `git checkout -- .` and `git restore .`, which delete uncommitted changes with
  no confirmation and nothing to recover from. Also now refused: `git push` (any
  push is outward-facing, not only a forced one), `rebase`, `branch -d/-D`,
  `stash drop/clear`, `filter-branch`, and `reflog expire`. `git checkout
  <branch>`, `restore --staged`, `stash pop`, `add` and `commit` stay allowed —
  git itself refuses a checkout that would clobber local edits, so that is not
  the hazard, and a denylist that refuses ordinary work just teaches the agent
  to route around it.
- **A blocked command names the sanctioned route.** `delete_file` went uncalled
  across roughly three thousand tool calls while the agent reached for shell
  deletion and got a bare refusal. Refusals now say what to use instead.
- **`exec_command` stopped refusing ordinary one-liners.** The shell-operator
  guard matched `&&`, `;`, `|`, `` ` ``, `>`, `<` as *substrings* of an
  argument. Commands spawn with `shell: false`, so those characters reach the
  program verbatim and no shell ever sees them — the check prevented nothing and
  blocked a great deal: `node -e "for(let i=0;i<50;i++)console.log(i)"` was
  refused for containing `;` and `<`, which rules out most one-liners, every
  arrow function, every comparison, and every JS template literal. It now
  matches whole argument tokens, which is the thing actually worth catching:
  a model writing a shell line and handing over the pieces as argv.
- **`git_blame`, `git_show`, and `git_diff` on a path find the repository.**
  They spawned git in the workspace root while `git_status` and `git_log` went
  through VS Code's Git API, which *discovers* repositories. In a workspace
  whose repo sits one directory down, half the git tools worked and half
  answered `fatal: not a git repository`. All of them now resolve the repo —
  preferring the one containing the file, so several repos in one workspace
  blame the right one.
- **`go_to_definition` works on JavaScript again.** `executeDefinitionProvider`
  is typed as returning `Location[]`, but VS Code lets a provider answer with
  `LocationLink[]` — and the JS/TS server does. Reading `loc.range.start` on one
  threw `Cannot read properties of undefined (reading 'start')` on every JS
  file. `find_references` was never affected; its provider returns real
  Locations.
- **Session logs keep the reasoning on tool-call turns.** `ToolCallingLoop`
  deliberately carries each round's thinking onto the assistant message, and
  `SessionLogger` dropped it for exactly the turns that have `tool_calls` — the
  turns where the model decides what to do, and where it goes wrong. A 56-round
  session persisted thinking for one turn, the last. Reviewing why an agent
  spiralled meant reading its tool calls and guessing at the reasoning behind
  them. A turn that produced only reasoning is now kept too, instead of being
  skipped for having no content.
- **Language-intelligence tools open the file before asking about it.** VS Code
  providers analyse open documents; a file nobody has opened can report no
  symbols and no hover while plainly containing them — `get_document_symbols`
  answered "No symbols found." for a file whose `export class Game` a text
  search found on line 32. All the path-taking LSP tools now prime the document
  first, and a file that cannot be opened still reaches the provider rather
  than failing on the preparatory step.
- **`insert_code` and `replace_selection` name the file they wrote to.** Both
  target the *active editor* — whichever file the user has focused, which the
  model can neither choose nor inspect — and both replied "Inserted at line 0."
  with no indication of where. A write landing in an unrelated file left nothing
  in the transcript to show it. Their descriptions now say so plainly and point
  at `edit_file`, which takes a path.
- **`run_tests` and `run_build` take a `cwd`.** Both hardcoded the workspace
  root, so in a workspace holding several projects they looked for a
  `package.json` that was never there and failed with a bare ENOENT naming a
  path nobody had chosen. The error now names the directory it searched.
- **A search that finds nothing says why it might not have.** `search_code` is a
  literal search, so a regex like `\.heal\(` cannot match however much of it is
  in the file — and "No matches found" reported that identically to a term that
  is genuinely absent. The miss now names the search mode and the glob it used.

## 0.12.45 — Post-refactor audit fixes

- **A backend that was still starting no longer costs you thinking for the whole
  session.** The capability probe is cached per model, but a probe that failed
  degraded silently to name heuristics — and that degraded verdict was what got
  cached. A thinking-capable model raced at the first turn of a session ran the
  rest of it without thinking kwargs, warned you it did not support them, and
  only recovered on a config change. Degraded answers are now evicted so the next
  turn re-probes; concurrent turns still share one probe.
- **Workspaces whose paths contain `..config` or `..cache` work again.** The
  canonical containment check tested for a `..` prefix rather than a `..`
  segment, so any first path segment merely *beginning* with two dots read as
  traversal and every tool refused the file with "Path is outside the
  workspace". Containment now has one owner, `util/pathContainment.ts`.
- **The last turn before you close the window is recorded.** `last_used` writes
  were debounced 2s with nothing to flush them, so closing within that window
  lost the turn — the exact case the Model Manager's usage view exists to show.
  `deactivate()` now flushes.
- **CI evaluates the bundle, not just the types.** Circular-import and
  module-scope failures type-check clean and only appear on load, which is
  precisely what module reshuffling creates. `npm run ci` now loads the built
  bundle under a stubbed `vscode`.
- Full record in `docs/archive/validation/POST_REFACTOR_AUDIT.md`, including what came back clean and
  the two items left for a decision (coverage-threshold enforcement, oversized
  docs).

## 0.12.44 — Compaction stops leaving the agent stale

- **Auto-compact can now resume the turn it interrupted.** Compaction used to
  end at a notice: the agent parked mid-task holding nothing but a summary, and
  you had to notice and re-prompt. When the previous turn was actually cut off —
  output limit, exhausted context, or the 40-tool-round cap — Forge now
  continues it. A turn that finished cleanly is left alone, `/compact` never
  resumes, and no more than two resumes happen without a prompt from you.
  Configurable as `auto_compact.resume` (default true).
- **A compaction no longer swallows a message sent while it runs.** The cut
  point was read *after* the summary came back, so anything you sent in those
  seconds ended up in neither the summary nor the retained tail — still visible
  in the chat, invisible to the model. The cut point is now taken before the
  summarization starts.
- **The conversation is marked busy while it summarizes.** Nothing was, so the
  input stayed live and a send could race the compaction; prompts are now queued
  and sent when it finishes.
- **Compaction keeps the last exchange verbatim.** The model used to be left
  with a paraphrase and nothing else. The last user turn is retained as-is
  (capped, so a large tool dump cannot be kept whole) and excluded from the
  summary.
- Added `query_powershell`: structured, read-only PowerShell inspection on
  Windows (workspace overview, location, directory listing, file hash). It takes
  named operations, never a raw script.

## 0.12.43 — The thinking pane follows its own reasoning

- **Fixed: an expanded thinking pane never followed the reasoning streaming into
  it.** The pane is its own scroll container (280px tall), so the message list's
  auto-scroll never reached it — past that height new text landed below the fold
  and stayed there. It now pins to the newest text, and stops following the
  moment you scroll up to read back.
- Auto-scroll no longer stalls mid-turn. Every token is a new message array, and
  the smooth scroll restarted its animation on each one without ever arriving.
  Streaming updates now jump instantly; settled ones keep the animation.

## 0.12.42 — Tool calls that outgrow the context no longer lose the turn

- A tool call cut off mid-arguments is now recognised as a truncation instead of
  a malformed call. Previously llama-server's HTTP 500 ("Failed to parse tool
  call arguments as JSON") was read as "this model cannot do native tool calls",
  so Forge stripped tools and re-sent the same oversized request — turning one
  lost call into a lost turn, and eventually disabling tool calling for the
  whole chat.
- On a truncation Forge now tells the model what actually happened — nothing was
  written, this is a size limit — and gives it a hard character ceiling for the
  retry. Two recoveries, then the turn fails with a clear `/compact` message
  rather than spinning.
- Recovery rounds disable thinking. Thinking and the answer share one output
  budget, so a retry that re-thinks starts with less room than the attempt that
  just failed.
- Added `append_file`, so a file too large for one call can be built across
  several. `write_file` and `append_file` both advertise the size ceiling.
- `max_tokens` is now derived from the room actually left in the slot rather
  than from a config value unrelated to it (4096 by default, or larger than the
  entire context where configured). It only ever lowers an explicit setting.
- **Fixed: the context bar and HalluMeter bridge over-reported every model with
  `n_parallel > 1`.** `--ctx-size` is the total across slots and `--parallel`
  divides it, so per-conversation context is `num_ctx / n_parallel`. A
  `n_parallel: 2` model now reads half what it did before — that is the correct
  figure, not a regression.
- A mid-stream SSE error frame is now surfaced instead of silently dropped. That
  class of failure used to end a turn with no message at all.

## 0.12.40 — Live context metering and warm CLI delegation

- The context bar and the HalluMeter bridge now update once per tool round
  during a turn instead of staying frozen until it ends. Ticks are throttled,
  scoped to the conversation, and never trigger auto-compact mid-turn.
- `ask_local_agent` to a `provider: cli` target (Claude Code, Codex) now reuses
  a warm CLI process for the conversation instead of spawning a cold one per
  call. A repeat review no longer re-pays the CLI's system prompt, tool
  schemas, and project instructions as a prompt-cache miss.
- Delegation and sidebar CLI chat now share one session registry, so
  `max_cli_agents` caps the real process count and closing a tab disposes both.
  Delegation sessions are keyed apart from chat sessions so a read-only review
  can never inherit a chat session's write permissions.
- Raised the delegation timeout to 10 minutes for `provider: cli` targets. The
  120s ceiling (unchanged for local models) was aborting working reviews and
  discarding everything they had spent.
- A timed-out or cancelled CLI turn now keeps its session id, so the next
  attempt resumes the existing session instead of starting cold.

## 0.12.31 — Shared runtimes, resilient Codex sessions, and queueing

- Added opt-in compatible llama.cpp runtime sharing between Forge VS Code windows.
- Hardened Codex app-server streaming and final-message recovery after command execution.
- Added queueing for a follow-up prompt while a conversation is streaming, preserving its tab.
- Corrected the control catalog so group-inherited Ollama and cloud providers report their
  actual provider and route.

## 0.12.29 — Config overhaul, Model Manager, CLI subscription agents

- Added schema-v2 config `groups` ("boards") that share tools, context, tool-call
  budgets, and sampling across model sets, layered under existing
  defaults/profiles/aliases, plus a v1→v2 config migrator (backup on write) and
  comment-preserving config writes.
- Added the Model Manager webview: scan a chosen directory, per-parameter tabs,
  model-path view, keyboard navigation, autosave, and delete-from-config or
  delete-from-disk (both confirmed).
- Added deterministic fuzzy worker resolution so short names like "gemma4"
  dispatch to the right model instead of failing on exact-name lookup.
- Added Claude Code and Codex as `provider: cli` agents that run through their own
  subscription login (no API key, no keys stored in Forge).
- Added persistent warm CLI sessions: one reused process per conversation tab
  (bounded pool with idle eviction) so only the first turn pays process startup,
  with checkpoint coverage and disposal on tab close and deactivate.
- Replaced eager whole-workspace CLI `Buffer` snapshots with bounded,
  disk-backed checkpoints, exact hash finalization, byte/file/free-space gates,
  per-conversation Keep/Undo stacks, and rollback preparation before
  `Backend ready`. Large workspaces are now refused safely instead of exhausting
  the VS Code extension host.
- Added the explicit `forge.checkpoint.externalCliEnabled` temporary opt-out.
  Disabling it skips external CLI workspace scans and clearly warns that those
  changes have no Forge Keep/Undo coverage; native Forge tools remain protected.
- Surfaced the CLI `Starting…`/`Backend ready`/disabled-rollback warning only on
  the first turn of a conversation, since later turns resume the warm session
  rather than restarting it; streaming state still updates every turn.

### Tool audit hardening

- Fixed `search_code` startup on current VS Code distributions by resolving the
  platform-specific `@vscode/ripgrep-universal` binary while retaining legacy
  layouts and the final `PATH` fallback.
- Expanded ripgrep startup errors with the resolved command and bundled
  candidates checked, making Extension Host layout failures actionable.
- Reworked `npm run test:local-tools` to derive all 48 native schemas from
  `registerAllTools.ts`, including structured-edit and delegation tools.
- Made strict tool-argument checks structural: reordered object keys now pass,
  while array order and changed values remain significant.
- Added explicit `--include-mcp` discovery, separate native/MCP origin labels,
  schema-emission-only reporting, and exact coordinator/worker catalog tests.
- Added isolated successful handler execution for every native tool group using
  temporary workspaces, repositories, controlled VS Code adapters, and mocked
  network providers; ordinary CI requires no model, GPU, secret, or internet.
- Added opt-in coordinator, worker, tool-free advisory, vision, and semantic
  capability checks with non-overwriting dated reports and a canonical
  native/MCP coverage matrix.
- Added an image-input preflight that explains how to select a vision model or
  configure a compatible llama.cpp `mmproj_path` instead of sending images to a
  text-only model.
- Fixed `run_tests` and `run_build` on Windows by resolving npm/npx shims to
  their adjacent Node CLI without enabling shell execution.

## 0.12.28 — Worker orchestration and safe structured editing

- Added bounded one- or two-worker coding orchestration across configured local
  and explicitly enabled cloud models.
- Added exact read/write worker access contracts, workspace discovery budgets,
  cancellation, backend admission, typed activity status, and coordinator
  review of verified changes.
- Added `apply_line_edits`, a strict atomic multi-edit tool with exact stale-line
  checks, bounded ordered operations, checkpoint integration, and exact worker
  path enforcement.
- Added opt-in local-agent consultation, MCP per-tool permission enforcement,
  non-evicting backend holds, and cancellation propagation.
- Hardened first-run configuration, Add Model preservation, permission gates,
  mutation metadata, and Keep/Undo coverage.
- Expanded the automated suite to 289 tests across 40 test files.

## Session JSONL Logging (HalluMeter + HalluScribe integration)

### What changed

Two files were added or modified to make Forge write conversation sessions to disk,
so that HalluMeter and HalluScribe can read them.

#### New file: `src/sidebar/SessionLogger.ts`

Writes one JSONL file per conversation to `~/.forge/sessions/<session-id>.jsonl`.

Called from `SidebarProvider` after every turn completes (in the `finally` block of `handleSend`).

**File format — one JSON object per line:**

```jsonl
{"type":"session_start","session_id":"<uuid>","title":"Chat","model":"gemma4-e4b-it-ud-q4kxl","timestamp_ms":1747000000000}
{"role":"user","content":"user message text","timestamp_ms":1747000000001}
{"role":"assistant","content":"assistant response text","timestamp_ms":1747000000002,"model":"gemma4-e4b-it-ud-q4kxl"}
{"role":"assistant","content":null,"tool_calls":[{"name":"read_file","input":{"path":"src/main.ts"}}],"timestamp_ms":1747000000003,"model":"gemma4-e4b-it-ud-q4kxl"}
{"role":"assistant","content":"Done.","reasoning":"I checked the file first.","timestamp_ms":1747000000004,"model":"gemma4-e4b-it-ud-q4kxl"}
```

Rules:

- First line is always `session_start` (written once when the first turn completes)
- `system` role messages are skipped
- Tool call messages have `content: null` and a `tool_calls` array
- `reasoning` field is included when the model produced a thinking block
- Messages are appended incrementally — each flush only writes new turns since last flush
- File is never overwritten, only appended

#### Modified file: `src/sidebar/SidebarProvider.ts`

- Imported `SessionLogger`
- Added `sessionLoggers: Map<string, SessionLogger>` field to the class
- Added `flushSessionLog(convId)` private method
- Called `this.flushSessionLog(conv.id)` in the `finally` block of `handleSend`, alongside `persistSession()` and `postTokenBudget()`

#### Also modified: `src/sidebar/SidebarProvider.ts` (HalluMeter bridge)

`postTokenBudget()` also writes `~/.forge/hallumeter-bridge.json` on every token budget update:

```json
{
  "model": "gemma4-e4b-it-ud-q4kxl",
  "used_tokens": 12500,
  "max_tokens": 98304,
  "timestamp_ms": 1747000000000
}
```

This is a single file, always overwritten. HalluMeter polls it every 5 seconds to show the live ring indicator.

Added imports at top of `SidebarProvider.ts`: `fs`, `os`, `path` from Node.js built-ins.
Added `writeForgeBridge()` standalone function before the class definition.

---

### What depends on this

| App         | What it reads                     | Purpose                                       |
| ----------- | --------------------------------- | --------------------------------------------- |
| HalluMeter  | `~/.forge/hallumeter-bridge.json` | Live context fill % for ring indicator        |
| HalluScribe | `~/.forge/sessions/*.jsonl`       | Nightly sweep → Gemma summarization → archive |

### Build note

After any change to `src/sidebar/SessionLogger.ts` or `src/sidebar/SidebarProvider.ts`,
rebuild and reinstall the `.vsix`:

```bash
npm run build
# then install the generated .vsix in VS Code
```
