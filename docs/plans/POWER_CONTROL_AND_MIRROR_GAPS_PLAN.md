# Power control + four remote/sidebar mirror gaps

Four reported issues, three of which are the same shape: a signal that exists on
one surface and is missing on the other. Written before implementation so the
scope and the honest limits are agreed first.

---

## 1. Sleep and wake

### The part that cannot be built

**Forge cannot serve a `/wake` command.** When the machine is asleep the
extension host is not running, the Telegram long-poll is dead, and nothing on
that box can read a message. Any design where "Telegram tells Forge to wake up"
is circular. This is not a Forge limitation, it is what S3 means.

So `/wake` has to come from *outside* the sleeping machine.

### What this machine can actually do (measured, 2026-09-07)

```
powercfg /a          → Standby (S3) available, Hibernate available
                       S0 low-power idle NOT supported
Get-NetAdapter       → Ethernet, Intel(R) Ethernet Connection (7) I219-V,
                       Up, 1 Gbps, MAC E0-D5-5E-73-F7-88
powercfg /devicequery wake_armed
                     → Intel(R) Ethernet Connection (7) I219-V   ← already armed
                       + the Microsoft wireless keyboard and mouse receivers
```

The I219-V is **already wake-armed**. Wake-on-LAN from S3 should work on this
box today with no BIOS or driver change. The PCIe card the user removed was
doing a job the onboard NIC can already do.

### Recommended wake path (no Forge code needed)

1. **Same LAN / same WiFi** — any WoL app on the phone, magic packet to
   `E0-D5-5E-73-F7-88`, broadcast to the subnet on UDP 9. One tap. This is the
   whole answer when the phone is at home.
2. **Off-network** — something on the LAN that is always on has to relay the
   packet. In rough order of effort:
   - Router with built-in WoL (many ASUS/Merlin, Fritz!Box, OpenWrt, UniFi
     builds have it) — send from the router's own UI/app over VPN or its
     remote-access feature.
   - A VPN back into the LAN (WireGuard on the router), then path 1 unchanged.
   - Any always-on small device on the LAN (Pi, NAS, an old phone) running a WoL
     relay.
   - Port-forward UDP 9 to the subnet broadcast address — works on some routers,
     is refused by many, and is the least advisable of the four because it opens
     a wake to the internet.

Forge's contribution here is **not** sending the packet — it is making the
information one tap away instead of a research project. See `/wake` below.

### What gets built

New owner file `src/system/PowerControl.ts`. Nothing else spawns power commands.

- `suspend({ hibernate })` — P/Invokes `SetSuspendState` from `powrprof.dll`.
  Caveat that must be surfaced, not buried: with hibernation enabled (it is, on
  this box) `SetSuspendState` can hibernate instead of sleeping. The reply says
  which state it believes it entered and does not claim more than it knows.
- `armWakeTimer(when)` — registers a one-shot scheduled task via
  `schtasks /create /xml`, because `WakeToRun` cannot be set from the flag form
  of `schtasks`. Preflighted against `powercfg /q` `ALLOWWAKE`: if wake timers
  are disabled on the active power scheme, it says so and refuses rather than
  arming a timer that will never fire.
- `clearWakeTimer()` — deletes the task.
- `wakeInfo()` — MAC, adapter name, broadcast address, whether the adapter is in
  `powercfg /devicequery wake_armed`, and which sleep states `powercfg /a`
  reports. This is what makes the WoL path above actionable from the phone.

### Surfaces

**Telegram** (new `Machine` section entries, `remoteHelpText.ts`):

- `/sleep` — sleep now. Owner-authenticated only, and it **confirms first** via
  the existing approval-button pattern: an accidental `/sleep` from a phone
  ends the session and every running turn, and the machine is then only
  reachable by WoL. Refuses outright while a turn is running unless `/sleep
  force`.
- `/sleep <duration|HH:MM>` — arm a wake timer, then sleep. `/sleep 8h`,
  `/sleep 07:00`.
- `/wake` — does **not** wake anything (it cannot; see above). It prints
  `wakeInfo()`: the MAC to put in the phone's WoL app, the broadcast address,
  whether the NIC is wake-armed, and any wake timer currently armed. Naming it
  `/wake` is deliberate — that is the word the user will type, and a command
  that explains the real path beats a `command not found` that teaches nothing
  (CLAUDE.md: "refusals must name the sanctioned alternative").
- `/wake <duration|HH:MM>` — arm a wake timer without sleeping.
  `/wake off` clears it.

**Agent tools** (`src/tools/powerTools.ts`, registered in `registerAllTools`):

- `sleep_computer` — permission `dangerous`. Always gated, never clanker-
  auto-approved. Same busy-turn refusal.
- `schedule_wake` — permission `write`. `{ when: string }` or `{ clear: true }`.
- `get_power_info` — permission `read`. Returns `wakeInfo()`, so the agent can
  answer "can this machine be woken remotely" without a shell call.

Refusal strings name the alternative: `sleep_computer` blocked mid-turn says to
finish or cancel the turn first; `schedule_wake` blocked by `ALLOWWAKE` says the
exact `powercfg` line that enables it.

