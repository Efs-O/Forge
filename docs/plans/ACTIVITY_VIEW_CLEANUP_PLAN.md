# Forge transcript cleanup and muted green palette (2026-10-12)

## Goal and baseline

The approved mockups in `artifacts/activity-view-mockups/` show a readable
`grouped` transcript: right-aligned neutral user bubbles, plain assistant prose,
closed activity summaries, one concise live call, details on demand, and a
single-card queued prompt. The current `grouped` view automatically opens a
live group and a pending step, remembers those automatic choices, and exposes
nested thinking/result rows and long shell commands. The current dark-theme
accent (`#34d399`), links (`#6ee7b7`), and diff additions (`#4ec94e`) are
brighter than the owner wants. The focused normal composer inherits that accent.

The three existing setting values remain `full`, `compact`, and `grouped`;
`grouped` remains the default. No model, tool, transcript, checkpoint, remote
delivery, or persisted-session format changes are intended.

## Decisions and implementation

1. **Messages.** In `webview-ui/styles/messages.css`, give ordinary user
   messages a neutral, right-aligned bubble with a bounded width, wrapping and
   theme-aware background/border. Keep assistant text unboxed and left-aligned.
   Do not add role labels. Preserve attachments and existing agent-bus
   `agentSender` badges. Telegram user text has no such badge and uses the
   same bubble without inventing one. Align queued messages to the same edge;
   wrap long prompts and attachments inside the bubble.
2. **Grouped activity.** `groupActivity` currently leaves a one-step run as a
   bare `ActivityRow`; group any run containing at least one tool step so the
   approved one-call summaries exist between narration messages. In
   `ActivityGroup`, default live and completed groups
   closed. Remove automatic disclosure writes so a live group does not remain
   open after completion. User-opened choices still survive remounts and turn
   sync. Failures/retries/edits remain visible in the summary. Keep one
   concise live-call line inside the closed group from argument streaming
   through recorded execution and completion. Keep that line while further
   calls accumulate, so each new call updates the card instead of appearing
   below it and then collapsing into it. Before the first recorded tool row,
   render the streamed call in a provisional group card. `full` and `compact`
   keep their separate `PendingToolCallRow`. Keep exact underlying
   commands/results in the second disclosure level. The summary and live-call
   line use actual metadata; do not invent semantic descriptions. The live
   summary also retains edit totals and failures. Opening **Details** reveals
   individual compact step rows, without another folded run. Opening a step
   reveals its thinking row, full command, and result; reasoning text and diff
   hunks may keep their own disclosures. `full` keeps its current row structure.
   `compact` retains step rows but uses the same no-automatic-open policy.
3. **Headers and spacing.** Keep shell command text ellipsized in collapsed
   step headers, with the complete command accessible when opened. Style the
   group summary as a quiet dark card, reduce nested spacing, and ensure a
   narrow sidebar still shows status, call count, and important failure/edit
   totals. Do not hide errors or approvals behind a collapsed group. Update
   disclosure comments and run behavior that assume automatic opens.
4. **Queued prompt.** Keep `QueuedPromptRow` as the sole rendering owner. Put
   text, delivery state, and Cancel inside one right-aligned card. Keep its
   `tell` versus post-turn-queue wording and cancellation behavior accurate;
   any shorter label must still make clear that delivery has not happened.
   A queued card becomes the ordinary user bubble when admitted, with no
   duplicate text or jump across the pane.
5. **Palette.** Replace neon greens across Forge-owned webview accents,
   links, success marks, diff additions, model indicators, and the normal
   composer with muted forest values. Use dark greens for fills/borders and
   a lighter desaturated green for small text against dark backgrounds; provide
   readable light-theme counterparts. Centralize shared tokens in `base.css`
   and remove separate hardcoded neon greens. Normal composer border is grey
   at rest and forest green on focus; Clanker keeps its distinct warning hue,
   and errors/removals keep red. Preserve keyboard focus visibility and text
   contrast. Audit theme-supplied greens that can bypass Forge tokens. For
   dark backgrounds use approximately `#79a989` for readable muted text and
   `#678f75` for focus/borders; do not use dark fill `#0b5b4e` as small text.
   Include `diff.css`, the model loaded indicator, syntax diff additions, and
   theme-driven tool success. Leave editor decorations that intentionally use
   the user's VS Code theme alone.
6. **Telegram path.** Telegram `/steer` is no longer a command. Eligible
   text-only normal-priority Telegram requests for the reachable running chat
   can be claimed as mid-turn tells at a step boundary; others wait for remote
   queue drain. A remote-started turn is echoed as a user prompt. Both appear
   as normal `role:'user'` transcript messages only when delivered to the
   running turn or started as a new turn, so the shared user-bubble styling
   covers them. A Telegram request waiting in the remote queue is **not**
   `QueuedPromptRow` and must
   not gain the sidebar's Cancel control; `/queue` and `/drop` own that remote
   state. Keep remote ordering, acknowledgement, retry, and cancellation
   semantics intact. Check that accepted Telegram text appears exactly once
   before and after session sync.