---

## 2. `ask_user` raises the VS Code quick pick instead of a sidebar questionnaire

**Cause.** `UserQuestionService.showLocal()`
(`src/sidebar/UserQuestionService.ts`) is the only local surface, and it builds
a `vscode.window.createQuickPick()` / `createInputBox()`. The sidebar never
learns a question was asked: `SidebarProvider` registers the question sink for
the *remote* bridge only (`addQuestionSink: (sink) => this.questions.addSink(sink)`
is handed to `SidebarHostFacade`, and only `RemoteQuestionBridge` subscribes).
There is no `question` message in `messageBridge.ts` at all. That is why
Telegram renders it properly and the sidebar does not — Telegram is the only
surface that was ever wired.

**Fix.** Give the webview the same seat every other surface already has.

- `messageBridge.ts`: `QuestionRequestMsg { type: 'question'; id; prompt;
  options?; placeholder?; conversationId? }` and `QuestionResolvedMsg
  { type: 'questionResolved'; id }`, mirroring `confirmRequest`/`confirmResolved`
  exactly. Webview→host: `questionResponse { id, text }`.
- `SidebarProvider` subscribes its own sink and posts those.
- New `webview-ui/src/components/QuestionDialog.tsx`, built on the
  `ConfirmationDialog` overlay so it inherits the styling and the modal
  behaviour: prompt text, an option list when `options` is present, a text
  input otherwise, and a Dismiss button.
- `UserQuestionService.showLocal` becomes conditional. When a webview sink is
  attached, **do not** raise the VS Code box — the sidebar owns it. Fall back to
  the quick pick only when no webview is listening (window closed, sidebar view
  never resolved), so a question is never invisible.
- The first-writer-wins `settle()` is unchanged and already covers the race: a
  sidebar answer disposes any fallback box, and a Telegram answer closes the
  sidebar dialog through `questionResolved`.

---

## 3. Some agent progress does not reach Telegram

**What is mirrored today.** `AgentProgressEvent` has four kinds
(`src/sidebar/AgentProgress.ts`) and `RemoteAgentProgress` renders them into one
rate-limited edited message:

| kind | emitted from | reaches Telegram |
|---|---|---|
| `commentary` | `ModelTurn.onToken`, `CliTurn` stdout | yes |
| `tool` | `ModelTurn.dispatchToolCalls`, truncated tool call | yes |
| `status` | CLI drivers only | yes |
| `phase` | `ProviderTurn` cold backend start | yes |

Plus, outside the progress channel: the final answer and turn failures
(`turnMirrorWiring.ts`), `notify_user` (`RemoteNotificationFanout`), questions
(`RemoteQuestionBridge`), approvals (`RemoteApprovalBridge`), and compaction
(`remoteCompactionNotice.ts`).

**The gap.** Two webview-only categories have no progress equivalent, so they
are visible in the sidebar and silent on the phone:

- `{ type: 'notice' }` — 12 emit sites, including every compaction step,
  `imageNotices`, and `ModelTurn.ts:451`.
- `{ type: 'error' }` posted **mid-turn without failing the turn** — the clearest
  case is `onRepeatedCall` ("agent is repeating the same tool call — stopping to
  avoid a loop"), which ends the useful part of the turn and says nothing
  remotely. `onTurnFailed` only covers turns that actually fail.

Reasoning tokens are excluded deliberately and stay excluded — mirroring a
thinking stream to a phone is volume, not signal.

**Fix.** Add one kind rather than a second channel:

- `AgentProgressEvent` gains `{ kind: 'notice'; text: string; severity:
  'info' | 'warning' }`.
- `SidebarProvider.post` is decorated: a `notice` post, and an `error` post on a
  conversation that is still streaming, also emits the matching progress event.
  Decorating the single `post` seam catches all 12 notice sites and all 27 error
  sites without touching any of them — the same technique `wireTurnMirror` uses
  on `onGenerationFinished`, for the same reason.
- `RemoteAgentProgress.handle` renders a `notice` as a milestone line prefixed
  `⚠` for `warning`, plain otherwise. A warning also **latches**: it is appended
  to a small notice list rather than replacing `milestone`, because a warning
  overwritten 1.5 s later by the next tool name was never seen.
- Not gated behind `/mirror`: `/mirror` is about echoing *answers*, and the
  progress message already respects `owns()`.

---

## 4. A prompt sent from Telegram never appears in the sidebar transcript

**Cause.** The user bubble is drawn by the webview from its own `USER_SEND`
action (`webview-ui/src/App.tsx:228`), dispatched when the *webview* sends. A
remote prompt enters through `SidebarHostFacade.send` → `SendPipeline.send`,
which posts `generationStarted` and nothing else — so the webview marks the tab
streaming with no prompt above it. `sessionSync` cannot repair it either:
`reducer.ts` `SESSION_SYNC` deliberately keeps the local transcript for a
conversation in `liveConversationIds` (`local.length > 0 ? local : merge`), which
is exactly the state a remote turn is in from the moment it starts.

**Fix.**

- `SendPipeline.send` metadata gains `echoPrompt?: boolean`.
- `SidebarHostFacade.send` (the sole remote entry point, one caller:
  `RemoteQueueDrain.ts:76`) sets it.
- After admission and before `generationStarted`, the pipeline posts
  `{ type: 'userPrompt', text, conversationId }`.
- `App.tsx` maps it to the existing `USER_SEND` reducer action — no new reducer
  case, so the stale-diff/stale-error stripping a prompt already performs stays
  identical for a remote prompt.
- `submitExternal` sets it too: a prompt from a VS Code command has the same
  hole.

---

## Files touched

| file | change |
|---|---|
| `src/system/PowerControl.ts` | **new** — sole owner of suspend / wake timer / WoL info |
| `src/tools/powerTools.ts` | **new** — `sleep_computer`, `schedule_wake`, `get_power_info` |
| `src/tools/registerAllTools.ts` | register the three |
| `src/remote/RemoteCommandHandler.ts` | `/sleep`, `/wake` |
| `src/remote/remoteHelpText.ts` | Machine section + notes |
| `src/sidebar/UserQuestionService.ts` | webview-first, quick pick as fallback |
| `src/sidebar/messageBridge.ts` | `question`, `questionResolved`, `questionResponse`, `userPrompt` |
| `src/sidebar/SidebarProvider.ts` | question sink → webview; notice/error → progress |
| `src/sidebar/webviewMessageRouter.ts` | `questionResponse` |
| `src/sidebar/AgentProgress.ts` | `notice` kind |
| `src/remote/RemoteAgentProgress.ts` | render + latch notices |
| `src/sidebar/SendPipeline.ts` | `echoPrompt` |
| `src/sidebar/ForgeHostFacade.ts` | `echoPrompt` in the send options type |
| `webview-ui/src/components/QuestionDialog.tsx` | **new** |
| `webview-ui/src/App.tsx` | question dialog state, `userPrompt` → `USER_SEND` |
| `styles/` | question dialog rules beside the confirm dialog's |
| `docs/OWNERS.md` | rows for the two new modules |

## Order

1. §4 (smallest, unblocks testing the others from the phone)
2. §2 (self-contained, highest daily annoyance)
3. §3
4. §1

`npm run ci` between each. Tests: `PowerControl` argv construction and the
`ALLOWWAKE` refusal; `UserQuestionService` fallback-only-when-no-webview;
`RemoteAgentProgress` notice latching; `SendPipeline` echo on remote sends only.

---

## Implemented — 2026-09-07

All four shipped; `npm run ci` green (1982 tests). Three things came out
differently from the plan above:

**The `/sleep` confirmation is a second message, not a button.** `RemoteChannel`
has no button affordance — approvals go through their own bridge — and widening
the channel interface for one command would put a Telegram-shaped feature in
every transport's contract. `/sleep` now replies with what it will do and waits
for `/sleep confirm` within 90 seconds. Same guarantee, no new surface. It also
refuses while a turn, request, or approval is outstanding unless `/sleep force`.

**Three files were split to stay under the 500-line hard stop.** Each split is on
a subject seam, not on line count:

| split | seam |
|---|---|
| `PowerControl.ts` → `wakeInfo.ts` | the class does process I/O; `wakeInfo` is pure parsing and formatting, which is the half worth testing |
| `messageBridge.ts` → `diagnosticMessages.ts` | everything else in the bridge is chat protocol; these are instrumentation about the React context. Re-exported, so the bridge stays the single import |
| `App.tsx` → `useAgentDialogs.ts` | approval and question are one concern with one shared rule: both can be settled elsewhere, so both need a `resolved` message and both must ignore a late resolve naming an older request |

**`SidebarProvider.view` is now cleared on dispose.** It never was, and
`presentsLocally` reads it: a stale reference would claim a dead webview was
showing the question, and `ask_user` would fall through to nothing at all rather
than to the VS Code input box.

### Tests added

- `test/unit/WakeInfo.test.ts` — 19 cases against captured `powercfg` output,
  including the sign-overflow in the broadcast mask and every refused wake-time
  format
- `test/unit/PowerTools.test.ts` — 13 cases; the grace period, the clamp, the
  `dangerous` flag, the no-sleep-states preflight
- `RemoteAgentProgress.test.ts` — warning latching, info non-latching, dedup
- `UserQuestion.test.ts` — the quick pick is not raised when a sink presents
  locally, and is raised when none does
- `SendPipeline.test.ts` — echo on remote sends, not on webview sends, not on
  refused ones

### Still open

The Wake-on-LAN path needs a public, optional Forge Wake Relay on an always-on
LAN device. Forge must carry the user-facing setup guide, configuration contract
(MAC address, broadcast address, owner pairing, dedicated bot token), and
diagnostics. The relay remains separately deployable because an asleep PC cannot
poll Telegram or emit its own magic packet.

Forge owns PC-side `/sleep`, confirmation, scheduled wakes, and Wake-on-LAN
diagnostics; the relay owns `/wake`. A relay must never hold Windows credentials
or expose an unauthenticated Windows control port. Relay-originated sleep needs
an authenticated Forge-side command channel designed first, retaining the same
confirmation policy as Forge's existing `/sleep`.