## Review findings and implementation status

Implemented on 2026-10-12. The review found that the old folded-run component
would add a third disclosure level after **Details**; it and its unused grouping
helper were removed. **Details** now reveals individual steps, and opening a step
reveals its command and result. Single-step runs now form a summary card. Live
and completed cards start closed unless the user explicitly opened them; that
choice remains in webview memory across remount and transcript sync.

The remote review confirmed that Telegram text joins the transcript only when
claimed as a mid-turn tell or started as a turn. Remote queued text stays in
the existing remote queue, with its existing `/queue` and `/drop` controls.
The visual change therefore needs no Telegram transport or queue mutation.

The palette review found bright green values in shared accents, diff additions,
syntax highlighting, model indicators, and theme-driven success marks. Those
webview-owned values now use muted dark and light theme tokens. The local queued
prompt uses one right-aligned card for text, delivery state, and Cancel.
After installation, the owner observed a visible row-to-card collapse on each
new tool call. The grouped view now keeps the live call preview in the card
across argument streaming, execution, and consecutive calls. A DOM transition
test covers writing → recorded → accumulated calls.

## Review checklist

- Check actual CSS ownership and all green literals/variables, including
  `--vscode-*` values, syntax highlighting, and diff colors.
- Check `groupActivity`'s one-step behavior and
  `ActivityGroup`/`ActivityRow` disclosure persistence, pending progress,
  failures, approvals, and long shell labels against the approved mockups.
- Check the former nested `ActivityRunRow` and current `ToolRow` disclosures. A group click
  should expose calls; a call click should show its exact command and result.
  Long output can scroll within its opened call.
- Check local queued tells, post-turn queue entries, Telegram mid-turn tells,
  and Telegram-started turns separately. The sidebar queued card and its
  Cancel button are local-only.
- Reconcile any mockup shorthand that cannot be produced from recorded
  metadata. Keep user-facing counts and labels truthful.
- Read relevant existing tests and update only tests that assert behavior the
  owner has changed; preserve tests for unrelated delivery behavior.

## State × lifecycle ledger

| Artifact | Create | Delete | Pause/disable | Crash/reload | Duplicate/boundary behavior |
| --- | --- | --- | --- | --- | --- |
| Activity disclosure choice (webview memory) | User opens/closes a group or step | `resetDisclosures` in tests; webview death | `full` does not render groups | Reload uses the new closed default | Stable row/message IDs retain an explicit choice across remount and final sync; no automatic open is persisted |
| Local queued prompt / tell (webview React state; text tells also enter host inbox) | Existing send/queue path | Existing Cancel or delivery | No new path | Webview reload loses the local card; host inbox handling for text tells is unchanged | Local card appears once, then delivered user text appears once; attachment prompts remain webview-only until their turn starts |
| Telegram remote request / mid-turn tell (existing durable state) | Existing remote admission | Existing queue claim/cancel/ack | Existing `/queue` and `/drop` | Existing remote store recovery | Queued text is absent from sidebar; delivered text appears once as a user bubble; preserve disposition-before-ack and cross-batch ordering |

## Verification and handoff

Implementation checks: 39 focused DOM/unit tests passed. A browser rendering
of the actual React components was inspected at 440 px in dark and light
themes, and at 1100 px in dark theme. Screenshots are under
`artifacts/activity-view-mockups/actual-*.png`; `.vscodeignore` excludes them
from the release bundle. The live Telegram transport was not exercised during
this visual change. The first full CI run stopped in unrelated shell/agent-bus
tests on this Windows host (Git Bash `/tmp` warnings, process cleanup `EPERM`,
and a shell guard timeout). Record the final gate outcomes at handoff.

- DOM tests: ordinary and attributed user bubbles, attachments and long remote
  prompts; queued tell and post-turn
  queue labels/Cancel; grouped live/completed/failure/pending states; manual
  disclosures across remount and final sync; narrow long-command layout. Cover
  streamed-argument to recorded-pending transition, live edit totals, and the
  two-level group/call disclosure depth.
- Existing remote tests must still show one Telegram-started prompt and one
  mid-turn tell after delivery, with no local Cancel affordance or duplicate
  after sync. Do not add a new remote queue bridge for this visual change.
- Inspect generated screenshots at narrow sidebar and wide-pane sizes, dark
  and light themes, normal and Clanker composer states. Check that full detail
  remains reachable and no bright green leaks from a hardcoded or theme token.
- Run `npm run ci`, `npm run package`, `git diff --check`, and inspect
  `git status` after the final edit. Report any skipped live Telegram check as
  a live-system limit, not as a passed test.
